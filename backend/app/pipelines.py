import os
import subprocess
import tempfile
from datetime import datetime

from .db import SessionLocal
from . import models, credentials
from .crypto import decrypt_token
from . import ecr


def _sh(args, cwd=None, env=None):
    """Run a subprocess, raising with stdout+stderr on non-zero exit."""
    p = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed:\n{p.stdout}\n{p.stderr}")
    return p.stdout


def _clone_url(repo_url: str, token: str | None) -> str:
    """
    Inject a PAT into an HTTPS git URL for authenticated cloning.
    """
    if not token:
        return repo_url
    if repo_url.startswith("https://"):
        return repo_url.replace("https://", f"https://{token}@", 1)
    return repo_url


def _redact(text: str, token: str | None) -> str:
    """Strip the token from any string we're about to log or raise."""
    if not token:
        return text
    return text.replace(token, "***")


def _kubeconfig_for(cluster: models.CloudAccount, cred_env: dict):
    """
    Point kubectl at the target cluster using the provider's own CLI.

    The worker talks to a sub-account, so for AWS the CLI needs
    --role-arn to assume the sub-account's role before calling EKS.
    The sub-account id is cluster.cloud_account_id (12-digit number).
    """
    provider = cluster.provider
    name = cluster.account_ref
    meta = cluster.meta_json or {}

    kube_dir = os.path.join(os.environ.get("HOME", "/tmp"), ".kube")
    os.makedirs(kube_dir, exist_ok=True)
    os.environ["KUBECONFIG"] = os.path.join(kube_dir, "config")

    if provider == "aws":
        region = cred_env.get("AWS_DEFAULT_REGION", "us-east-1")
        args = ["aws", "eks", "update-kubeconfig", "--name", name, "--region", region]
        # Cross-account hop: point at the sub-account's role
        target = cluster.cloud_account_id
        if target:
            role_name = os.environ.get("AWS_MEMBER_ROLE_NAME",
                                       "OrganizationAccountAccessRole")
            args += ["--role-arn", f"arn:aws:iam::{target}:role/{role_name}"]
        _sh(args, env={**os.environ, **cred_env})

    elif provider == "gcp":
        project = cred_env.get("CLOUDSDK_CORE_PROJECT", "")
        region = meta.get("region", "us-central1")
        _sh([
            "gcloud", "container", "clusters", "get-credentials",
            name,
            f"--region={region}",
            f"--project={project}",
        ], env={**os.environ, **cred_env})

    elif provider == "azure":
        resource_group = meta.get("resource_group")
        if not resource_group:
            raise RuntimeError(
                f"Azure cluster {name} has no resource_group in meta_json. "
                "Set it when creating the account or in Inventory."
            )
        _sh([
            "az", "aks", "get-credentials",
            "--name", name,
            "--resource-group", resource_group,
            "--subscription", cred_env.get("ARM_SUBSCRIPTION_ID", ""),
            "--overwrite-existing",
        ], env={**os.environ, **cred_env})

    elif provider == "oracle":
        cluster_ocid = meta.get("cluster_id", name)
        kubeconfig_path = os.path.join(kube_dir, "config")
        _sh([
            "oci", "ce", "cluster", "create-kubeconfig",
            "--cluster-id", cluster_ocid,
            "--file", kubeconfig_path,
            "--token-version", "2.2.0",
        ], env={**os.environ, **cred_env})

    elif provider == "ibm":
        _sh([
            "ibmcloud", "ks", "cluster", "config", name,
        ], env={**os.environ, **cred_env})

    elif provider == "alibaba":
        cluster_id = meta.get("cluster_id", name)
        _sh([
            "aliyun", "cs", "GET", f"/k8s/{cluster_id}/user_config",
            "--header", "Content-Type=application/json",
            "--force",
        ], env={**os.environ, **cred_env})

    else:
        raise RuntimeError(f"Pipeline deploy not supported for provider '{provider}'")


