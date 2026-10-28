"""
Credential resolution.

Two distinct operations:

  root_env_for(cred)
    - Returns env vars for the ROOT identity (management account / org SA).
    - Used ONLY by the `create_subaccount` job.

  env_for(cred, target)
    - Returns env vars that act INSIDE the target sub-account.
    - target = cloud_accounts.cloud_account_id.

Encryption model

Every secret field in payload_json is Fernet-encrypted at rest by
store_credential (in main.py). `_maybe_decrypt` on read handles three cases:

  1. Value starts with "gAAAAA" (Fernet ciphertext) → decrypt.
  2. Value is plaintext (legacy or saved before encryption) → pass through.
  3. Value is empty/None → pass through.

Secret fields per provider:

  aws:        bootstrap_secret_access_key, secret_access_key
  azure:      client_secret
  ibm:        api_key
  alibaba:    access_key_secret
  databricks: token
  oracle:     private_key_pem (optional; private_key_path is not encrypted)
  gcp:        (nothing — wif_config has no long-lived secret)
"""
import os
import time
import json
import tempfile
import boto3
from . import models
from .crypto import decrypt_token


# =============================================================================
# Encryption helpers
# =============================================================================

def _maybe_decrypt(value: str | None) -> str | None:
    """Decrypt if the value looks like Fernet ciphertext; otherwise pass through.

    Keeps backward compatibility with credentials saved before encryption
    was introduced — plaintext values still work.
    """
    if not value:
        return value
    if value.startswith("gAAAAA"):     # Fernet ciphertext prefix
        return decrypt_token(value)
    return value


# =============================================================================
# AWS caller identity (bootstrap keys)
# =============================================================================

def _bootstrap_aws_keys(p: dict) -> tuple[str | None, str | None]:
    """
    Return the AWS caller identity to use for `sts:AssumeRole`.

    Priority:
      1. payload["bootstrap_access_key_id"] / payload["bootstrap_secret_access_key"]
         (encrypted at rest; decrypted here)
      2. PLATFORM_AWS_ACCESS_KEY_ID / PLATFORM_AWS_SECRET_ACCESS_KEY in env
      3. (None, None) — caller identity missing
    """
    bid = p.get("bootstrap_access_key_id")
    bsec = p.get("bootstrap_secret_access_key")
    if bid and bsec:
        try:
            return bid, _maybe_decrypt(bsec)
        except Exception as e:
            raise RuntimeError(
                f"failed to decrypt bootstrap_secret_access_key: {e}. "
                f"Re-save the credential in Cloud Setup."
            )

    return (
        os.environ.get("PLATFORM_AWS_ACCESS_KEY_ID"),
        os.environ.get("PLATFORM_AWS_SECRET_ACCESS_KEY"),
    )


def _require_aws_caller(p: dict) -> tuple[str, str]:
    bid, bsec = _bootstrap_aws_keys(p)
    if not bid or not bsec:
        raise RuntimeError(
            "no AWS caller identity available. Set bootstrap_access_key_id and "
            "bootstrap_secret_access_key in the credential payload (via Cloud Setup), "
            "or set PLATFORM_AWS_ACCESS_KEY_ID / PLATFORM_AWS_SECRET_ACCESS_KEY in .env, "
            "or run the pod with IRSA."
        )
    return bid, bsec


# =============================================================================
# ROOT credential — used by create_subaccount only
# =============================================================================

