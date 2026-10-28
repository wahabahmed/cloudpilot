from datetime import datetime
from sqlalchemy import String, ForeignKey, DateTime, JSON, Integer, Float, Boolean
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class Tenant(Base):
    __tablename__ = "tenants"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Team(Base):
    __tablename__ = "teams"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    name: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class TeamAccount(Base):
    __tablename__ = "team_accounts"
    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    account_id: Mapped[int] = mapped_column(ForeignKey("cloud_accounts.id"))


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id"), nullable=True)
    email: Mapped[str] = mapped_column(String(256), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16), default="member")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class CloudAccount(Base):
    __tablename__ = "cloud_accounts"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    provider: Mapped[str] = mapped_column(String(16))
    account_ref: Mapped[str] = mapped_column(String(256))
    # Provider-native identifier of the sub-account:
    #   aws → 12-digit account number, gcp → project id, azure → subscription id,
    #   oracle → tenancy OCID, alibaba → UID, ibm → account id
    cloud_account_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    env: Mapped[str] = mapped_column(String(16), default="DEV")
    state_key: Mapped[str] = mapped_column(String(512))
    credential_id: Mapped[int | None] = mapped_column(ForeignKey("credentials.id"), nullable=True)


class Credential(Base):
    __tablename__ = "credentials"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    provider: Mapped[str] = mapped_column(String(16))
    env: Mapped[str] = mapped_column(String(16), default="DEV")
    payload_json: Mapped[dict] = mapped_column(JSON)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class CustomParameter(Base):
    __tablename__ = "custom_parameters"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    provider: Mapped[str] = mapped_column(String(16))
    env: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(512))
    value: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class WorkflowDefinition(Base):
    __tablename__ = "workflow_definitions"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    name: Mapped[str] = mapped_column(String(128))
    steps_json: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Request(Base):
    __tablename__ = "requests"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    account_id: Mapped[int] = mapped_column(ForeignKey("cloud_accounts.id"))
    workflow_id: Mapped[int | None] = mapped_column(ForeignKey("workflow_definitions.id"), nullable=True)
    env: Mapped[str] = mapped_column(String(16), default="DEV")
    nlp_text: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String(32), default="queued")
    # pointer into workflow_definitions.steps_json; 0-indexed
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    # snapshot of len(steps_json) at submit time, so editing the workflow
    # later does not change what "step 2 of 5" means for this request
    total_steps: Mapped[int] = mapped_column(Integer, default=0)
    plan_summary: Mapped[str] = mapped_column(String, default="")
    plan_additions: Mapped[int] = mapped_column(Integer, default=0)
    plan_changes: Mapped[int] = mapped_column(Integer, default=0)
    plan_destructions: Mapped[int] = mapped_column(Integer, default=0)
    s3_prefix: Mapped[str] = mapped_column(String(512), default="")
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    # list of user_ids who approved each approval step, e.g. [5, 7]
    approvals_log: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)



class InventoryResource(Base):
    __tablename__ = "inventory_resources"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    account_id: Mapped[int] = mapped_column(ForeignKey("cloud_accounts.id"))
    resource_type: Mapped[str] = mapped_column(String(64))
    # Terraform resource name (e.g. "imported_0"), from state
    resource_id: Mapped[str] = mapped_column(String(512))
    # Cloud-native id (ARN, project id, resource id) — used to skip
    # resources that are already imported
    cloud_native_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    state: Mapped[str] = mapped_column(String(32), default="Active")
    meta_json: Mapped[dict] = mapped_column(JSON, default=dict)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CostRecord(Base):
    __tablename__ = "cost_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    account_id: Mapped[int] = mapped_column(ForeignKey("cloud_accounts.id"))
    resource_id: Mapped[str] = mapped_column(String(512), default="")
    resource_type: Mapped[str] = mapped_column(String(64), default="")
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Budget(Base):
    __tablename__ = "budgets"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    monthly_amount: Mapped[float] = mapped_column(Float, default=0.0)


class Application(Base):
    __tablename__ = "applications"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    repo_url: Mapped[str] = mapped_column(String(512))
    branch: Mapped[str] = mapped_column(String(128), default="main")
    cluster_id: Mapped[int] = mapped_column(ForeignKey("cloud_accounts.id"))
    namespace: Mapped[str] = mapped_column(String(128))
    release_name: Mapped[str] = mapped_column(String(128))
    env: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(32), default="registered")
    repo_token: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class PipelineRun(Base):
    __tablename__ = "pipeline_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    application_id: Mapped[int] = mapped_column(ForeignKey("applications.id"))
    commit_sha: Mapped[str] = mapped_column(String(64))
    image: Mapped[str] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(32), default="queued")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    steps_json: Mapped[dict] = mapped_column(JSON, default=dict)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    job_type: Mapped[str] = mapped_column(String(32))
    ref_id: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="queued")
    claimed_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    lease_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class License(Base):
    __tablename__ = "licenses"
    id: Mapped[int] = mapped_column(primary_key=True)
    license_key: Mapped[str] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class OptimizationRecommendation(Base):
    __tablename__ = "optimization_recommendations"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id"))
    account_id: Mapped[int] = mapped_column(ForeignKey("cloud_accounts.id"))
    resource_id: Mapped[str] = mapped_column(String(512))
    rule: Mapped[str] = mapped_column(String(64))          # e.g. "idle-ec2"
    finding: Mapped[str] = mapped_column(String)           # human text
    monthly_savings: Mapped[float] = mapped_column(Float)
    effort: Mapped[str] = mapped_column(String(16))        # low | medium | high
    status: Mapped[str] = mapped_column(String(16), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)