def run_pipeline(run_id: int):
    """
    Execute a pipeline_run:
      1. git clone (token-aware for private repos)
      2. build app artifact (maven / npm / pip) if applicable
      3. build & push container image via docker (requires Docker daemon)
      4. ECR lifecycle cleanup
      5. prune local docker images
      6. configure kubectl for the target cluster (cross-account aware)
      7. helm upgrade --install

    The repo token is read from Application.repo_token on every call —
    including retries — so token rotation between attempts is picked up
    automatically. No job-row state carries the token.

    Credentials come from credentials.env_for(cred, cluster.cloud_account_id),
    which for AWS performs a two-hop STS AssumeRole: platform → root → sub-account.
    """
    db = SessionLocal()
    try:
        run = db.get(models.PipelineRun, run_id)
        if not run:
            return
        app = db.get(models.Application, run.application_id)
        if not app:
            run.status = "fail"
            run.steps_json = {"error": f"application {run.application_id} not found"}
            run.finished_at = datetime.utcnow()
            db.commit()
            return

        cluster = db.get(models.CloudAccount, app.cluster_id)
        if not cluster:
            run.status = "fail"
            run.steps_json = {"error": f"cluster {app.cluster_id} not found"}
            run.finished_at = datetime.utcnow()
            db.commit()
            return

        cred = db.query(models.Credential).filter_by(
            tenant_id=app.tenant_id, provider=cluster.provider, env=app.env
        ).first()
        if not cred:
            run.status = "fail"
            run.steps_json = {"error": f"no credential for {cluster.provider}/{app.env}"}
            run.finished_at = datetime.utcnow()
            db.commit()
            return

        # Target credential — for AWS this performs root → sub-account hop
        try:
            cred_env = credentials.env_for(cred, cluster.cloud_account_id)
        except Exception as e:
            run.status = "fail"
            run.steps_json = {"error": f"credential error: {e}"}
            run.finished_at = datetime.utcnow()
            db.commit()
            return

        # ---- Resolve repo token (used only for the clone step) ----
        token: str | None = None
        if app.repo_token:
            try:
                token = decrypt_token(app.repo_token)
            except Exception as e:
                run.status = "fail"
                run.steps_json = {"error": f"repo token decryption failed: {e}"}
                run.finished_at = datetime.utcnow()
                db.commit()
                return
        clone_url = _clone_url(app.repo_url, token)

        steps = []

        def step(name, fn):
            started = datetime.utcnow()
            try:
                fn()
                steps.append({
                    "name": name,
                    "status": "ok",
                    "duration": str(datetime.utcnow() - started),
                })
            except Exception as e:
                steps.append({
                    "name": name,
                    "status": "fail",
                    "duration": str(datetime.utcnow() - started),
                    "error": str(e),
                })
                raise

        try:
            with tempfile.TemporaryDirectory() as tmp:
                # 1. Clone — redact token from any error message
                def checkout():
                    try:
                        _sh([
                            "git", "clone", "--depth", "1", "-b", app.branch,
                            clone_url, tmp + "/src",
                        ])
                    except RuntimeError as e:
                        raise RuntimeError(_redact(str(e), token)) from None
                step("Checkout", checkout)
                src = tmp + "/src"

                # 2. Build (per language) — only if the repo declares one.
                if os.path.exists(os.path.join(src, "pom.xml")):
                    step("Build JAR", lambda: _sh(
                        ["mvn", "-q", "-DskipTests", "package"], cwd=src
                    ))
                elif os.path.exists(os.path.join(src, "package.json")):
                    step("Build assets", lambda: _sh(
                        ["npm", "ci", "--silent"], cwd=src
                    ))
                elif os.path.exists(os.path.join(src, "requirements.txt")):
                    step("Install deps", lambda: _sh(
                        ["pip", "install", "-r", "requirements.txt"], cwd=src
                    ))

                # 3. Build & push container image via docker.
                registry = os.environ.get("REGISTRY_PREFIX", "").rstrip("/")
                if not registry:
                    raise RuntimeError(
                        "REGISTRY_PREFIX is not set; cannot determine where to "
                        "push the built image. Example: "
                        "REGISTRY_PREFIX=123456789.dkr.ecr.us-east-1.amazonaws.com"
                    )
                image_repo = f"{registry}/{app.release_name}"
                image_tag = f"{image_repo}:{run.commit_sha[:7]}"

                step("Build image", lambda: _sh(
                    ["docker", "build", "-t", image_tag, "."],
                    cwd=src,
                    env={**os.environ, **cred_env},
                ))
                step("Push image", lambda: _sh(
                    ["docker", "push", image_tag],
                    cwd=src,
                    env={**os.environ, **cred_env},
                ))

                # 4. ECR lifecycle cleanup (idempotent; skip for PROD)
                def cleanup_ecr():
                    if app.env == "PROD":
                        return
                    res = ecr.ensure_ecr_lifecycle_policy(registry, keep_days=14)
                    if res.get("skipped"):
                        return
                    if not res.get("ok"):
                        raise RuntimeError(f"ECR lifecycle policy: {res.get('error')}")
                step("ECR cleanup policy", cleanup_ecr)

                # 5. Prune local docker images older than 1h
                step("Prune local images", lambda: _sh(
                    ["docker", "image", "prune", "-f", "--filter", "until=1h"],
                    env={**os.environ, **cred_env},
                ))

                # 6. Kubeconfig — provider-specific, cross-account aware
                step("kubeconfig", lambda: _kubeconfig_for(cluster, cred_env))

                # 7. Helm upgrade
                def helm():
                    _sh([
                        "helm", "upgrade", "--install", app.release_name,
                        f"./charts/{app.release_name}",
                        "--namespace", app.namespace,
                        "--create-namespace",
                        "--set", f"image.repository={image_repo}",
                        "--set", f"image.tag={run.commit_sha[:7]}",
                        "--wait", "--timeout", "5m",
                    ], cwd=src, env={**os.environ, **cred_env})
                step("Helm upgrade", helm)

            run.status = "ok"
        except Exception as e:
            run.status = "fail"
            steps.append({"error": _redact(str(e), token)})

        run.steps_json = {"steps": steps}
        run.finished_at = datetime.utcnow()
        db.commit()
    finally:
        db.close()