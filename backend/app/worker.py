import os
import json as _json
import subprocess
import tempfile
import time
from datetime import datetime
from pathlib import Path

from .db import SessionLocal
from .queue import claim_one, mark_done, mark_failed, WORKER_ID
from . import models, nlp, terraform_runner, credentials, workflows
from .pipelines import run_pipeline


def _credential_for_account(db, req, account):
    if account.credential_id:
        cred = db.get(models.Credential, account.credential_id)
        if cred and cred.tenant_id == req.tenant_id:
            return cred
    return db.query(models.Credential).filter_by(
        tenant_id=req.tenant_id, provider=account.provider, env=account.env,
    ).first()


def _sync_inventory(db, account, env):
    try:
        resources = terraform_runner.read_state_resources(account.state_key, env)
    except Exception:
        return
    for r in resources:
        existing = db.query(models.InventoryResource).filter_by(
            tenant_id=account.tenant_id, account_id=account.id,
            resource_type=r["type"], resource_id=r["name"]).first()
        if existing:
            existing.meta_json = r.get("values", {})
            existing.last_seen_at = datetime.utcnow()
        else:
            db.add(models.InventoryResource(
                tenant_id=account.tenant_id, account_id=account.id,
                resource_type=r["type"], resource_id=r["name"],
                meta_json=r.get("values", {})))
    db.commit()


def _record_cloud_native_ids(db, account, s3_prefix: str):
    from .storage import storage
    try:
        manifest = _json.loads(storage.get(f"{s3_prefix}/manifest.json"))
    except Exception as e:
        print(f"[{WORKER_ID}] could not read manifest: {e}")
        return
    arns = [r["id"] for r in manifest.get("resources", [])]
    if not arns:
        return
    rows = (
        db.query(models.InventoryResource)
          .filter_by(tenant_id=account.tenant_id, account_id=account.id)
          .order_by(models.InventoryResource.id.desc())
          .limit(len(arns))
          .all()
    )
    for row, arn in zip(reversed(rows), arns):
        row.cloud_native_id = arn
    db.commit()


# ============================================================
# WORKFLOW EXECUTOR — the one that actually respects steps_json
# ============================================================
def _handle_request_execute(db, req_id: int):
    from .notifications import notify_request_completed, notify_approval_requested
    from . import workflows as wf_mod

    req = db.get(models.Request, req_id)
    if not req:
        return

    steps = wf_mod.get_steps_for(req, db)
    if not steps:
        req.status = "failed"
        req.completed_at = datetime.utcnow()
        db.commit()
        notify_request_completed(db, req, "failed")
        return

    if req.total_steps == 0:
        req.total_steps = len(steps)
        db.commit()

    while req.current_step < len(steps):
        step = steps[req.current_step]
        kind = step.get("type")

        if kind == "tf_plan":
            req.status = "planning"
        elif kind == "tf_apply":
            req.status = "applying"
        elif kind == "approval":
            req.status = "awaiting_approval"
            db.commit()
            notify_approval_requested(db, req, step)
            print(f"[{WORKER_ID}] request {req.id} awaiting approval at step {req.current_step}")
            return
        else:
            req.status = f"running_{kind}"
        db.commit()

        try:
            outcome = wf_mod.execute_step(db, req, step)
        except Exception as e:
            req.status = "failed"
            req.plan_summary = (req.plan_summary or "") + f"\n\nStep {req.current_step} ({kind}) failed: {e}"
            req.completed_at = datetime.utcnow()
            db.commit()
            notify_request_completed(db, req, "failed")
            print(f"[{WORKER_ID}] request {req.id} failed at step {req.current_step}: {e}")
            return

        if outcome == "waiting":
            return

        req.current_step += 1
        db.commit()

    req.status = "completed"
    req.completed_at = datetime.utcnow()
    db.commit()

    account = db.get(models.CloudAccount, req.account_id)
    if account:
        cred = _credential_for_account(db, req, account)
        if cred:
            try:
                env = credentials.env_for(cred, account.cloud_account_id)
                _sync_inventory(db, account, env)
            except Exception as e:
                print(f"[{WORKER_ID}] inventory sync failed: {e}")

    notify_request_completed(db, req, "applied")
    print(f"[{WORKER_ID}] request {req.id} completed {req.total_steps} steps")

    # All steps complete
    req.status = "completed"
    req.completed_at = datetime.utcnow()
    db.commit()

    account = db.get(models.CloudAccount, req.account_id)
    if account:
        cred = _credential_for_account(db, req, account)
        if cred:
            try:
                env = credentials.env_for(cred, account.cloud_account_id)
                _sync_inventory(db, account, env)
            except Exception as e:
                print(f"[{WORKER_ID}] inventory sync after request {req.id} failed: {e}")

    notify_request_completed(db, req, "applied")
    print(f"[{WORKER_ID}] request {req.id} completed all {req.total_steps} steps")