def aws_root_env(cred: models.Credential) -> dict:
    p = cred.payload_json
    if p.get("access_key_id") and p.get("secret_access_key"):
        return {
            "AWS_ACCESS_KEY_ID": p["access_key_id"],
            "AWS_SECRET_ACCESS_KEY": _maybe_decrypt(p["secret_access_key"]),
            "AWS_DEFAULT_REGION": p.get("region", "us-east-1"),
        }

    region = p.get("region", "us-east-1")
    caller_id, caller_secret = _require_aws_caller(p)

    sts = boto3.client(
        "sts",
        region_name=region,
        aws_access_key_id=caller_id,
        aws_secret_access_key=caller_secret,
    )
    root = sts.assume_role(
        RoleArn=p["role_arn"],
        RoleSessionName=f"cloudpilot-root-{cred.tenant_id}-{int(time.time())}",
        ExternalId=p.get("external_id") or None,
        DurationSeconds=3600,
    )["Credentials"]
    return {
        "AWS_ACCESS_KEY_ID": root["AccessKeyId"],
        "AWS_SECRET_ACCESS_KEY": root["SecretAccessKey"],
        "AWS_SESSION_TOKEN": root["SessionToken"],
        "AWS_DEFAULT_REGION": region,
    }


def gcp_root_env(cred: models.Credential) -> dict:
    from google.auth import identity_pool
    from google.auth.transport.requests import Request as GReq
    creds = identity_pool.Credentials.from_info(cred.payload_json["wif_config"])
    creds.refresh(GReq())
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False,
                                       prefix=f"gcp-root-{cred.id}-")
    json.dump({"type": "authorized_user", "access_token": creds.token}, tmp)
    tmp.close()
    return {
        "GOOGLE_APPLICATION_CREDENTIALS": tmp.name,
        "CLOUDSDK_CORE_PROJECT": cred.payload_json.get("project_id", ""),
    }


def azure_root_env(cred: models.Credential) -> dict:
    p = cred.payload_json
    from azure.identity import ClientSecretCredential
    c = ClientSecretCredential(
        tenant_id=p["tenant_id"],
        client_id=p["client_id"],
        client_secret=_maybe_decrypt(p["client_secret"]),
    )
    token = c.get_token("https://management.azure.com/.default").token
    return {
        "ARM_TENANT_ID": p["tenant_id"],
        "ARM_CLIENT_ID": p["client_id"],
        "ARM_CLIENT_SECRET": _maybe_decrypt(p["client_secret"]),
        "ARM_ACCESS_TOKEN": token,
    }


def oracle_root_env(cred: models.Credential) -> dict:
    p = cred.payload_json
    return {
        "OCI_USER_OCID": p["user_ocid"],
        "OCI_FINGERPRINT": p["fingerprint"],
        "OCI_TENANCY_OCID": p["tenancy_ocid"],
        "OCI_REGION": p.get("region", "us-ashburn-1"),
        "OCI_PRIVATE_KEY_PATH": p.get("private_key_path", "/tmp/oci_key.pem"),
    }


def alibaba_root_env(cred: models.Credential) -> dict:
    p = cred.payload_json
    return {
        "ALIBABA_CLOUD_ACCESS_KEY_ID": p["access_key_id"],
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET": _maybe_decrypt(p["access_key_secret"]),
        "ALIBABA_CLOUD_REGION": p.get("region", "cn-hangzhou"),
    }


def ibm_root_env(cred: models.Credential) -> dict:
    p = cred.payload_json
    return {
        "IBMCLOUD_API_KEY": _maybe_decrypt(p["api_key"]),
        "IBMCLOUD_ACCOUNT_ID": p["account_id"],
    }


def databricks_root_env(cred: models.Credential) -> dict:
    p = cred.payload_json
    return {
        "DATABRICKS_HOST": p["host"],
        "DATABRICKS_TOKEN": _maybe_decrypt(p["token"]),
    }


_ROOT_DISPATCH = {
    "aws": aws_root_env,
    "gcp": gcp_root_env,
    "azure": azure_root_env,
    "oracle": oracle_root_env,
    "alibaba": alibaba_root_env,
    "ibm": ibm_root_env,
    "databricks": databricks_root_env,
}


def root_env_for(cred: models.Credential) -> dict:
    fn = _ROOT_DISPATCH.get(cred.provider)
    if not fn:
        raise ValueError(f"unknown provider: {cred.provider}")
    return fn(cred)


# =============================================================================
# TARGET credential — used by plan/apply/import/pipeline
# =============================================================================

