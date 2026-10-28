"""
Workflow step executors.

Each executor runs one step and returns:
  - "done"    → advance current_step, continue
  - "waiting" → pause; resume when approve_request re-enqueues the job

Called from worker._handle_request_execute.
"""
from __future__ import annotations

from datetime import datetime
import requests

from sqlalchemy.orm import Session

from . import models, credentials, terraform_runner


# Fallback when a request has no workflow_id
DEFAULT_STEPS = [
    {"type": "tf_plan"},
    {"type": "approval", "approvers": []},
    {"type": "tf_apply"},
]


def get_steps_for(req: models.Request, db: Session) -> list[dict]:
    """Resolve the workflow step list for a request, falling back to defaults."""
    if req.workflow_id:
        wf = db.get(models.WorkflowDefinition, req.workflow_id)
        if wf and wf.steps_json:
            return list(wf.steps_json)
    return list(DEFAULT_STEPS)


def _credential_for_account(db, req, account):
    if account.credential_id:
        cred = db.get(models.Credential, account.credential_id)
        if cred and cred.tenant_id == req.tenant_id:
            return cred
    return db.query(models.Credential).filter_by(
        tenant_id=req.tenant_id, provider=account.provider, env=account.env,
    ).first()


# ============================================================
# Step executors
# ============================================================

def _step_tf_plan(db: Session, req: models.Request, step: dict) -> str:
    account = db.get(models.CloudAccount, req.account_id)
    if not account:
        raise RuntimeError(f"account {req.account_id} not found")
    cred = _credential_for_account(db, req, account)
    if not cred:
        raise RuntimeError(f"no credential for {account.provider}/{account.env}")
    env = credentials.env_for(cred, account.cloud_account_id)

    plan = terraform_runner.run_plan(req.s3_prefix, account.state_key, env)
    req.plan_summary = plan["plan"]
    req.plan_additions = plan["additions"]
    req.plan_changes = plan["changes"]
    req.plan_destructions = plan["destructions"]
    db.commit()
    return "done"


def _step_tf_apply(db: Session, req: models.Request, step: dict) -> str:
    account = db.get(models.CloudAccount, req.account_id)
    if not account:
        raise RuntimeError(f"account {req.account_id} not found")
    cred = _credential_for_account(db, req, account)
    if not cred:
        raise RuntimeError(f"no credential for {account.provider}/{account.env}")
    env = credentials.env_for(cred, account.cloud_account_id)

    terraform_runner.run_apply(req.s3_prefix, account.state_key, env)
    return "done"


def _step_approval(db: Session, req: models.Request, step: dict) -> str:
    # Always returns "waiting". approve_request clears the wait by
    # incrementing current_step and re-enqueuing request_execute.
    return "waiting"


def _step_notify(db: Session, req: models.Request, step: dict) -> str:
    channel = (step.get("channel") or "email").lower()
    message = step.get("message") or f"Request {req.id} reached a notification step."

    if channel == "email":
        to = step.get("to")
        if not to and req.requested_by:
            u = db.get(models.User, req.requested_by)
            to = u.email if u else None
        if not to:
            print(f"[notify] request {req.id}: no email recipient; skipping")
            return "done"
        from .notifications import send_email
        send_email(str(to), f"CloudPilot: request {req.id}", message)

    elif channel == "slack":
        url = step.get("webhook_url")
        if not url:
            print(f"[notify] request {req.id}: slack step missing webhook_url; skipping")
            return "done"
        try:
            requests.post(url, json={"text": message}, timeout=10)
        except Exception as e:
            print(f"[notify] request {req.id}: slack failed: {e}")

    elif channel == "webhook":
        url = step.get("url")
        if not url:
            print(f"[notify] request {req.id}: webhook step missing url; skipping")
            return "done"
        try:
            requests.post(url, json={
                "request_id": req.id,
                "tenant_id": req.tenant_id,
                "message": message,
                "status": req.status,
            }, timeout=10)
        except Exception as e:
            print(f"[notify] request {req.id}: webhook failed: {e}")

    else:
        print(f"[notify] request {req.id}: unknown channel '{channel}'; skipping")

    return "done"


def _step_custom_parameter(db: Session, req: models.Request, step: dict) -> str:
    account = db.get(models.CloudAccount, req.account_id)
    if not account:
        raise RuntimeError(f"account {req.account_id} not found")
    provider = step.get("provider") or account.provider
    name = step.get("name")
    value = step.get("value")
    if not name or value is None:
        print(f"[custom_parameter] request {req.id}: missing name or value; skipping")
        return "done"

    cred = _credential_for_account(db, req, account)
    if not cred:
        raise RuntimeError(f"no credential for {provider}")

    if provider == "aws":
        import boto3
        env = credentials.env_for(cred, account.cloud_account_id)
        ssm = boto3.client(
            "ssm",
            aws_access_key_id=env["AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
            aws_session_token=env.get("AWS_SESSION_TOKEN"),
            region_name=env.get("AWS_DEFAULT_REGION", "us-east-1"),
        )
        ssm.put_parameter(Name=name, Value=value, Type="SecureString", Overwrite=True)

    elif provider == "gcp":
        from google.cloud import secretmanager
        import os
        env = credentials.env_for(cred, account.cloud_account_id)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = env["GOOGLE_APPLICATION_CREDENTIALS"]
        client = secretmanager.SecretManagerServiceClient()
        project = env.get("CLOUDSDK_CORE_PROJECT") or account.cloud_account_id
        parent = f"projects/{project}"
        try:
            client.create_secret(request={
                "parent": parent, "secret_id": name,
                "secret": {"replication": {"automatic": {}}},
            })
        except Exception:
            pass
        client.add_secret_version(request={
            "parent": f"{parent}/secrets/{name}",
            "payload": {"data": value.encode()},
        })

    elif provider == "azure":
        from azure.identity import ClientSecretCredential
        from azure.keyvault.secrets import SecretClient
        env = credentials.env_for(cred, account.cloud_account_id)
        vault_url = step.get("vault_url")
        if not vault_url:
            raise RuntimeError("azure custom_parameter step needs 'vault_url'")
        az_cred = ClientSecretCredential(
            tenant_id=env["ARM_TENANT_ID"],
            client_id=env["ARM_CLIENT_ID"],
            client_secret=env["ARM_CLIENT_SECRET"],
        )
        SecretClient(vault_url=vault_url, credential=az_cred).set_secret(name, value)

    else:
        print(f"[custom_parameter] request {req.id}: provider '{provider}' not supported; skipping")

    return "done"


# ============================================================
# Dispatcher
# ============================================================

_STEP_HANDLERS = {
    "tf_plan": _step_tf_plan,
    "tf_apply": _step_tf_apply,
    "approval": _step_approval,
    "notify": _step_notify,
    "custom_parameter": _step_custom_parameter,
}


def execute_step(db: Session, req: models.Request, step: dict) -> str:
    kind = step.get("type")
    fn = _STEP_HANDLERS.get(kind)
    if not fn:
        raise RuntimeError(f"unknown step type '{kind}'")
    return fn(db, req, step)