# ============================================================
# Legacy single-step handlers — kept for backwards compat with
# in-flight jobs. New requests should use request_execute.
# ============================================================

def _handle_request_plan(db, req_id: int):
    req = db.get(models.Request, req_id)
    if not req:
        return
    account = db.get(models.CloudAccount, req.account_id)
    if not account:
        req.status = "failed"; req.plan_summary = "Account not found"; db.commit(); return

    try:
        spec = nlp.nlp_to_terraform(req.tenant_id, req.id, req.nlp_text)
    except Exception as e:
        req.status = "failed"; req.plan_summary = f"NLP failed: {e}"; db.commit(); return
    req.s3_prefix = spec["s3_prefix"]; db.commit()

    cred = _credential_for_account(db, req, account)
    if not cred:
        req.status = "failed"; req.plan_summary = "No credentials"; db.commit(); return

    try:
        env = credentials.env_for(cred, account.cloud_account_id)
        plan = terraform_runner.run_plan(req.s3_prefix, account.state_key, env)
    except Exception as e:
        req.status = "failed"; req.plan_summary = f"Plan failed: {e}"; db.commit(); return

    req.status = "planned"
    req.plan_summary = plan["plan"]
    req.plan_additions = plan["additions"]
    req.plan_changes = plan["changes"]
    req.plan_destructions = plan["destructions"]
    db.commit()


def _handle_request_apply(db, req_id: int):
    from .notifications import notify_request_completed
    req = db.get(models.Request, req_id)
    if not req:
        return
    account = db.get(models.CloudAccount, req.account_id)
    if not account:
        req.status = "failed"; req.plan_summary = "Account not found"
        req.completed_at = datetime.utcnow(); db.commit()
        notify_request_completed(db, req, req.status); return

    cred = _credential_for_account(db, req, account)
    if not cred:
        req.status = "failed"; req.plan_summary = "No credentials"
        req.completed_at = datetime.utcnow(); db.commit()
        notify_request_completed(db, req, req.status); return

    try:
        env = credentials.env_for(cred, account.cloud_account_id)
        terraform_runner.run_apply(req.s3_prefix, account.state_key, env)
    except Exception as e:
        req.status = "failed"
        req.plan_summary = (req.plan_summary or "") + f"\n\nApply failed: {e}"
        req.completed_at = datetime.utcnow(); db.commit()
        notify_request_completed(db, req, req.status); return

    req.status = "applied"
    req.completed_at = datetime.utcnow()
    db.commit()
    _sync_inventory(db, account, env)
    notify_request_completed(db, req, req.status)


