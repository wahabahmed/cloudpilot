"""
Import existing cloud resources into Terraform state.

Flow per provider:
  1. Discover: query the cloud's resource inventory API
  2. Generate: write import blocks, run `terraform plan -generate-config-out`
  3. Refine: send generated HCL to DeepSeek for cleanup
  4. Store: upload refined HCL to S3 under tenants/{tid}/imports/{id}/
  5. Adopt: worker runs `terraform apply` with the refined HCL
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import boto3
from openai import OpenAI

from .storage import storage

client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"],
                base_url="https://api.deepseek.com")


# ============================================================
# DISCOVERY — one function per cloud
# ============================================================

def discover_aws(account_ref: str, region: str, cred: dict) -> list[dict]:
    """List resources via AWS Resource Explorer 2. Requires an aggregator index."""
    session = boto3.Session(
        aws_access_key_id=cred.get("access_key_id"),
        aws_secret_access_key=cred.get("secret_access_key"),
        aws_session_token=cred.get("session_token"),
        region_name=region,
    )
    re = session.client("resource-explorer-2")
    resources = []
    next_token = None
    while True:
        kwargs = {"MaxResults": 100, "QueryString": " "}
        if next_token:
            kwargs["NextToken"] = next_token
        try:
            resp = re.search(**kwargs)
        except re.exceptions.ThrottlingException:
            import time
            time.sleep(2)
            continue
        for r in resp.get("Resources", []):
            resources.append({
                "type": r.get("ResourceType", ""),
                "id": r.get("Arn", ""),
                "name": r.get("Arn", "").split("/")[-1] if r.get("Arn") else "",
                "region": r.get("Region", region),
            })
        next_token = resp.get("NextToken")
        if not next_token:
            break
    return resources


def discover_gcp(project_id: str, cred: dict) -> list[dict]:
    """List resources via Cloud Asset Inventory SearchAllResources."""
    from google.cloud import asset_v1
    from google.oauth2 import service_account

    if cred.get("wif_config"):
        from google.auth import identity_pool
        from google.auth.transport.requests import Request as GReq
        creds = identity_pool.Credentials.from_info(cred["wif_config"])
        creds.refresh(GReq())
    else:
        creds = service_account.Credentials.from_service_account_info(cred)

    client = asset_v1.AssetServiceClient(credentials=creds)
    request = asset_v1.SearchAllResourcesRequest(
        scope=f"projects/{project_id}",
        page_size=500,
    )
    resources = []
    for page in client.search_all_resources(request=request):
        resources.append({
            "type": page.asset_type,
            "id": page.name,
            "name": page.display_name or page.name.split("/")[-1],
            "region": page.location or "",
        })
    return resources


def discover_azure(subscription_ids: list[str], cred: dict) -> list[dict]:
    """List resources via Azure Resource Graph across subscriptions."""
    from azure.identity import ClientSecretCredential
    from azure.mgmt.resourcegraph import ResourceGraphClient
    from azure.mgmt.resourcegraph.models import QueryRequest

    cred_obj = ClientSecretCredential(
        tenant_id=cred["tenant_id"],
        client_id=cred["client_id"],
        client_secret=cred["client_secret"],
    )
    client = ResourceGraphClient(cred_obj)
    request = QueryRequest(
        subscriptions=subscription_ids,
        query="Resources | project id, name, type, location",
    )
    response = client.resources(request)
    resources = []
    for row in response.data or []:
        resources.append({
            "type": row.get("type", ""),
            "id": row.get("id", ""),
            "name": row.get("name", ""),
            "region": row.get("location", ""),
        })
    return resources


def discover_oracle(tenancy_id: str, cred: dict) -> list[dict]:
    """List resources via OCI Search service."""
    import oci

    config = {
        "user": cred["user_ocid"],
        "fingerprint": cred["fingerprint"],
        "tenancy": cred["tenancy_ocid"],
        "region": cred.get("region", "us-ashburn-1"),
        "key_file": cred.get("private_key_path", "/tmp/oci_key.pem"),
    }
    signer = oci.signer.Signer(**config)
    client = oci.resource_search.ResourceSearchClient(config={}, signer=signer)

    details = oci.resource_search.models.StructuredSearchDetails(
        type="Structured",
        query="query all resources",
    )
    resources = []
    for item in oci.pagination.list_call_get_all_results(
        client.search_resources, search_details=details, limit=1000
    ).data:
        resources.append({
            "type": item.resource_type,
            "id": item.identifier,
            "name": item.display_name or item.identifier.split(".")[-1],
            "region": getattr(item, "region", ""),
        })
    return resources


def discover_ibm(account_id: str, cred: dict) -> list[dict]:
    """List resources via IBM Resource Controller."""
    import requests

    iam_token = cred.get("iam_token")
    if not iam_token:
        r = requests.post(
            "https://iam.cloud.ibm.com/identity/token",
            data={"grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                  "apikey": cred["api_key"]},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        iam_token = r.json()["access_token"]

    resources = []
    next_url = f"https://resource-controller.cloud.ibm.com/v2/resource_instances"
    params = {"limit": 100}
    while next_url:
        resp = requests.get(next_url, params=params,
                            headers={"Authorization": f"Bearer {iam_token}"})
        data = resp.json()
        for inst in data.get("resources", []):
            resources.append({
                "type": inst.get("resource_plan_id", "ibm_resource"),
                "id": inst.get("crn", ""),
                "name": inst.get("name", ""),
                "region": inst.get("region_id", ""),
            })
        next_url = data.get("next_url")
        params = None
    return resources


def discover_alibaba(cred: dict) -> list[dict]:
    """List resources via Alibaba Cloud Resource Center SearchResources."""
    from alibabacloud_resourcecenter20221201.client import Client
    from alibabacloud_resourcecenter20221201 import models
    from alibabacloud_tea_openapi import models as open_api_models

    config = open_api_models.Config(
        access_key_id=cred["access_key_id"],
        access_key_secret=cred["access_key_secret"],
        endpoint="resourcecenter.aliyuncs.com",
    )
    client = Client(config)
    resources = []
    next_token = None
    while True:
        req = models.SearchResourcesRequest(max_results=500)
        if next_token:
            req.next_token = next_token
        resp = client.search_resources(req)
        for r in resp.body.resources or []:
            resources.append({
                "type": r.resource_type,
                "id": r.resource_id,
                "name": r.resource_name or r.resource_id,
                "region": r.region_id or "",
            })
        next_token = resp.body.next_token
        if not next_token:
            break
    return resources


DISCOVERY = {
    "aws": discover_aws,
    "gcp": discover_gcp,
    "azure": discover_azure,
    "oracle": discover_oracle,
    "ibm": discover_ibm,
    "alibaba": discover_alibaba,
}


# ============================================================
# HCL GENERATION — via Terraform + DeepSeek refinement
# ============================================================

TF_PROVIDER_MAP = {
    "aws": "aws",
    "gcp": "google",
    "azure": "azurerm",
    "oracle": "oci",
    "ibm": "ibm",
    "alibaba": "alicloud",
}

# Mapping from cloud-native resource type to Terraform resource type.
# Extend this as you support more resource kinds.
TF_TYPE_MAP = {
    # ---------- AWS ----------
    "AWS::EC2::VPC":                    "aws_vpc",
    "AWS::EC2::Subnet":                 "aws_subnet",
    "AWS::EC2::InternetGateway":        "aws_internet_gateway",
    "AWS::EC2::NatGateway":             "aws_nat_gateway",
    "AWS::EC2::RouteTable":             "aws_route_table",
    "AWS::EC2::Route":                  "aws_route",
    "AWS::EC2::SecurityGroup":          "aws_security_group",
    "AWS::EC2::SecurityGroupIngress":   "aws_security_group_rule",
    "AWS::EC2::SecurityGroupEgress":    "aws_security_group_rule",
    "AWS::EC2::Instance":               "aws_instance",
    "AWS::EC2::EIP":                    "aws_eip",
    "AWS::EC2::Volume":                 "aws_ebs_volume",
    "AWS::EC2::LaunchTemplate":         "aws_launch_template",
    "AWS::EC2::KeyPair":                "aws_key_pair",
    "AWS::S3::Bucket":                  "aws_s3_bucket",
    "AWS::RDS::DBInstance":             "aws_db_instance",
    "AWS::RDS::DBSubnetGroup":          "aws_db_subnet_group",
    "AWS::RDS::DBParameterGroup":       "aws_db_parameter_group",
    "AWS::DynamoDB::Table":             "aws_dynamodb_table",
    "AWS::ElastiCache::CacheCluster":   "aws_elasticache_cluster",
    "AWS::ElastiCache::ReplicationGroup": "aws_elasticache_replication_group",
    "AWS::ElasticLoadBalancingV2::LoadBalancer": "aws_lb",
    "AWS::ElasticLoadBalancingV2::TargetGroup":  "aws_lb_target_group",
    "AWS::ElasticLoadBalancingV2::Listener":     "aws_lb_listener",
    "AWS::EKS::Cluster":                "aws_eks_cluster",
    "AWS::EKS::Nodegroup":              "aws_eks_node_group",
    "AWS::IAM::Role":                   "aws_iam_role",
    "AWS::IAM::Policy":                 "aws_iam_policy",
    "AWS::IAM::InstanceProfile":        "aws_iam_instance_profile",
    "AWS::Lambda::Function":            "aws_lambda_function",
    "AWS::SQS::Queue":                  "aws_sqs_queue",
    "AWS::SNS::Topic":                  "aws_sns_topic",
    "AWS::KMS::Key":                    "aws_kms_key",
    "AWS::SecretsManager::Secret":      "aws_secretsmanager_secret",
    "AWS::Logs::LogGroup":              "aws_cloudwatch_log_group",
    "AWS::Route53::HostedZone":         "aws_route53_zone",
    "AWS::CloudFront::Distribution":    "aws_cloudfront_distribution",

    # ---------- GCP ----------
    "compute.googleapis.com/Instance":         "google_compute_instance",
    "compute.googleapis.com/Network":          "google_compute_network",
    "compute.googleapis.com/Subnetwork":       "google_compute_subnetwork",
    "compute.googleapis.com/Firewall":         "google_compute_firewall",
    "container.googleapis.com/Cluster":        "google_container_cluster",
    "container.googleapis.com/NodePool":       "google_container_node_pool",
    "storage.googleapis.com/Bucket":           "google_storage_bucket",
    "sqladmin.googleapis.com/Instance":        "google_sql_database_instance",
    "bigquery.googleapis.com/Dataset":         "google_bigquery_dataset",
    "pubsub.googleapis.com/Topic":             "google_pubsub_topic",
    "iam.googleapis.com/ServiceAccount":       "google_service_account",
    "cloudfunctions.googleapis.com/Function":  "google_cloudfunctions_function",

    # ---------- Azure ----------
    "microsoft.compute/virtualmachines":             "azurerm_linux_virtual_machine",
    "microsoft.network/virtualnetworks":             "azurerm_virtual_network",
    "microsoft.network/subnets":                     "azurerm_subnet",
    "microsoft.network/networksecuritygroups":       "azurerm_network_security_group",
    "microsoft.network/publicipaddresses":           "azurerm_public_ip",
    "microsoft.containerservice/managedclusters":    "azurerm_kubernetes_cluster",
    "microsoft.storage/storageaccounts":             "azurerm_storage_account",
    "microsoft.storage/storageaccounts/blobservices/containers": "azurerm_storage_container",
    "microsoft.sql/servers":                         "azurerm_mssql_server",
    "microsoft.sql/servers/databases":               "azurerm_mssql_database",
    "microsoft.keyvault/vaults":                     "azurerm_key_vault",
    "microsoft.web/sites":                           "azurerm_linux_web_app",

    # ---------- OCI ----------
    "computeinstance":  "oci_core_instance",
    "vcn":              "oci_core_vcn",
    "subnet":           "oci_core_subnet",
    "internetgateway":  "oci_core_internet_gateway",
    "routetable":       "oci_core_route_table",
    "securitylist":     "oci_core_security_list",
    "bucket":           "oci_objectstorage_bucket",

    # ---------- IBM ----------
    "cloud-object-storage":  "ibm_resource_instance",
    "is.vpc":                "ibm_is_vpc",
    "is.subnet":             "ibm_is_subnet",
    "is.instance":           "ibm_is_instance",

    # ---------- Alibaba ----------
    "ACS::ECS::Instance":            "alicloud_instance",
    "ACS::ECS::VSwitch":             "alicloud_vswitch",
    "ACS::VPC::VPC":                 "alicloud_vpc",
    "ACS::OSS::Bucket":              "alicloud_oss_bucket",
    "ACS::RDS::DBInstance":          "alicloud_db_instance",
    "ACS::CS::Cluster":              "alicloud_cs_managed_kubernetes",
}


def _provider_block(provider: str, cred_env: dict, region: str) -> str:
    """Write the provider configuration block for the generated HCL."""
    if provider == "aws":
        return f'''
provider "aws" {{
  region = "{region}"
}}
'''
    if provider == "gcp":
        return f'''
provider "google" {{
  project = "{cred_env.get("project_id", cred_env.get("CLOUDSDK_CORE_PROJECT", ""))}"
  region  = "{region}"
}}
'''
    if provider == "azure":
        return f'''
provider "azurerm" {{
  features {{}}
  subscription_id = "{cred_env.get("subscription_id", cred_env.get("ARM_SUBSCRIPTION_ID", ""))}"
}}
'''
    if provider == "oracle":
        return f'''
provider "oci" {{
  region = "{region}"
}}
'''
    if provider == "ibm":
        return '''
provider "ibm" {}
'''
    if provider == "alibaba":
        return f'''
provider "alicloud" {{
  region = "{region}"
}}
'''
    return ""


def _generate_import_blocks(resources: list[dict], provider: str) -> str:
    """
    Write import blocks with Terraform resource addresses.

    Raises if any resource's type is not in TF_TYPE_MAP, so the admin sees a
    clear error instead of resources being silently skipped.
    """
    lines = []
    skipped = []
    for i, r in enumerate(resources):
        tf_type = TF_TYPE_MAP.get(r["type"])
        if not tf_type:
            skipped.append(r["type"])
            continue
        label = f"imported_{i}"
        lines.append(f'''
import {{
  to = {tf_type}.{label}
  id = "{r["id"]}"
}}
''')
    if skipped:
        raise RuntimeError(
            f"Unsupported resource types for import ({provider}): "
            f"{sorted(set(skipped))}. Add them to TF_TYPE_MAP first."
        )
    return "\n".join(lines)


def generate_hcl_via_terraform(resources: list[dict], provider: str,
                                cred_env: dict, workdir: Path,
                                region: str = "us-east-1") -> str:
    """
    Write import blocks + provider, run terraform plan -generate-config-out.
    Returns the generated HCL. Requires terraform binary in PATH.
    """
    (workdir / "provider.tf").write_text(_provider_block(provider, cred_env, region))

    imports_hcl = _generate_import_blocks(resources, provider)
    if not imports_hcl.strip():
        raise RuntimeError(f"No resources could be mapped to Terraform types for {provider}")
    (workdir / "imports.tf").write_text(imports_hcl)

    env = {**os.environ, **cred_env}
    subprocess.run(["terraform", "init", "-input=false", "-no-color"],
                   cwd=workdir, env=env, capture_output=True, text=True, check=True)
    result = subprocess.run(
        ["terraform", "plan", "-input=false", "-no-color",
         "-generate-config-out=generated.tf"],
        cwd=workdir, env=env, capture_output=True, text=True,
    )

    generated = workdir / "generated.tf"
    if generated.exists():
        return generated.read_text()
    raise RuntimeError(f"Config generation failed:\n{result.stdout}\n{result.stderr}")


def refine_hcl_with_deepseek(generated_hcl: str, provider: str,
                             resource_count: int) -> str:
    """
    Send Terraform-generated HCL to DeepSeek for cleanup.
    Critical: DeepSeek must NOT change attribute values.
    """
    prompt = f"""You are a Terraform expert. Below is HCL generated by `terraform plan -generate-config-out` for {provider}.
