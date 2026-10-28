import os, subprocess, tempfile, json
from pathlib import Path
from .storage import storage


def _download(prefix: str, wd: Path):
    for key in storage.list_prefix(prefix):
        name = key.split("/")[-1]
        (wd / name).write_bytes(storage.get(key))


def _backend(wd: Path, state_key: str):
    """
    Terraform's S3 backend is used for state, regardless of which cloud the
    customer's resources live in. The backend config points at the platform's
    storage bucket (MinIO/S3), not at the customer's account.
    """
    # GCS and Azure backends are configured differently. For this scaffold,
    # we always use S3-compatible state (MinIO locally, real S3 in prod).
    (wd / "backend.tf").write_text(f'''
terraform {{
  backend "s3" {{
    bucket         = "{os.environ["STORAGE_BUCKET"]}"
    key            = "{state_key}"
    region         = "{os.environ.get("STORAGE_REGION", "us-east-1")}"
    endpoints      = {{ s3 = "{os.environ.get("STORAGE_ENDPOINT", "")}" }}
    access_key     = "{os.environ["STORAGE_ACCESS_KEY"]}"
    secret_key     = "{os.environ["STORAGE_SECRET_KEY"]}"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
  }}
}}
''')


def _tf(wd: Path, args, env):
    p = subprocess.run(["terraform", *args], cwd=wd, env=env,
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"terraform {' '.join(args)} failed:\n{p.stdout}\n{p.stderr}")
    return p.stdout


def run_plan(s3_prefix: str, state_key: str, env: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        wd = Path(tmp)
        _download(s3_prefix, wd)
        _backend(wd, state_key)
        e = {**os.environ, **env}
        _tf(wd, ["init", "-input=false", "-no-color"], e)
        _tf(wd, ["plan", "-input=false", "-no-color", "-out=tfplan"], e)
        text = _tf(wd, ["show", "-no-color", "tfplan"], e)
        return {"plan": text[-8000:],
                "additions": text.count("will be created"),
                "changes": text.count("will be updated in-place"),
                "destructions": text.count("will be destroyed")}


def run_apply(s3_prefix: str, state_key: str, env: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        wd = Path(tmp)
        _download(s3_prefix, wd)
        _backend(wd, state_key)
        e = {**os.environ, **env}
        _tf(wd, ["init", "-input=false", "-no-color"], e)
        _tf(wd, ["plan", "-input=false", "-no-color", "-out=tfplan"], e)
        _tf(wd, ["apply", "-input=false", "-no-color", "-auto-approve", "tfplan"], e)
        return {"status": "applied"}


def read_state_resources(state_key: str, env: dict) -> list:
    try:
        raw = storage.get(state_key)
    except Exception:
        return []
    state = json.loads(raw)
    out = []
    for res in state.get("resources", []):
        if res.get("mode") != "managed":
            continue
        for inst in res.get("instances", []):
            out.append({"type": res.get("type", ""), "name": res.get("name", ""),
                        "values": inst.get("attributes", {})})
    return out