def _handle_request_import_apply(db, req_id: int):
    from .notifications import notify_request_completed
    from .storage import storage

    req = db.get(models.Request, req_id)
    if not req:
        return
    account = db.get(models.CloudAccount, req.account_id)
    if not account:
        req.status = "failed"; req.plan_summary = "Account not found"
        req.completed_at = datetime.utcnow(); db.commit()
        notify_request_completed(db, req, req.status); return

    cred = _credential_for_account(db, req, account)
    if not cred:
        req.status = "failed"; req.plan_summary = "No credentials"
        req.completed_at = datetime.utcnow(); db.commit()
        notify_request_completed(db, req, req.status); return

    try:
        env = credentials.env_for(cred, account.cloud_account_id)
    except Exception as e:
        req.status = "failed"; req.plan_summary = f"Credential error: {e}"
        req.completed_at = datetime.utcnow(); db.commit()
        notify_request_completed(db, req, req.status); return

    with tempfile.TemporaryDirectory() as tmp:
        wd = Path(tmp)
        try:
            raw = storage.get(f"{req.s3_prefix}/generated.tf")
            (wd / "main.tf").write_bytes(raw)
        except Exception as e:
            req.status = "failed"; req.plan_summary = f"Failed to download HCL: {e}"
            req.completed_at = datetime.utcnow(); db.commit()
            notify_request_completed(db, req, req.status); return

        (wd / "backend.tf").write_text(f'''
terraform {{
  backend "s3" {{
    bucket         = "{os.environ["STORAGE_BUCKET"]}"
    key            = "{account.state_key}"
    region         = "{os.environ.get("STORAGE_REGION", "us-east-1")}"
    endpoints      = {{ s3 = "{os.environ.get("STORAGE_ENDPOINT", "")}" }}
    access_key     = "{os.environ.get("STORAGE_ACCESS_KEY", "")}"
    secret_key     = "{os.environ.get("STORAGE_SECRET_KEY", "")}"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
  }}
}}
''')

        e = {**os.environ, **env}
        def _run(args):
            p = subprocess.run(["terraform", *args], cwd=wd, env=e, capture_output=True, text=True)
            if p.returncode != 0:
                raise RuntimeError(f"terraform {' '.join(args)} failed:\n{p.stdout}\n{p.stderr}")
            return p.stdout

        try:
            _run(["init", "-input=false", "-no-color"])
            _run(["apply", "-input=false", "-no-color", "-auto-approve"])
            req.status = "imported"
            req.completed_at = datetime.utcnow()
            db.commit()
            _sync_inventory(db, account, env)
            _record_cloud_native_ids(db, account, req.s3_prefix)
            notify_request_completed(db, req, req.status)
        except Exception as e:
            req.status = "failed"
            req.plan_summary = (req.plan_summary or "") + f"\n\nImport apply failed: {e}"
            req.completed_at = datetime.utcnow(); db.commit()
            notify_request_completed(db, req, req.status)


def _handle_pipeline_deploy(db, run_id: int):
    try:
        run_pipeline(run_id)
    except Exception as e:
        run = db.get(models.PipelineRun, run_id)
        if run:
            run.status = "fail"
            run.steps_json = {"error": str(e)}
            db.commit()
        print(f"[{WORKER_ID}] pipeline {run_id} FAILED: {e}")


def handle_job(db, job_id: int, job_type: str, ref_id: int):
    print(f"[{WORKER_ID}] handling {job_type} → ref {ref_id}")
    if job_type == "request_execute":
        _handle_request_execute(db, ref_id)
    elif job_type == "request_plan":
        _handle_request_plan(db, ref_id)
    elif job_type == "request_apply":
        _handle_request_apply(db, ref_id)
    elif job_type == "request_import_apply":
        _handle_request_import_apply(db, ref_id)
    elif job_type == "pipeline_deploy":
        _handle_pipeline_deploy(db, ref_id)
    else:
        raise ValueError(f"unknown job_type: {job_type}")


def worker_loop():
    from .db import Base, engine
    Base.metadata.create_all(bind=engine)

    print(f"[{WORKER_ID}] worker started, polling for jobs")
    while True:
        db = SessionLocal()
        try:
            job = claim_one(db)
            if job is None:
                time.sleep(2)
                continue
            job_id, job_type, ref_id = job
            print(f"[{WORKER_ID}] claimed {job_type} job {job_id} ref {ref_id}")
            try:
                handle_job(db, job_id, job_type, ref_id)
                mark_done(db, job_id)
            except Exception as e:
                print(f"[{WORKER_ID}] job {job_id} crashed: {e}")
                mark_failed(db, job_id, str(e))
        finally:
            db.close()


if __name__ == "__main__":
    worker_loop()