It is syntactically correct. Your ONLY task is to clean it up:

1. Remove computed attributes that cannot be set in configuration (e.g., `id`, `arn`, `tags_all`, `owner_id`).
2. Remove provider-default values that are unnecessarily verbose.
3. Group resources logically.
4. Add brief comments explaining non-obvious resources.

CRITICAL RULES:
- Do NOT change any attribute VALUES. Only remove attributes that Terraform marks as computed.
- Do NOT change resource type or label.
- Keep the HCL valid.
- Return ONLY the cleaned HCL. No markdown fences, no explanation.

Generated HCL:
{generated_hcl}
"""
    r = client.chat.completions.create(
        model="deepseek-flash",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
        max_tokens=8000,
    )
    hcl = r.choices[0].message.content.strip()
    if hcl.startswith("```"):
        lines = hcl.splitlines()[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        hcl = "\n".join(lines).strip()
    return hcl


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def run_import(
    tenant_id: int,
    account_ref: str,
    provider: str,
    region: str,
    cred_env: dict,
    resources: list[dict],
    import_id: str,
) -> dict:
    """
    Full import flow: generate HCL, refine with DeepSeek, store to S3.
    The terraform apply happens in the worker via a queued job.
    """
    if provider not in DISCOVERY:
        raise ValueError(f"Unsupported provider: {provider}")

    with tempfile.TemporaryDirectory() as tmp:
        wd = Path(tmp)

        try:
            raw_hcl = generate_hcl_via_terraform(
                resources, provider, cred_env, wd, region=region,
            )
        except Exception as e:
            raise RuntimeError(f"Terraform config generation failed: {e}")

        refined_hcl = refine_hcl_with_deepseek(raw_hcl, provider, len(resources))

        prefix = f"tenants/{tenant_id}/imports/{import_id}"
        storage.put(f"{prefix}/generated.tf", refined_hcl.encode())
        storage.put(f"{prefix}/raw_generated.tf", raw_hcl.encode())
        storage.put(f"{prefix}/manifest.json", json.dumps({
            "account_ref": account_ref,
            "provider": provider,
            "region": region,
            "resource_count": len(resources),
            "resources": resources,
        }, indent=2).encode())

        return {
            "s3_prefix": prefix,
            "resource_count": len(resources),
            "hcl_preview": refined_hcl[:800],
        }