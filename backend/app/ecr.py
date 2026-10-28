"""
ECR lifecycle policy management.

Instead of manually deleting images from pipelines.py (which is error-prone
and can delete images still in use), we install an ECR lifecycle policy once
per repository. AWS then expires old images automatically in the background.

The policy is idempotent — calling it again overwrites the previous one.
"""
import json
import os
import boto3


def _client():
    """ECR client. Region defaults to the storage region (same AWS account)."""
    return boto3.client(
        "ecr",
        region_name=os.environ.get("REGISTRY_REGION")
        or os.environ.get("STORAGE_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("PLATFORM_AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("PLATFORM_AWS_SECRET_ACCESS_KEY"),
    )


def ensure_ecr_lifecycle_policy(registry_prefix: str, keep_days: int = 14) -> dict:
    """
    Ensure the ECR repo referenced by REGISTRY_PREFIX has a lifecycle policy
    that expires images older than `keep_days`.

    `registry_prefix` is the value of REGISTRY_PREFIX, e.g.
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/cloudpilot-apps"
    The repository name is the part after the first "/".

    If the registry is not ECR (GHCR, Harbor, ACR, …), returns
    {"skipped": True, "reason": "not an ECR registry"} without doing anything.

    Returns a small dict describing what happened — useful for logging.
    """
    registry_host, _, repo_name = registry_prefix.partition("/")
    if not registry_host.endswith(".amazonaws.com") or ".dkr.ecr." not in registry_host:
        return {"skipped": True, "reason": "not an ECR registry"}
    if not repo_name:
        return {"skipped": True, "reason": "no repo name in REGISTRY_PREFIX"}

    # registry host looks like "<account>.dkr.ecr.<region>.amazonaws.com"
    parts = registry_host.split(".")
    try:
        registry_id = parts[0]
        region = parts[3]
    except IndexError:
        return {"skipped": True, "reason": "unparseable ECR host"}

    client = boto3.client(
        "ecr",
        region_name=region,
        aws_access_key_id=os.environ.get("PLATFORM_AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("PLATFORM_AWS_SECRET_ACCESS_KEY"),
    )

    policy = {
        "rules": [
            {
                "rulePriority": 1,
                "description": f"Expire images older than {keep_days} days",
                "selection": {
                    "tagStatus": "any",
                    "countType": "sinceImagePushed",
                    "countUnit": "days",
                    "countNumber": keep_days,
                },
                "action": {"type": "expire"},
            },
            {
                "rulePriority": 2,
                "description": "Keep last 30 images regardless of age",
                "selection": {
                    "tagStatus": "any",
                    "countType": "imageCountMoreThan",
                    "countNumber": 30,
                },
                "action": {"type": "expire"},
            },
        ]
    }

    try:
        client.put_lifecycle_policy(
            registryId=registry_id,
            repositoryName=repo_name,
            lifecyclePolicyText=json.dumps(policy),
        )
    except client.exceptions.RepositoryNotFoundException:
        # Repo doesn't exist yet (first push hasn't happened).
        # Not an error — the next pipeline run after the first push will install it.
        return {"skipped": True, "reason": "repo not found (no push yet)"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

    return {"ok": True, "registry_id": registry_id, "repo": repo_name,
            "keep_days": keep_days}