def aws_env_from_credential(cred: models.Credential, target: str | None = None) -> dict:
    p = cred.payload_json

    # Path 1: static keys pasted directly — no role assumption.
    if p.get("access_key_id") and p.get("secret_access_key"):
        env = {
            "AWS_ACCESS_KEY_ID": p["access_key_id"],
            "AWS_SECRET_ACCESS_KEY": _maybe_decrypt(p["secret_access_key"]),
            "AWS_DEFAULT_REGION": p.get("region", "us-east-1"),
        }
        if p.get("endpoint"):
            env["AWS_ENDPOINT_URL"] = p["endpoint"]
        return env

    region = p.get("region", "us-east-1")
    caller_id, caller_secret = _require_aws_caller(p)

    # Hop 1: caller identity → root role
    root_sts = boto3.client(
        "sts",
        region_name=region,
        aws_access_key_id=caller_id,
        aws_secret_access_key=caller_secret,
    )
    root = root_sts.assume_role(
        RoleArn=p["role_arn"],
        RoleSessionName=f"cloudpilot-root-{cred.tenant_id}-{int(time.time())}",
        ExternalId=p.get("external_id") or None,
        DurationSeconds=3600,
    )["Credentials"]

    if not target:
        return {
            "AWS_ACCESS_KEY_ID": root["AccessKeyId"],
            "AWS_SECRET_ACCESS_KEY": root["SecretAccessKey"],
            "AWS_SESSION_TOKEN": root["SessionToken"],
            "AWS_DEFAULT_REGION": region,
        }

    # Hop 2: root role → sub-account role
    role_name = p.get("member_role_name", "OrganizationAccountAccessRole")
    sub_sts = boto3.client(
        "sts",
        region_name=region,
        aws_access_key_id=root["AccessKeyId"],
        aws_secret_access_key=root["SecretAccessKey"],
        aws_session_token=root["SessionToken"],
    )
    sub = sub_sts.assume_role(
        RoleArn=f"arn:aws:iam::{target}:role/{role_name}",
        RoleSessionName=f"cloudpilot-sub-{cred.tenant_id}-{int(time.time())}",
        DurationSeconds=3600,
    )["Credentials"]
    return {
        "AWS_ACCESS_KEY_ID": sub["AccessKeyId"],
        "AWS_SECRET_ACCESS_KEY": sub["SecretAccessKey"],
        "AWS_SESSION_TOKEN": sub["SessionToken"],
        "AWS_DEFAULT_REGION": region,
    }


def gcp_env_from_credential(cred: models.Credential, target: str | None = None) -> dict:
    from google.auth import identity_pool, impersonated_credentials
    from google.auth.transport.requests import Request as GReq
    p = cred.payload_json
    source = identity_pool.Credentials.from_info(p["wif_config"])
    source.refresh(GReq())

    project = target or p.get("project_id")
    if not project:
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False,
                                           prefix=f"gcp-{cred.id}-")
        json.dump({"type": "authorized_user", "access_token": source.token}, tmp)
        tmp.close()
        return {"GOOGLE_APPLICATION_CREDENTIALS": tmp.name}

    member_sa = p.get("member_sa_template",
                      "cloudpilot@{project}.iam.gserviceaccount.com").format(project=project)
    impersonated = impersonated_credentials.Credentials(
        source_credentials=source,
        target_principal=member_sa,
        target_scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    impersonated.refresh(GReq())
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False,
                                       prefix=f"gcp-{cred.id}-")
    json.dump({"type": "authorized_user", "access_token": impersonated.token}, tmp)
    tmp.close()
    return {
        "GOOGLE_APPLICATION_CREDENTIALS": tmp.name,
        "CLOUDSDK_CORE_PROJECT": project,
        "GOOGLE_PROJECT": project,
    }


