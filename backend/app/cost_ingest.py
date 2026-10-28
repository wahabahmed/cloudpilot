"""Daily billing ingestion. Run via `python -m app.cost_ingest` from cron."""
import os
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from .db import SessionLocal
from . import models, credentials


def ingest_aws(db: Session, account: models.CloudAccount, cred: models.Credential):
    """
    AWS Cost Explorer grouped by SERVICE (RESOURCE_ID is not a supported GroupBy).
    For true per-resource cost, use Cost and Usage Reports (CUR) with Athena.
    """
    import boto3
    env = credentials.aws_env_from_credential(cred)
    ce = boto3.client(
        "ce",
        aws_access_key_id=env["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
        aws_session_token=env.get("AWS_SESSION_TOKEN"),
        region_name="us-east-1",
    )
    start = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
    end = datetime.utcnow().strftime("%Y-%m-%d")
    resp = ce.get_cost_and_usage(
        TimePeriod={"Start": start, "End": end},
        Granularity="DAILY",
        Metrics=["UnblendedCost"],
        GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
    )
    for day in resp.get("ResultsByTime", []):
        for group in day.get("Groups", []):
            service = group["Keys"][0]
            amount = float(group["Metrics"]["UnblendedCost"]["Amount"])
            db.add(models.CostRecord(
                tenant_id=account.tenant_id, account_id=account.id,
                resource_id=service, resource_type="aws_service",
                amount=amount, recorded_at=datetime.utcnow(),
            ))
    db.commit()


def ingest_gcp(db: Session, account: models.CloudAccount, cred: models.Credential):
    """
    GCP: query the BigQuery billing export.
    Requires a billing export dataset and the service account's email in cred.payload_json.
    The detailed usage cost schema includes `resource.name` [citation:2][citation:8].
    """
    from google.cloud import bigquery
    from google.oauth2 import service_account

    p = cred.payload_json
    project_id = p["project_id"]
    dataset = p.get("billing_dataset")  # e.g. "billing_export"
    table = p.get("billing_table", "gcp_billing_export_resource_v1")

    # Build credentials from WIF (already exchanged by credentials.py)
    import google.auth
    from google.auth.transport.requests import Request as GReq
    creds, _ = google.auth.default()
    if not creds.valid:
        creds.refresh(GReq())

    client = bigquery.Client(project=project_id, credentials=creds)
    since = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")

    query = f"""
        SELECT
          resource.name AS resource_name,
          service.description AS service_name,
          SUM(cost) AS total_cost
        FROM `{project_id}.{dataset}.{table}`
        WHERE usage_start_time >= TIMESTAMP('{since}')
        GROUP BY resource_name, service_name
    """
    for row in client.query(query).result():
        db.add(models.CostRecord(
            tenant_id=account.tenant_id, account_id=account.id,
            resource_id=row.resource_name or row.service_name,
            resource_type="gcp_resource",
            amount=float(row.total_cost or 0),
            recorded_at=datetime.utcnow(),
        ))
    db.commit()


def ingest_azure(db: Session, account: models.CloudAccount, cred: models.Credential):
    """
    Azure: query Cost Management Usage Details.
    Requires azure-mgmt-costmanagement and azure-identity in requirements.
    """
    from azure.mgmt.costmanagement import CostManagementClient
    from azure.identity import ClientSecretCredential

    p = cred.payload_json
    cred_obj = ClientSecretCredential(
        tenant_id=p["tenant_id"],
        client_id=p["client_id"],
        client_secret=p["client_secret"],
    )
    client = CostManagementClient(cred_obj)
    scope = f"/subscriptions/{p['subscription_id']}"

    since = datetime.utcnow() - timedelta(days=1)
    params = {
        "type": "Usage",
        "timeframe": "Custom",
        "time_period": {
            "from_property": since.strftime("%Y-%m-%dT00:00:00Z"),
            "to": datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z"),
        },
        "dataset": {
            "granularity": "Daily",
            "aggregation": {
                "totalCost": {"name": "Cost", "function": "Sum"},
            },
            "grouping": [
                {"type": "Dimension", "name": "ResourceId"},
            ],
        },
    }
    result = client.query.usage(scope, params)
    for row in result.rows or []:
        # Azure returns rows as [cost, resource_id, currency, ...]
        if len(row) >= 2:
            db.add(models.CostRecord(
                tenant_id=account.tenant_id, account_id=account.id,
                resource_id=str(row[1]) if row[1] else "unknown",
                resource_type="azure_resource",
                amount=float(row[0] or 0),
                recorded_at=datetime.utcnow(),
            ))
    db.commit()


def ingest_oracle(db: Session, account: models.CloudAccount, cred: models.Credential):
    """
    Oracle OCI: use the Usage API (`oci.usage_api.UsageapiClient`) to summarize
    costs per resource. Requires oci SDK in requirements.
    Cost reports are also available as CSV in Object Storage [citation:3].
    """
    import oci

    p = cred.payload_json
    config = {
        "user": p["user_ocid"],
        "fingerprint": p["fingerprint"],
        "tenancy": p["tenancy_ocid"],
        "region": p.get("region", "us-ashburn-1"),
        "key_file": p.get("private_key_path", "/tmp/oci_key.pem"),
    }
    signer = oci.signer.Signer(**config)
    usage_client = oci.usage_api.UsageapiClient(config={}, signer=signer)

    since = datetime.utcnow() - timedelta(days=1)
    details = oci.usage_api.models.RequestSummarizedUsagesDetails(
        tenant_id=p["tenancy_ocid"],
        time_usage_started=since,
        time_usage_ended=datetime.utcnow(),
        granularity="DAILY",
        query_type="COST",
        group_by=["resourceId"],
    )
    resp = usage_client.request_summarized_usages(details)
    for item in resp.data.items or []:
        db.add(models.CostRecord(
            tenant_id=account.tenant_id, account_id=account.id,
            resource_id=item.resource_id or "unknown",
            resource_type="oci_resource",
            amount=float(item.computed_amount or 0),
            recorded_at=datetime.utcnow(),
        ))
    db.commit()


def ingest_alibaba(db: Session, account: models.CloudAccount, cred: models.Credential):
    """
    Alibaba Cloud: use BSS OpenAPI DescribeInstanceBill.
    Requires alibabacloud_bssopenapi SDK.
    The API returns instance-level bills with InstanceID and PretaxAmount [citation:4][citation:15].
    """
    from alibabacloud_bssopenapi20171214.client import Client as BssClient
    from alibabacloud_tea_openapi import models as open_api_models
    from alibabacloud_bssopenapi20171214 import models as bss_models

    p = cred.payload_json
    config = open_api_models.Config(
        access_key_id=p["access_key_id"],
        access_key_secret=p["access_key_secret"],
        endpoint="business.aliyuncs.com",
    )
    client = BssClient(config)

    today = datetime.utcnow()
    request = bss_models.DescribeInstanceBillRequest(
        billing_cycle=today.strftime("%Y-%m"),
        granularity="DAILY",
        billing_date=today.strftime("%Y-%m-%d"),
        page_size=300,
        page_num=1,
    )
    resp = client.describe_instance_bill(request)
    for item in (resp.body.data.items or []):
        db.add(models.CostRecord(
            tenant_id=account.tenant_id, account_id=account.id,
            resource_id=item.instance_id or "unknown",
            resource_type="alibaba_resource",
            amount=float(item.pretax_amount or 0),
            recorded_at=datetime.utcnow(),
        ))
    db.commit()


def ingest_ibm(db: Session, account: models.CloudAccount, cred: models.Credential):
    """
    IBM Cloud: use the Usage Reports API (Metering & Reporting).
    Requires an IAM token in cred.payload_json["iam_token"] or apikey.
    The API returns resource-level charges and metrics .
    """
    import requests

    p = cred.payload_json
    # Exchange API key for IAM token if needed
    iam_token = p.get("iam_token")
    if not iam_token:
        r = requests.post(
            "https://iam.cloud.ibm.com/identity/token",
            data={
                "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                "apikey": p["api_key"],
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        iam_token = r.json()["access_token"]

    month = datetime.utcnow().strftime("%Y-%m")
    resp = requests.get(
        f"https://metering-reporting.cloud.ibm.com/v1/accounts/{p['account_id']}/usage/{month}",
        headers={"Authorization": f"Bearer {iam_token}", "Accept": "application/json"},
    )
    data = resp.json()

    for resource in data.get("resources", []):
        db.add(models.CostRecord(
            tenant_id=account.tenant_id, account_id=account.id,
            resource_id=resource.get("resource_id") or resource.get("name", "unknown"),
            resource_type="ibm_resource",
            amount=float(resource.get("billable_charges", 0)),
            recorded_at=datetime.utcnow(),
        ))
    db.commit()


# Map provider string to ingest function
INGESTORS = {
    "aws": ingest_aws,
    "gcp": ingest_gcp,
    "azure": ingest_azure,
    "oracle": ingest_oracle,
    "alibaba": ingest_alibaba,
    "ibm": ingest_ibm,
}


def ingest_all():
    db = SessionLocal()
    try:
        accounts = db.query(models.CloudAccount).all()
        seen_tenants: set[int] = set()

        for a in accounts:
            cred = (db.get(models.Credential, a.credential_id) if a.credential_id
                    else db.query(models.Credential).filter_by(
                        tenant_id=a.tenant_id, provider=a.provider, env=a.env).first())
            if not cred:
                print(f"  skip account {a.id}: no credential")
                continue
            fn = INGESTORS.get(a.provider)
            if not fn:
                print(f"  skip account {a.id}: unsupported provider '{a.provider}'")
                continue
            try:
                fn(db, a, cred)
                print(f"  ✓ account {a.id} ({a.provider})")
                seen_tenants.add(a.tenant_id)
            except Exception as e:
                print(f"  ✗ account {a.id} ({a.provider}): {e}")

        if seen_tenants:
            from .recommendations import analyze_tenant
            for tid in seen_tenants:
                try:
                    counts = analyze_tenant(db, tid)
                    print(f"  ↳ recommendations for tenant {tid}: {counts}")
                except Exception as e:
                    print(f"  ↳ recommendations for tenant {tid} FAILED: {e}")
    finally:
        db.close()


if __name__ == "__main__":
    ingest_all()