"""
Create a sub-account in the given provider using the root credential.

Each function returns the provider-native identifier of the new sub-account:
  aws     → 12-digit account number (created via Organizations, status=IN_PROGRESS)
  gcp     → project id
  azure   → subscription id (GUID)
  oracle  → tenancy OCID (requires manual step — OCI does not allow API tenancy creation)
  alibaba → UID (via BSS OpenAPI CreateAgAccount)
  ibm     → account id (requires IBM enterprise API access)

AWS and GCP are automated. Azure automation requires the Subscription Alias API
and a billing scope. OCI and IBM do not allow programmatic tenancy/account
creation for most customers; those raise a clear error so the UI can direct the
user to a manual step.
"""
import os
import boto3


# =============================================================================
# AWS — Organizations CreateAccount
# =============================================================================

def create_aws_subaccount(root_env: dict, name: str, email: str) -> str:
    """
    Creates a new member account in the organization. Returns the 12-digit id.
    Note: AWS returns the account id immediately but the account stays in
    CREATING state for ~1 minute. Terraform against the new account will fail
    until it's ACTIVE. Retry the `create_subaccount` status check (or wait
    manually) before provisioning.
    """
    org = boto3.client(
        "organizations",
        aws_access_key_id=root_env["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=root_env["AWS_SECRET_ACCESS_KEY"],
        aws_session_token=root_env.get("AWS_SESSION_TOKEN"),
    )
    resp = org.create_account(
        Email=email,
        AccountName=name,
        RoleName="OrganizationAccountAccessRole",
    )
    create_status = resp["CreateAccountStatus"]
    account_id = create_status.get("AccountId")
    if not account_id:
        raise RuntimeError(
            f"AWS account creation in progress (request id {create_status['Id']}); "
            f"poll organizations.describe_create_account_status until state=SUCCEEDED"
        )
    return account_id


# =============================================================================
# GCP — Projects Create
# =============================================================================

def create_gcp_subaccount(root_env: dict, name: str, parent: str) -> str:
    """
    Creates a GCP project under `parent` (folder/org like 'folders/123' or
    'organizations/456'). Returns the project id.

    Requires the root service account to have roles/resourcemanager.projectCreator
    on the parent, and the Cloud Resource Manager API enabled.
    """
    from google.auth import default as google_auth_default
    from google.auth.transport.requests import Request as GReq
    import googleapiclient.discovery

    creds, _ = google_auth_default()
    if not creds.valid:
        creds.refresh(GReq())
    service = googleapiclient.discovery.build(
        "cloudresourcemanager", "v3", credentials=creds, cache_discovery=False
    )
    # project_id must be globally unique, lowercase, 6–30 chars.
    import uuid
    project_id = f"{name.lower()}-{uuid.uuid4().hex[:6]}"
    op = service.projects().create(
        body={
            "projectId": project_id,
            "name": name,
            "parent": parent,
        }
    ).execute()
    # Operation is async. Return the project id; the API consumer (worker) can
    # poll the operation name if it wants strict completion.
    return project_id


# =============================================================================
# Azure — Subscription Alias (requires EA/MCA billing scope)
# =============================================================================

def create_azure_subaccount(root_env: dict, name: str, billing_scope: str) -> str:
    """
    Creates a new subscription under an EA / MCA billing scope.
    `billing_scope` is like '/providers/Microsoft.Billing/billingAccounts/12345:6789/enrollmentAccounts/12345'.
    Returns the subscription GUID.

    Requires the SP to have 'SubscriptionCreator' role on the billing scope,
    plus 'Microsoft.Subscription/aliases/write' at the tenant level.
    """
    import uuid
    import requests

    alias = str(uuid.uuid4())
    url = f"https://management.azure.com/providers/Microsoft.Subscription/aliases/{alias}?api-version=2021-10-01"
    body = {
        "properties": {
            "displayName": name,
            "billingScope": billing_scope,
            "workload": "Production",
        }
    }
    headers = {
        "Authorization": f"Bearer {root_env['ARM_ACCESS_TOKEN']}",
        "Content-Type": "application/json",
    }
    r = requests.put(url, json=body, headers=headers)
    if r.status_code not in (200, 201, 202):
        raise RuntimeError(f"Azure subscription create failed: {r.status_code} {r.text}")
    return r.json()["properties"]["subscriptionId"]


# =============================================================================
# OCI, IBM, Alibaba — manual or provider-limited
# =============================================================================

def create_oracle_subaccount(root_env: dict, name: str, **kwargs) -> str:
    """
    OCI does not allow programmatic tenancy creation via public API for
    most customers. Raise so the UI can show a manual-onboarding flow.
    """
    raise RuntimeError(
        "OCI tenancy creation is not supported programmatically. "
        "Ask the customer to create the tenancy in the OCI console, then "
        "attach the new tenancy OCID as a CloudAccount with cloud_account_id."
    )


def create_ibm_subaccount(root_env: dict, name: str, **kwargs) -> str:
    """
    IBM enterprise accounts have a create-account API but it is gated behind
    enterprise-level IAM permissions that are unusual for a root API key.
    Raise so the UI can direct the user to the IBM Cloud console.
    """
    raise RuntimeError(
        "IBM account creation requires enterprise-scoped IAM permissions "
        "not typically available to a root API key. Create the account in "
        "the IBM Cloud console and attach it here."
    )


def create_alibaba_subaccount(root_env: dict, name: str, **kwargs) -> str:
    """
    Alibaba BSS OpenAPI CreateAgAccount creates a linked account. Requires
    the root RAM user to have 'bss:CreateAgAccount' permission.
    """
    from alibabacloud_bssopenapi20171214.client import Client as BssClient
    from alibabacloud_bssopenapi20171214 import models as bss_models
    from alibabacloud_tea_openapi import models as open_api_models

    client = BssClient(open_api_models.Config(
        access_key_id=root_env["ALIBABA_CLOUD_ACCESS_KEY_ID"],
        access_key_secret=root_env["ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
        endpoint="business.aliyuncs.com",
    ))
    resp = client.create_ag_account(bss_models.CreateAgAccountRequest(
        account_type="ENTERPRISE",
        display_name=name,
    ))
    if not getattr(resp.body, "account_id", None):
        raise RuntimeError(f"Alibaba account creation failed: {resp}")
    return resp.body.account_id


DISPATCH = {
    "aws": create_aws_subaccount,
    "gcp": create_gcp_subaccount,
    "azure": create_azure_subaccount,
    "oracle": create_oracle_subaccount,
    "ibm": create_ibm_subaccount,
    "alibaba": create_alibaba_subaccount,
}


def create_subaccount(provider: str, root_env: dict, name: str, **kwargs) -> str:
    """Dispatch and return the new sub-account's native id."""
    fn = DISPATCH.get(provider)
    if not fn:
        raise ValueError(f"sub-account creation not implemented for '{provider}'")
    return fn(root_env, name, **kwargs)