def azure_env_from_credential(cred: models.Credential, target: str | None = None) -> dict:
    p = cred.payload_json
    from azure.identity import ClientSecretCredential
    secret = _maybe_decrypt(p["client_secret"])
    c = ClientSecretCredential(
        tenant_id=p["tenant_id"],
        client_id=p["client_id"],
        client_secret=secret,
    )
    token = c.get_token("https://management.azure.com/.default").token
    return {
        "ARM_TENANT_ID": p["tenant_id"],
        "ARM_CLIENT_ID": p["client_id"],
        "ARM_CLIENT_SECRET": secret,
        "ARM_SUBSCRIPTION_ID": target or p.get("subscription_id"),
        "ARM_ACCESS_TOKEN": token,
    }


def oracle_env_from_credential(cred: models.Credential, target: str | None = None) -> dict:
    p = cred.payload_json
    return {
        "OCI_USER_OCID": p["user_ocid"],
        "OCI_FINGERPRINT": p["fingerprint"],
        "OCI_TENANCY_OCID": target or p["tenancy_ocid"],
        "OCI_REGION": p.get("region", "us-ashburn-1"),
        "OCI_PRIVATE_KEY_PATH": p.get("private_key_path", "/tmp/oci_key.pem"),
    }


def alibaba_env_from_credential(cred: models.Credential, target: str | None = None) -> dict:
    p = cred.payload_json
    secret = _maybe_decrypt(p["access_key_secret"])

    if not target:
        return {
            "ALIBABA_CLOUD_ACCESS_KEY_ID": p["access_key_id"],
            "ALIBABA_CLOUD_ACCESS_KEY_SECRET": secret,
            "ALIBABA_CLOUD_REGION": p.get("region", "cn-hangzhou"),
        }

    from alibabacloud_sts20150401.client import Client as StsClient
    from alibabacloud_sts20150401 import models as sts_models
    from alibabacloud_tea_openapi import models as open_api_models
    sts = StsClient(open_api_models.Config(
        access_key_id=p["access_key_id"],
        access_key_secret=secret,
        endpoint="sts.aliyuncs.com",
    ))
    role_name = p.get("member_role_name", "CloudPilotRole")
    resp = sts.assume_role(sts_models.AssumeRoleRequest(
        role_arn=f"acs:ram::{target}:role/{role_name}",
        role_session_name=f"cloudpilot-{cred.tenant_id}",
        duration_seconds=3600,
    ))
    return {
        "ALIBABA_CLOUD_ACCESS_KEY_ID": resp.body.credentials.access_key_id,
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET": resp.body.credentials.access_key_secret,
        "ALIBABA_CLOUD_SECURITY_TOKEN": resp.body.credentials.security_token,
        "ALIBABA_CLOUD_REGION": p.get("region", "cn-hangzhou"),
    }


def ibm_env_from_credential(cred: models.Credential, target: str | None = None) -> dict:
    p = cred.payload_json
    return {
        "IBMCLOUD_API_KEY": _maybe_decrypt(p["api_key"]),
        "IBMCLOUD_ACCOUNT_ID": target or p["account_id"],
    }


def databricks_env_from_credential(cred: models.Credential, target: str | None = None) -> dict:
    p = cred.payload_json
    return {
        "DATABRICKS_HOST": p["host"],
        "DATABRICKS_TOKEN": _maybe_decrypt(p["token"]),
    }


_TARGET_DISPATCH = {
    "aws": aws_env_from_credential,
    "gcp": gcp_env_from_credential,
    "azure": azure_env_from_credential,
    "oracle": oracle_env_from_credential,
    "alibaba": alibaba_env_from_credential,
    "ibm": ibm_env_from_credential,
    "databricks": databricks_env_from_credential,
}


def env_for(cred: models.Credential, target: str | None = None) -> dict:
    """Env vars that act inside `target` sub-account. If target is None, acts as root."""
    fn = _TARGET_DISPATCH.get(cred.provider)
    if not fn:
        raise ValueError(f"unknown provider: {cred.provider}")
    return fn(cred, target)


def verify_credential(cred: models.Credential) -> tuple[bool, str]:
    """Verify the ROOT credential can be assumed. Target-specific test is separate."""
    try:
        root_env_for(cred)
        return True, ""
    except Exception as e:
        return False, str(e)