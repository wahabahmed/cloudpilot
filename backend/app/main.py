import os
from datetime import datetime, timedelta
from math import ceil
from typing import TypeVar

from fastapi import FastAPI, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from .db import Base, engine, get_db
from . import models, credentials, nlp, terraform_runner
from .auth import (get_current_user, require_role, visible_account_ids,
                    create_token, hash_password, verify_password)
from .queue import enqueue
from .licensing import (
    LicenseMiddleware, get_current_license, verify_license_token,
    invalidate_license_cache,
)
from .crypto import encrypt_token


app = FastAPI(title="CloudPilot Backend", version="0.1.0")
app.add_middleware(LicenseMiddleware)


# Maximum number of resources per import call. Above this, the synchronous
# HCL generation (terraform plan -generate-config-out + DeepSeek) exceeds
# typical ingress timeouts.
MAX_IMPORT_BATCH = 100


# ============================================================
# Pagination helper — DISTINCT-PK count so JOINs don't inflate `total`
# ============================================================
T = TypeVar("T")


def paginated_response(query, page: int, limit: int, serialize) -> dict:
    page = max(1, page)
    limit = max(1, min(limit, 100))

    # Count DISTINCT primary keys of the first selected entity, so a query
    # with `.join(...)` that fans out rows still returns the right `total`.
    entity = query.column_descriptions[0]["entity"]
    pk = entity.__mapper__.primary_key[0]

    total = (
        query.order_by(None)
             .with_entities(func.count(func.distinct(pk)))
             .scalar()
        or 0
    )
    pages = ceil(total / limit) if total else 1
    items = query.offset((page - 1) * limit).limit(limit).all()
    return {
        "items": [serialize(x) for x in items],
        "total": int(total),
        "page": page,
        "pages": pages,
        "limit": limit,
    }


# ============================================================
# Startup — create_all + idempotent ALTERs for schema drift
# ============================================================
@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)

    # `create_all()` creates missing TABLES, but never adds missing COLUMNS
    # to tables that already exist. The statements below are idempotent
    # (IF NOT EXISTS) and safe to run on every boot, so an old database
    # and a freshly created one both end up with the same schema.
    with engine.begin() as conn:
        conn.execute(text(
            "ALTER TABLE requests ADD COLUMN IF NOT EXISTS requested_by "
            "INTEGER REFERENCES users(id)"
        ))
        conn.execute(text(
            "ALTER TABLE requests ADD COLUMN IF NOT EXISTS approved_by "
            "INTEGER REFERENCES users(id)"
        ))
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP"
        ))
        conn.execute(text(
            "ALTER TABLE teams ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP"
        ))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS optimization_recommendations (
                id              SERIAL PRIMARY KEY,
                tenant_id       INTEGER NOT NULL REFERENCES tenants(id),
                resource_id     VARCHAR(512) NOT NULL,
                finding         VARCHAR NOT NULL DEFAULT '',
                monthly_savings FLOAT NOT NULL DEFAULT 0.0,
                effort          VARCHAR(32) NOT NULL DEFAULT 'medium',
                status          VARCHAR(32) NOT NULL DEFAULT 'open'
            )
        """))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_requests_tenant_created "
            "ON requests (tenant_id, created_at DESC)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_requests_tenant_status "
            "ON requests (tenant_id, status)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_requests_requested_by "
            "ON requests (requested_by)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_team_accounts_account "
            "ON team_accounts (account_id)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_team_accounts_team "
            "ON team_accounts (team_id)"
        ))


# ============================================================
# Pydantic bodies
# ============================================================
class WorkflowIn(BaseModel):
    name: str
    steps: list


class CredentialIn(BaseModel):
    payload: dict


class LicenseIn(BaseModel):
    license_key: str


class ImportDiscoverIn(BaseModel):
    region: str = "us-east-1"


class ImportStartIn(BaseModel):
    region: str = "us-east-1"
    resource_ids: list[str]


# ============================================================
# AUTH
# ============================================================
@app.post("/auth/login")
def login(email: str, password: str, db: Session = Depends(get_db)):
    u = db.query(models.User).filter_by(email=email).first()
    if not u or u.deleted_at is not None or not verify_password(password, u.password_hash):
        raise HTTPException(401, "invalid credentials")
    if u.team_id is not None:
        team = db.get(models.Team, u.team_id)
        if team and team.deleted_at is not None:
            raise HTTPException(401, "invalid credentials")
    return {"token": create_token(u), "tenant_id": u.tenant_id,
            "user_id": u.id, "role": u.role}


@app.get("/me")
def me(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    t = db.get(models.Tenant, user.tenant_id)
    return {"user_id": user.id, "email": user.email, "name": user.name,
            "role": user.role, "team_id": user.team_id,
            "tenant_id": user.tenant_id, "tenant_name": t.name}


# ============================================================
# TENANTS
# ============================================================
@app.post("/tenants")
def create_tenant(name: str, admin_email: str, admin_password: str,
                  db: Session = Depends(get_db)):
    if db.query(models.Tenant).filter_by(name=name).first():
        raise HTTPException(400, "tenant exists")
    t = models.Tenant(name=name)
    db.add(t); db.commit(); db.refresh(t)
    u = models.User(tenant_id=t.id, email=admin_email, name="Admin",
                    password_hash=hash_password(admin_password), role="admin")
    db.add(u); db.commit()
    return {"tenant_id": t.id, "admin_user_id": u.id}


@app.get("/tenants/{tid}")
def get_tenant(tid: int, user: models.User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    t = db.get(models.Tenant, tid)
    if not t: raise HTTPException(404)
    return {"id": t.id, "name": t.name, "created_at": t.created_at}


@app.get("/providers")
def list_providers(user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    counts = {"aws": 47, "gcp": 25, "azure": 28, "databricks": 12}
    out = []
    for pid, count in counts.items():
        connected = db.query(models.Credential).filter_by(
            tenant_id=user.tenant_id, provider=pid).first() is not None
        out.append({"id": pid, "services": count, "connected": connected})
    return out


# ============================================================
# TEAMS
# ============================================================
@app.post("/tenants/{tid}/teams")
def create_team(tid: int, name: str,
                user: models.User = Depends(require_role("admin")),
                db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    t = models.Team(tenant_id=tid, name=name)
    db.add(t); db.commit(); db.refresh(t)
    return {"id": t.id, "name": t.name}


@app.get("/tenants/{tid}/teams")
def list_teams(tid: int,
               search: str = Query(None),
               page: int = Query(1, ge=1),
               limit: int = Query(10, ge=1, le=100),
               user: models.User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    q = db.query(models.Team).filter(
        models.Team.tenant_id == tid,
        models.Team.deleted_at.is_(None),
    )
    # Non-admins can only see their own team.
    if user.role != "admin":
        q = q.filter(models.Team.id == user.team_id)
    if search:
        q = q.filter(models.Team.name.ilike(f"%{search}%"))
    q = q.order_by(models.Team.id.desc())
    return paginated_response(q, page, limit, lambda t: {"id": t.id, "name": t.name})


@app.patch("/teams/{team_id}")
def update_team(team_id: int, name: str,
                user: models.User = Depends(require_role("admin")),
                db: Session = Depends(get_db)):
    t = db.get(models.Team, team_id)
    if not t or t.tenant_id != user.tenant_id: raise HTTPException(404)
    t.name = name; db.commit()
    return {"id": t.id, "name": t.name}


@app.delete("/teams/{team_id}")
def delete_team(team_id: int,
                user: models.User = Depends(require_role("admin")),
                db: Session = Depends(get_db)):
    team = db.get(models.Team, team_id)
    if not team or team.tenant_id != user.tenant_id:
        raise HTTPException(404)
    if team.deleted_at is not None:
        return {"status": "already deleted", "team_id": team_id}
    now = datetime.utcnow()
    team.deleted_at = now
    db.query(models.User).filter(
        models.User.team_id == team_id,
        models.User.deleted_at.is_(None),
    ).update({"deleted_at": now}, synchronize_session=False)
    db.commit()
    return {"status": "deleted", "team_id": team_id}


@app.post("/teams/{team_id}/accounts/{account_id}")
def attach_account(team_id: int, account_id: int,
                   user: models.User = Depends(require_role("admin")),
                   db: Session = Depends(get_db)):
    team = db.get(models.Team, team_id)
    account = db.get(models.CloudAccount, account_id)
    if not team or not account or team.tenant_id != user.tenant_id:
        raise HTTPException(404)
    if account.tenant_id != team.tenant_id:
        raise HTTPException(400, "account and team must be in the same tenant")
    if db.query(models.TeamAccount).filter_by(
            team_id=team_id, account_id=account_id).first():
        return {"status": "already attached"}
    db.add(models.TeamAccount(team_id=team_id, account_id=account_id))
    db.commit()
    return {"status": "attached"}


@app.get("/tenants/{tid}/account-teams")
def list_account_teams(tid: int,
                       user: models.User = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)

    rows = (
        db.query(models.TeamAccount.account_id, models.Team.id, models.Team.name)
          .join(models.Team, models.Team.id == models.TeamAccount.team_id)
          .filter(models.Team.tenant_id == tid)
          .all()
    )

    out: dict[int, list[dict]] = {}
    for account_id, team_id, team_name in rows:
        out.setdefault(account_id, []).append({"id": team_id, "name": team_name})

    return {str(k): v for k, v in out.items()}


@app.delete("/teams/{team_id}/accounts/{account_id}")
def detach_account(team_id: int, account_id: int,
                   user: models.User = Depends(require_role("admin")),
                   db: Session = Depends(get_db)):
    team = db.get(models.Team, team_id)
    if not team or team.tenant_id != user.tenant_id:
        raise HTTPException(404)

    row = db.query(models.TeamAccount).filter_by(
        team_id=team_id, account_id=account_id).first()
    if not row:
        return {"status": "not attached"}

    db.delete(row)
    db.commit()
    return {"status": "detached"}


# ============================================================
# USERS
# ============================================================
@app.post("/tenants/{tid}/users")
def create_user(tid: int, email: str, name: str, password: str,
                team_id: int = Query(None), role: str = "member",
                user: models.User = Depends(require_role("admin")),
                db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    if role not in ("admin", "member", "viewer"): raise HTTPException(400)
    if db.query(models.User).filter_by(email=email).first():
        raise HTTPException(400, "email exists")
    if team_id is not None:
        t = db.get(models.Team, team_id)
        if not t or t.tenant_id != user.tenant_id or t.deleted_at is not None:
            raise HTTPException(400, "team not found in this tenant")
    u = models.User(tenant_id=tid, email=email, name=name,
                    password_hash=hash_password(password),
                    team_id=team_id, role=role)
    db.add(u); db.commit(); db.refresh(u)
    return {"id": u.id, "email": u.email, "role": u.role, "team_id": u.team_id}


@app.get("/tenants/{tid}/users")
def list_users(tid: int,
               team_id: int = Query(None),
               search: str = Query(None),
               page: int = Query(1, ge=1),
               limit: int = Query(10, ge=1, le=100),
               user: models.User = Depends(require_role("admin", "member")),
               db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    q = db.query(models.User).filter(
        models.User.tenant_id == tid,
        models.User.deleted_at.is_(None),
    )
    if team_id is not None:
        q = q.filter(models.User.team_id == team_id)
    if search:
        like = f"%{search}%"
        q = q.filter(models.User.name.ilike(like) | models.User.email.ilike(like))
    q = q.order_by(models.User.id.desc())
    return paginated_response(q, page, limit, lambda u: {
        "id": u.id, "email": u.email, "name": u.name,
        "role": u.role, "team_id": u.team_id,
    })


@app.patch("/users/{uid}")
def update_user(uid: int, role: str = Query(None), team_id: int = Query(None),
                user: models.User = Depends(require_role("admin")),
                db: Session = Depends(get_db)):
    u = db.get(models.User, uid)
    if not u or u.tenant_id != user.tenant_id: raise HTTPException(404)
    if role:
        if role not in ("admin", "member", "viewer"): raise HTTPException(400)
        u.role = role
    if team_id is not None:
        t = db.get(models.Team, team_id)
        if not t or t.tenant_id != user.tenant_id or t.deleted_at is not None:
            raise HTTPException(400, "team not found in this tenant")
        u.team_id = team_id
    db.commit()
    return {"id": u.id, "role": u.role, "team_id": u.team_id}


@app.delete("/users/{uid}")
def delete_user(uid: int,
                user: models.User = Depends(require_role("admin")),
                db: Session = Depends(get_db)):
    u = db.get(models.User, uid)
    if not u or u.tenant_id != user.tenant_id:
        raise HTTPException(404)
    if u.deleted_at is not None:
        return {"status": "already deleted", "user_id": uid}
    if u.id == user.id:
        raise HTTPException(400, "cannot delete yourself")
    u.deleted_at = datetime.utcnow()
    db.commit()
    return {"status": "deleted", "user_id": uid}


# ============================================================
# CLOUD ACCOUNTS
# ============================================================
@app.post("/tenants/{tid}/accounts")
def add_account(tid: int, provider: str, account_ref: str, env: str = "DEV",
                cloud_account_id: str = Query(None),
                credential_id: int = Query(None),
                user: models.User = Depends(require_role("admin")),
                db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)

    existing = db.query(models.CloudAccount).filter_by(
        tenant_id=tid, env=env, account_ref=account_ref).first()
    if existing:
        raise HTTPException(409, f"account '{account_ref}' already exists in {env}")

    if credential_id is None:
        root_cred = db.query(models.Credential).filter_by(
            tenant_id=tid, provider=provider, env=env).first()
        if root_cred:
            credential_id = root_cred.id

    a = models.CloudAccount(
        tenant_id=tid, provider=provider, account_ref=account_ref,
        cloud_account_id=cloud_account_id,
        env=env, state_key=f"tenants/{tid}/{env}/{account_ref}.tfstate",
        credential_id=credential_id,
    )
    db.add(a); db.commit(); db.refresh(a)
    return {"id": a.id, "provider": a.provider, "account_ref": a.account_ref,
            "cloud_account_id": a.cloud_account_id,
            "env": a.env, "state_key": a.state_key,
            "root_credential_id": a.credential_id}


@app.post("/accounts/{aid}/verify")
def verify_account(aid: int,
                   user: models.User = Depends(require_role("admin")),
                   db: Session = Depends(get_db)):
    account = db.get(models.CloudAccount, aid)
    if not account or account.tenant_id != user.tenant_id:
        raise HTTPException(404)
    if not account.cloud_account_id:
        raise HTTPException(400, "account has no cloud_account_id — nothing to verify")

    cred = db.get(models.Credential, account.credential_id) if account.credential_id else None
    if not cred:
        raise HTTPException(400, "no root credential for this account")

    try:
        env = credentials.env_for(cred, account.cloud_account_id)
    except Exception as e:
        return {"valid": False, "error": f"credential hop failed: {e}"}

    try:
        if account.provider == "aws":
            import boto3
            session = boto3.Session(
                aws_access_key_id=env["AWS_ACCESS_KEY_ID"],
                aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
                aws_session_token=env.get("AWS_SESSION_TOKEN"),
                region_name=env.get("AWS_DEFAULT_REGION", "us-east-1"),
            )
            ident = session.client("sts").get_caller_identity()
            if str(ident["Account"]) != str(account.cloud_account_id):
                return {
                    "valid": False,
                    "error": (
                        f"assumed into {ident['Account']} but target is "
                        f"{account.cloud_account_id}"
                    ),
                }
            session.client("s3").list_buckets()
        else:
            return {"valid": False, "error": f"verify not implemented for {account.provider}"}
    except Exception as e:
        return {"valid": False, "error": str(e)}

    return {"valid": True, "error": ""}

# ============================================================
# CREATE SUB-ACCOUNT (live cloud API call)
# ============================================================
@app.post("/tenants/{tid}/accounts/{aid}/create-subaccount")
def create_subaccount_endpoint(
    tid: int,
    aid: int,
    name: str,
    email: str = Query(None, description="Required for AWS (unique per org account)"),
    parent: str = Query(None, description="Required for GCP: 'folders/123' or 'organizations/456'"),
    billing_scope: str = Query(None, description="Required for Azure: full billing scope path"),
    user: models.User = Depends(require_role("admin")),
    db: Session = Depends(get_db),
):
    """
    Provision a NEW sub-account in the cloud provider using the tenant's root
    credential, then write the resulting native id back to the CloudAccount row.

    Supported today:
      - aws     → Organizations CreateAccount
      - gcp     → Cloud Resource Manager Projects Create
      - azure   → Subscription Alias (requires billing_scope)
      - alibaba → BSS OpenAPI CreateAgAccount

    Not supported (raises a clear 400):
      - oracle, ibm → create these in the provider console, then use
                       POST /tenants/{tid}/accounts (register existing)
    """
    if user.tenant_id != tid:
        raise HTTPException(403)

    account = db.get(models.CloudAccount, aid)
    if not account or account.tenant_id != tid:
        raise HTTPException(404, "account not found")

    if account.cloud_account_id:
        raise HTTPException(
            400,
            f"account already has a native id ({account.cloud_account_id}); "
            f"use 'Register existing' or verify it, don't create a new one"
        )

    cred = (
        db.get(models.Credential, account.credential_id)
        if account.credential_id
        else db.query(models.Credential).filter_by(
            tenant_id=tid, provider=account.provider, env=account.env
        ).first()
    )
    if not cred:
        raise HTTPException(
            400, "no root credential configured for this provider/env"
        )

    from . import subaccounts, credentials as credmod

    try:
        root_env = credmod.root_env_for(cred)
    except Exception as e:
        raise HTTPException(400, f"root credential failed: {e}")

    kwargs = {}
    if email:
        kwargs["email"] = email
    if parent:
        kwargs["parent"] = parent
    if billing_scope:
        kwargs["billing_scope"] = billing_scope

    try:
        native_id = subaccounts.create_subaccount(
            account.provider, root_env, name, **kwargs
        )
    except Exception as e:
        raise HTTPException(500, f"sub-account creation failed: {e}")

    # Persist so the UI can verify + import on the next refresh.
    account.cloud_account_id = native_id
    db.commit()
    db.refresh(account)

    return {
        "account_id": account.id,
        "provider": account.provider,
        "account_ref": account.account_ref,
        "cloud_account_id": native_id,
        "status": "created",
        "note": (
            "AWS returns the 12-digit id immediately but the account is "
            "IN_PROGRESS for ~1 minute. Retry 'Verify' after that."
            if account.provider == "aws"
            else "Native id written to the account row."
        ),
    }


@app.get("/tenants/{tid}/accounts")
def list_accounts(tid: int,
                  env: str = Query(None),
                  provider: str = Query(None),
                  team_id: int = Query(None),
                  page: int = Query(1, ge=1),
                  limit: int = Query(10, ge=1, le=100),
                  user: models.User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)

    allowed = visible_account_ids(user, db)
    q = db.query(models.CloudAccount).filter(
        models.CloudAccount.tenant_id == tid,
        models.CloudAccount.id.in_(allowed),
    )
    if env:
        q = q.filter(models.CloudAccount.env == env)
    if provider:
        q = q.filter(models.CloudAccount.provider == provider)

    if team_id is not None:
        q = q.join(
            models.TeamAccount,
            models.TeamAccount.account_id == models.CloudAccount.id,
        ).filter(models.TeamAccount.team_id == team_id)

    q = q.order_by(models.CloudAccount.id.desc())

    return paginated_response(q, page, limit, lambda a: {
        "id": a.id,
        "provider": a.provider,
        "account_ref": a.account_ref,
        "cloud_account_id": a.cloud_account_id,
        "env": a.env,
        "resource_count": db.query(func.count(models.InventoryResource.id))
                             .filter_by(account_id=a.id).scalar(),
    })


@app.get("/tenants/{tid}/accounts/grouped")
def grouped_accounts(tid: int, user: models.User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    allowed = visible_account_ids(user, db)
    accounts = db.query(models.CloudAccount).filter(
        models.CloudAccount.id.in_(allowed)).all()
    groups: dict = {}
    for a in accounts:
        groups.setdefault(a.provider, []).append({
            "id": a.id, "account_ref": a.account_ref,
            "cloud_account_id": a.cloud_account_id, "env": a.env,
            "resource_count": db.query(func.count(models.InventoryResource.id))
                                 .filter_by(account_id=a.id).scalar(),
        })
    return [{"provider": p, "count": len(v), "accounts": v}
            for p, v in groups.items()]


# ============================================================
# CREDENTIALS
# ============================================================
_SECRET_FIELDS: dict[str, tuple[str, ...]] = {
    "aws":        ("bootstrap_secret_access_key", "secret_access_key"),
    "azure":      ("client_secret",),
    "ibm":        ("api_key",),
    "alibaba":    ("access_key_secret",),
    "databricks": ("token",),
    "oracle":     ("private_key_pem",),
    "gcp":        (),
}


@app.post("/tenants/{tid}/credentials")
def store_credential(tid: int, provider: str, env: str, body: CredentialIn,
                     user: models.User = Depends(require_role("admin")),
                     db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)

    payload = dict(body.payload)

    for field in _SECRET_FIELDS.get(provider, ()):
        val = payload.get(field)
        if val and not val.startswith("gAAAAA"):
            payload[field] = encrypt_token(val)

    existing = db.query(models.Credential).filter_by(
        tenant_id=tid, provider=provider, env=env).first()

    if existing:
        existing.payload_json = payload
        existing.verified_at = None
        db.commit()
        return {"id": existing.id, "provider": existing.provider,
                "env": existing.env, "created": False}

    c = models.Credential(tenant_id=tid, provider=provider, env=env,
                          payload_json=payload)
    db.add(c); db.commit(); db.refresh(c)
    return {"id": c.id, "provider": c.provider, "env": c.env, "created": True}


@app.get("/tenants/{tid}/credentials")
def list_credentials(tid: int, user: models.User = Depends(require_role("admin")),
                     db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    return [{"id": c.id, "provider": c.provider, "env": c.env,
             "verified_at": c.verified_at}
            for c in db.query(models.Credential).filter_by(tenant_id=tid).all()]


@app.post("/tenants/{tid}/credentials/{cid}/verify")
def verify_credential(tid: int, cid: int,
                      user: models.User = Depends(require_role("admin")),
                      db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    cred = db.get(models.Credential, cid)
    if not cred or cred.tenant_id != tid: raise HTTPException(404)
    ok, err = credentials.verify_credential(cred)
    if ok:
        cred.verified_at = datetime.utcnow(); db.commit()
    return {"valid": ok, "error": err}


# ============================================================
# CUSTOM PARAMETERS
# ============================================================
@app.post("/tenants/{tid}/parameters")
def create_parameter(tid: int, provider: str, env: str, name: str, value: str,
                     user: models.User = Depends(require_role("admin")),
                     db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    p = models.CustomParameter(tenant_id=tid, provider=provider, env=env,
                               name=name, value=value)
    db.add(p); db.commit(); db.refresh(p)
    return {"id": p.id, "name": p.name, "env": p.env, "provider": p.provider}


@app.get("/tenants/{tid}/parameters")
def list_parameters(tid: int, provider: str = Query(None), env: str = Query(None),
                    user: models.User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    q = db.query(models.CustomParameter).filter_by(tenant_id=tid)
    if provider: q = q.filter_by(provider=provider)
    if env: q = q.filter_by(env=env)
    return [{"id": p.id, "name": p.name, "env": p.env,
             "provider": p.provider, "value": p.value} for p in q.all()]


# ============================================================
# WORKFLOWS
# ============================================================
@app.post("/tenants/{tid}/workflows")
def create_workflow(tid: int, body: WorkflowIn,
                    user: models.User = Depends(require_role("admin")),
                    db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    w = models.WorkflowDefinition(tenant_id=tid, name=body.name,
                                  steps_json=body.steps)
    db.add(w); db.commit(); db.refresh(w)
    return {"id": w.id, "name": w.name, "steps_json": w.steps_json}


@app.patch("/workflows/{wid}")
def update_workflow(wid: int, body: WorkflowIn,
                    user: models.User = Depends(require_role("admin")),
                    db: Session = Depends(get_db)):
    w = db.get(models.WorkflowDefinition, wid)
    if not w or w.tenant_id != user.tenant_id:
        raise HTTPException(404)
    w.name = body.name
    w.steps_json = body.steps
    db.commit()
    return {"id": w.id, "name": w.name, "steps_json": w.steps_json}


@app.get("/tenants/{tid}/workflows")
def list_workflows(tid: int, user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    return [{"id": w.id, "name": w.name, "steps_json": w.steps_json}
            for w in db.query(models.WorkflowDefinition).filter_by(tenant_id=tid).all()]


# ============================================================
# NLP PREVIEW
# ============================================================
@app.post("/tenants/{tid}/nlp")
def translate(tid: int, text: str,
              user: models.User = Depends(require_role("admin", "member")),
              db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    req = models.Request(tenant_id=tid, account_id=0, nlp_text=text, status="draft")
    db.add(req); db.commit(); db.refresh(req)
    try:
        result = nlp.nlp_to_terraform(tid, req.id, text)
    except Exception as e:
        req.status = "failed"; req.plan_summary = f"NLP failed: {e}"; db.commit()
        raise HTTPException(400, f"NLP failed: {e}")
    req.s3_prefix = result["s3_prefix"]; db.commit()
    return {"request_id": req.id, "s3_prefix": result["s3_prefix"],
            "hcl_preview": result.get("hcl_preview", "")}


# ============================================================
# REQUESTS (queued)
# ============================================================
@app.post("/tenants/{tid}/requests")
def submit_request(tid: int, account_id: int, nlp_text: str,
                   workflow_id: int = Query(None),
                   user: models.User = Depends(require_role("admin", "member")),
                   db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)
    account = db.get(models.CloudAccount, account_id)
    if not account or account.tenant_id != tid:
        raise HTTPException(404, "account not found")
    if not account.cloud_account_id:
        raise HTTPException(400, "account has no cloud_account_id")
    allowed = visible_account_ids(user, db)
    if account_id not in allowed:
        raise HTTPException(403, "account not in your team")

    # Resolve workflow now so total_steps is fixed at submit time.
    if workflow_id:
        wf = db.get(models.WorkflowDefinition, workflow_id)
        if not wf or wf.tenant_id != tid:
            raise HTTPException(400, "workflow not found in this tenant")
        steps = list(wf.steps_json or [])
    else:
        from .workflows import DEFAULT_STEPS
        steps = list(DEFAULT_STEPS)

    if not steps:
        raise HTTPException(400, "workflow has no steps")

    # NLP is part of the plan step, so generate the HCL now, before
    # enqueueing. This keeps the plan step deterministic.
    try:
        spec = nlp.nlp_to_terraform(tid, 0, nlp_text)   # provisional prefix
    except Exception as e:
        raise HTTPException(400, f"NLP failed: {e}")

    req = models.Request(
        tenant_id=tid,
        account_id=account_id,
        workflow_id=workflow_id,
        env=account.env,
        nlp_text=nlp_text,
        status="queued",
        current_step=0,
        total_steps=len(steps),
        s3_prefix=spec["s3_prefix"],
        requested_by=user.id,
        approvals_log=[],
    )
    db.add(req); db.commit(); db.refresh(req)
    enqueue(db, tid, "request_execute", req.id)
    return {
        "request_id": req.id,
        "status": "queued",
        "total_steps": req.total_steps,
    }


@app.post("/requests/{rid}/approve")
def approve_request(rid: int,
                    user: models.User = Depends(require_role("admin")),
                    db: Session = Depends(get_db)):
    req = db.get(models.Request, rid)
    if not req or req.tenant_id != user.tenant_id:
        raise HTTPException(404)
    if req.status != "awaiting_approval":
        raise HTTPException(400, f"request is not awaiting approval (status={req.status})")

    from .workflows import get_steps_for
    steps = get_steps_for(req, db)
    if req.current_step >= len(steps):
        raise HTTPException(400, "current_step is past end of workflow")
    step = steps[req.current_step]
    if step.get("type") != "approval":
        raise HTTPException(500, f"step {req.current_step} is not approval")

    approvers = [a.lower() for a in (step.get("approvers") or []) if a]
    if approvers and user.email.lower() not in approvers:
        raise HTTPException(403, f"{user.email} is not an approver for this step")

    # Record who approved this step
    log = list(req.approvals_log or [])
    log.append({"step": req.current_step, "user_id": user.id, "email": user.email,
                "at": datetime.utcnow().isoformat()})
    req.approvals_log = log
    req.approved_by = user.id
    req.current_step += 1
    req.status = "queued"
    db.commit()

    enqueue(db, req.tenant_id, "request_execute", req.id)
    return {"request_id": rid, "status": "queued", "current_step": req.current_step}


@app.post("/requests/{rid}/reject")
def reject_request(rid: int, reason: str = "",
                   user: models.User = Depends(require_role("admin")),
                   db: Session = Depends(get_db)):
    req = db.get(models.Request, rid)
    if not req or req.tenant_id != user.tenant_id:
        raise HTTPException(404)
    if req.status != "awaiting_approval":
        raise HTTPException(400, f"cannot reject in status '{req.status}'")
    req.status = "rejected"
    req.completed_at = datetime.utcnow()
    if reason:
        req.plan_summary = (req.plan_summary or "") + \
            f"\n\n[Rejected at step {req.current_step} by {user.email}: {reason}]"
    db.commit()
    return {"request_id": rid, "status": req.status}


@app.get("/requests/{rid}")
def get_request(rid: int,
                user: models.User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    req = db.get(models.Request, rid)
    if not req or req.tenant_id != user.tenant_id:
        raise HTTPException(404)

    # Non-admins can only read their own requests.
    if user.role != "admin" and getattr(req, "requested_by", None) != user.id:
        raise HTTPException(404)

    # Build the email map for this single row.
    rb = getattr(req, "requested_by", None)
    ab = getattr(req, "approved_by", None)
    ids = {i for i in (rb, ab) if i}
    emails = dict(
        db.query(models.User.id, models.User.email)
          .filter(models.User.id.in_(ids))
          .all()
    ) if ids else {}

    payload = _serialize_request(req, emails)

    # Add fields that only the detail endpoint returns.
    payload["plan"] = req.plan_summary
    payload["s3_prefix"] = req.s3_prefix

    # Resolve the workflow's step list (if any) so the UI can render
    # the exact steps this request is executing.
    steps = None
    if getattr(req, "workflow_id", None):
        wf = db.get(models.WorkflowDefinition, req.workflow_id)
        if wf:
            steps = wf.steps_json
    payload["workflow_steps"] = steps

    return payload



def _serialize_request(r, emails: dict) -> dict:
    """
    Shared request serializer for list_requests and get_request.

    `emails` is a { user_id: email } dict built by the caller from the
    requested_by / approved_by ids present on the rows being serialized.
    Passing it in avoids an N+1 query.
    """
    rb = getattr(r, "requested_by", None)
    ab = getattr(r, "approved_by", None)
    return {
        "id": r.id,
        "status": r.status,
        "env": r.env,
        "nlp_text": r.nlp_text,
        "account_id": r.account_id,
        "workflow_id": getattr(r, "workflow_id", None),
        "current_step": getattr(r, "current_step", 0),
        "total_steps": getattr(r, "total_steps", 0),
        "approvals_log": getattr(r, "approvals_log", []) or [],
        "requested_by": rb,
        "requested_by_email": emails.get(rb) if rb else None,
        "approved_by": ab,
        "approved_by_email": emails.get(ab) if ab else None,
        "additions": getattr(r, "plan_additions", 0),
        "changes": getattr(r, "plan_changes", 0),
        "destructions": getattr(r, "plan_destructions", 0),
        "completed_at": getattr(r, "completed_at", None),
        "created_at": r.created_at,
    }

@app.get("/tenants/{tid}/requests")
def list_requests(tid: int,
                  status: str = Query(None),
                  env: str = Query(None),
                  requested_by: int = Query(None),
                  page: int = Query(1, ge=1),
                  limit: int = Query(10, ge=1, le=100),
                  user: models.User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """
    List requests visible to the current user.

    Scope:
      admin  → every request in the tenant whose account is visible
               (visible_account_ids returns all accounts in the tenant
               for admins, so this is effectively "all requests").
      member → only their own submissions, on accounts attached to
               their team.

    Filters (status, env, requested_by) are ANDed on top.
    """
    if user.tenant_id != tid:
        raise HTTPException(403)

    allowed = visible_account_ids(user, db)
    q = db.query(models.Request).filter(models.Request.tenant_id == tid)

    if user.role != "admin":
        if not allowed:
            return {"items": [], "total": 0, "page": page,
                    "pages": 1, "limit": limit}
        q = q.filter(models.Request.account_id.in_(allowed))
        q = q.filter(models.Request.requested_by == user.id)
    else:
        if not allowed:
            return {"items": [], "total": 0, "page": page,
                    "pages": 1, "limit": limit}
        q = q.filter(models.Request.account_id.in_(allowed))
        if requested_by is not None:
            q = q.filter(models.Request.requested_by == requested_by)

    if status:
        q = q.filter(models.Request.status == status)
    if env:
        q = q.filter(models.Request.env == env)

    q = q.order_by(models.Request.created_at.desc().nullslast())

    total = q.order_by(None).count()
    pages = ceil(total / limit) if total else 1
    items = q.offset((page - 1) * limit).limit(limit).all()

    # Build the { user_id: email } map for this page in a single query.
    user_ids = set()
    for r in items:
        rb = getattr(r, "requested_by", None)
        ab = getattr(r, "approved_by", None)
        if rb:
            user_ids.add(rb)
        if ab:
            user_ids.add(ab)

    emails: dict[int, str] = {}
    if user_ids:
        emails = dict(
            db.query(models.User.id, models.User.email)
              .filter(models.User.id.in_(user_ids))
              .all()
        )

    return {
        "items": [_serialize_request(r, emails) for r in items],
        "total": total,
        "page": page,
        "pages": pages,
        "limit": limit,
    }


# ============================================================
# INVENTORY
# ============================================================
def _sync_inventory(db: Session, account: models.CloudAccount, env: dict):
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


@app.get("/tenants/{tid}/inventory")
def list_inventory(tid: int, account_id: int = Query(None), env: str = Query(None),
                   resource_type: str = Query(None),
                   user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    allowed = visible_account_ids(user, db)
    q = db.query(models.InventoryResource).filter(
        models.InventoryResource.tenant_id == tid,
        models.InventoryResource.account_id.in_(allowed),
    )
    if account_id: q = q.filter_by(account_id=account_id)
    if resource_type: q = q.filter_by(resource_type=resource_type)
    if env:
        env_accounts = [a.id for a in db.query(models.CloudAccount)
                        .filter_by(tenant_id=tid, env=env).all()]
        q = q.filter(models.InventoryResource.account_id.in_(env_accounts))
    return [{"id": r.id, "account_id": r.account_id,
             "resource_type": r.resource_type, "resource_id": r.resource_id,
             "cloud_native_id": r.cloud_native_id,
             "state": r.state, "meta": r.meta_json,
             "last_seen_at": r.last_seen_at}
            for r in q.all()]


@app.get("/accounts/{account_id}/resources")
def list_account_resources(account_id: int,
                           resource_type: str = Query(None),
                           page: int = Query(1, ge=1),
                           limit: int = Query(10, ge=1, le=100),
                           user: models.User = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    account = db.get(models.CloudAccount, account_id)
    if not account or account.tenant_id != user.tenant_id: raise HTTPException(404)
    allowed = visible_account_ids(user, db)
    if account_id not in allowed: raise HTTPException(403)

    q = db.query(models.InventoryResource).filter_by(account_id=account_id)
    if resource_type: q = q.filter_by(resource_type=resource_type)
    q = q.order_by(models.InventoryResource.id.desc())

    result = paginated_response(q, page, limit, lambda r: {
        "id": r.id,
        "resource_type": r.resource_type,
        "resource_id": r.resource_id,
        "cloud_native_id": r.cloud_native_id,
        "state": r.state,
        "meta": r.meta_json,
    })
    result["account_id"] = account_id
    result["provider"] = account.provider
    result["env"] = account.env
    return result


@app.get("/accounts/{account_id}/resources/{resource_id}")
def get_resource_detail(account_id: int, resource_id: str,
                        user: models.User = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    account = db.get(models.CloudAccount, account_id)
    if not account or account.tenant_id != user.tenant_id:
        raise HTTPException(404)
    if account_id not in visible_account_ids(user, db):
        raise HTTPException(403, "account not in your team")
    r = db.query(models.InventoryResource).filter_by(
        account_id=account_id, resource_id=resource_id).first()
    if not r: raise HTTPException(404)
    return {"id": r.id, "resource_type": r.resource_type,
            "resource_id": r.resource_id,
            "cloud_native_id": r.cloud_native_id,
            "state": r.state, "meta": r.meta_json}


@app.patch("/accounts/{aid}/resources/{rid}")
def edit_resource(aid: int, rid: str, changes: dict,
                  user: models.User = Depends(require_role("admin")),
                  db: Session = Depends(get_db)):
    account = db.get(models.CloudAccount, aid)
    if not account or account.tenant_id != user.tenant_id:
        raise HTTPException(404)
    if aid not in visible_account_ids(user, db):
        raise HTTPException(403, "account not in your team")
    r = db.query(models.InventoryResource).filter_by(
        account_id=aid, resource_id=rid).first()
    if not r: raise HTTPException(404)
    nlp = f"Update resource {rid} of type {r.resource_type} in place with: " + \
          ", ".join(f"{k}={v}" for k, v in changes.items())
    req = models.Request(
        tenant_id=r.tenant_id, account_id=aid, env=account.env,
        nlp_text=nlp, status="pending",
        requested_by=user.id,
    )
    db.add(req); db.commit(); db.refresh(req)
    return {"request_id": req.id, "status": req.status}


@app.post("/tenants/{tid}/inventory/sync")
def sync_inventory(tid: int, user: models.User = Depends(require_role("admin")),
                   db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    accounts = db.query(models.CloudAccount).filter_by(tenant_id=tid).all()
    synced = 0
    for a in accounts:
        cred = db.query(models.Credential).filter_by(
            tenant_id=tid, provider=a.provider, env=a.env).first()
        if not cred: continue
        try:
            env = credentials.env_for(cred, a.cloud_account_id)
            _sync_inventory(db, a, env); synced += 1
        except Exception:
            continue
    return {"accounts_synced": synced, "total": len(accounts)}


# ============================================================
# FINANCE
# ============================================================
@app.get("/accounts/{account_id}/finance")
def account_finance(account_id: int, days: int = 30,
                    user: models.User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    account = db.get(models.CloudAccount, account_id)
    if not account or account.tenant_id != user.tenant_id:
        raise HTTPException(404)
    allowed = visible_account_ids(user, db)
    if account_id not in allowed: raise HTTPException(403)
    since = datetime.utcnow() - timedelta(days=days)
    resources = db.query(models.InventoryResource).filter_by(
        account_id=account_id).all()
    rows = []
    total = 0.0
    for r in resources:
        cost = db.query(func.coalesce(func.sum(models.CostRecord.amount), 0.0)).filter(
            models.CostRecord.resource_id == r.resource_id,
            models.CostRecord.account_id == account_id,
            models.CostRecord.recorded_at >= since).scalar()
        rows.append({"resource_id": r.resource_id,
                     "resource_type": r.resource_type,
                     "cost": float(cost)})
        total += float(cost)
    return {"account_id": account_id, "provider": account.provider,
            "period_days": days, "total_cost": round(total, 2),
            "resources": rows}


@app.get("/tenants/{tid}/finance/resources")
def tenant_finance(tid: int, days: int = 30, env: str = Query(None),
                   provider: str = Query(None), team_id: int = Query(None),
                   user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)
    allowed = visible_account_ids(user, db)
    q = db.query(models.CloudAccount).filter(models.CloudAccount.id.in_(allowed))
    if env:
        q = q.filter(models.CloudAccount.env == env)
    if provider:
        q = q.filter(models.CloudAccount.provider == provider)
    if team_id is not None:
        q = q.join(
            models.TeamAccount,
            models.TeamAccount.account_id == models.CloudAccount.id,
        ).filter(models.TeamAccount.team_id == team_id)
    accounts = q.all()
    result = []
    grand = 0.0
    for acc in accounts:
        since = datetime.utcnow() - timedelta(days=days)
        cost = db.query(func.coalesce(func.sum(models.CostRecord.amount), 0.0)).filter(
            models.CostRecord.account_id == acc.id,
            models.CostRecord.recorded_at >= since).scalar()
        result.append({"account_id": acc.id, "provider": acc.provider,
                        "account_ref": acc.account_ref, "env": acc.env,
                        "cost": float(cost)})
        grand += float(cost)
    return {"tenant_id": tid, "period_days": days,
            "total_cost": round(grand, 2), "accounts": result}


@app.get("/tenants/{tid}/finance/summary")
def finance_summary(tid: int, days: int = 30,
                    user: models.User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)

    since = datetime.utcnow() - timedelta(days=days)

    per_account_rows = (
        db.query(models.CostRecord.account_id,
                 func.coalesce(func.sum(models.CostRecord.amount), 0.0))
          .filter(models.CostRecord.tenant_id == tid,
                  models.CostRecord.recorded_at >= since)
          .group_by(models.CostRecord.account_id)
          .all()
    )
    cost_by_account: dict[int, float] = {row[0]: float(row[1]) for row in per_account_rows}

    all_accounts = db.query(models.CloudAccount.id).filter_by(tenant_id=tid).all()
    all_account_ids = [r[0] for r in all_accounts]

    accounts_for_team: dict[int, list[int]] = {}
    for row in (
        db.query(models.TeamAccount.team_id, models.TeamAccount.account_id)
          .join(models.Team, models.Team.id == models.TeamAccount.team_id)
          .filter(models.Team.tenant_id == tid)
          .all()
    ):
        accounts_for_team.setdefault(row[0], []).append(row[1])

    teams = db.query(models.Team).filter_by(tenant_id=tid).all()
    assigned_ids: set[int] = set()
    out = []

    for team in teams:
        acct_ids = accounts_for_team.get(team.id, [])
        assigned_ids.update(acct_ids)

        team_cost = sum(cost_by_account.get(aid, 0.0) for aid in acct_ids)

        budget = db.query(models.Budget).filter_by(team_id=team.id).first()
        budget_amount = float(budget.monthly_amount) if budget else 0.0

        members = db.query(func.count(models.User.id)).filter_by(
            team_id=team.id).scalar() or 0

        util = round(100.0 * team_cost / budget_amount, 1) if budget_amount > 0 else None

        out.append({
            "team_id": team.id,
            "team_name": team.name,
            "user_count": int(members),
            "account_count": len(acct_ids),
            "budget": round(budget_amount, 2),
            "cost": round(team_cost, 2),
            "utilization": util,
        })

    unassigned_ids = [aid for aid in all_account_ids if aid not in assigned_ids]
    if unassigned_ids:
        unassigned_cost = sum(cost_by_account.get(aid, 0.0) for aid in unassigned_ids)
        out.append({
            "team_id": None,
            "team_name": "Unassigned",
            "user_count": 0,
            "account_count": len(unassigned_ids),
            "budget": 0.0,
            "cost": round(unassigned_cost, 2),
            "utilization": None,
        })

    return {
        "tenant_id": tid,
        "period_days": days,
        "teams": out,
    }


@app.get("/tenants/{tid}/finance/trend")
def cost_trend(tid: int, days: int = 30,
               user: models.User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    allowed = visible_account_ids(user, db)
    since = datetime.utcnow() - timedelta(days=days)
    rows = db.query(
        func.date_trunc('day', models.CostRecord.recorded_at).label('day'),
        func.sum(models.CostRecord.amount).label('total')
    ).filter(
        models.CostRecord.tenant_id == tid,
        models.CostRecord.account_id.in_(allowed),
        models.CostRecord.recorded_at >= since,
    ).group_by('day').order_by('day').all()
    return [{"date": str(r.day.date()), "amount": float(r.total)} for r in rows]


@app.get("/tenants/{tid}/finance/recommendations")
def recommendations(tid: int, user: models.User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)

    Optim = getattr(models, "OptimizationRecommendation", None)
    if Optim is None:
        # Table/model not present in this deployment — return empty rather
        # than 500. Add models.OptimizationRecommendation to models.py to
        # enable this feature.
        return []

    rows = db.query(Optim).filter_by(tenant_id=tid, status="open").all()
    return [{"id": r.id, "resource_id": r.resource_id,
             "finding": r.finding, "monthly_savings": r.monthly_savings,
             "effort": r.effort} for r in rows]


# ============================================================
# APPLICATIONS
# ============================================================
@app.post("/tenants/{tid}/applications")
def onboard_app(tid: int, repo_url: str, branch: str, cluster_id: int,
                namespace: str, release_name: str, env: str,
                repo_token: str = Query(None),
                user: models.User = Depends(require_role("admin", "member")),
                db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)
    cluster = db.get(models.CloudAccount, cluster_id)
    if not cluster or cluster.tenant_id != tid:
        raise HTTPException(404, "cluster not found")
    a = models.Application(
        tenant_id=tid, repo_url=repo_url, branch=branch,
        cluster_id=cluster_id, namespace=namespace,
        release_name=release_name, env=env, status="registered",
        repo_token=encrypt_token(repo_token) if repo_token else None,
    )
    db.add(a); db.commit(); db.refresh(a)
    return {"application_id": a.id, "status": a.status,
            "has_repo_token": a.repo_token is not None}


@app.patch("/applications/{aid}")
def update_application(aid: int,
                       branch: str = Query(None),
                       repo_token: str = Query(None),
                       user: models.User = Depends(require_role("admin", "member")),
                       db: Session = Depends(get_db)):
    a = db.get(models.Application, aid)
    if not a or a.tenant_id != user.tenant_id:
        raise HTTPException(404)
    if branch is not None:
        a.branch = branch
    if repo_token is not None:
        a.repo_token = encrypt_token(repo_token) if repo_token else None
    db.commit()
    return {"id": a.id, "branch": a.branch,
            "has_repo_token": a.repo_token is not None}


@app.get("/tenants/{tid}/applications")
def list_apps(tid: int, env: str = Query(None),
              page: int = Query(1, ge=1), limit: int = Query(10, ge=1, le=100),
              user: models.User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)
    allowed = visible_account_ids(user, db)
    q = db.query(models.Application).filter(
        models.Application.tenant_id == tid,
        models.Application.cluster_id.in_(allowed),
    )
    if env:
        q = q.filter_by(env=env)
    q = q.order_by(models.Application.id.desc())
    return paginated_response(q, page, limit, lambda a: {
        "id": a.id, "repo_url": a.repo_url, "branch": a.branch,
        "cluster_id": a.cluster_id, "namespace": a.namespace,
        "release_name": a.release_name, "env": a.env, "status": a.status,
        "has_repo_token": a.repo_token is not None,
    })


# ============================================================
# PIPELINES
# ============================================================
@app.post("/applications/{app_id}/deploy")
def trigger_deploy(app_id: int, commit_sha: str, image: str,
                   user: models.User = Depends(require_role("admin", "member")),
                   db: Session = Depends(get_db)):
    app_row = db.get(models.Application, app_id)
    if not app_row or app_row.tenant_id != user.tenant_id:
        raise HTTPException(404)
    run = models.PipelineRun(application_id=app_id, commit_sha=commit_sha,
                              image=image, status="queued")
    db.add(run); db.commit(); db.refresh(run)
    enqueue(db, app_row.tenant_id, "pipeline_deploy", run.id)
    return {"pipeline_run_id": run.id, "status": "queued"}


@app.get("/applications/{app_id}/pipelines")
def list_pipelines(app_id: int, user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    app_row = db.get(models.Application, app_id)
    if not app_row or app_row.tenant_id != user.tenant_id:
        raise HTTPException(404)
    runs = db.query(models.PipelineRun).filter_by(application_id=app_id)\
        .order_by(models.PipelineRun.started_at.desc()).all()
    return {"application_id": app_id, "repo_url": app_row.repo_url,
            "runs": [{"id": r.id, "commit_sha": r.commit_sha,
                      "image": r.image, "status": r.status,
                      "started_at": r.started_at,
                      "finished_at": r.finished_at,
                      "steps": r.steps_json} for r in runs]}


@app.get("/pipelines/{run_id}")
def get_pipeline(run_id: int, user: models.User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    r = db.get(models.PipelineRun, run_id)
    if not r: raise HTTPException(404)
    app_row = db.get(models.Application, r.application_id)
    if not app_row or app_row.tenant_id != user.tenant_id:
        raise HTTPException(403)
    return {"id": r.id, "application_id": r.application_id,
            "commit_sha": r.commit_sha, "image": r.image,
            "status": r.status, "started_at": r.started_at,
            "finished_at": r.finished_at, "steps": r.steps_json}


@app.get("/tenants/{tid}/pipelines/stats")
def pipeline_stats(tid: int, days: int = 7,
                   user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    if user.tenant_id != tid: raise HTTPException(403)
    allowed = visible_account_ids(user, db)
    since = datetime.utcnow() - timedelta(days=days)
    runs = db.query(models.PipelineRun).join(models.Application).filter(
        models.Application.tenant_id == tid,
        models.Application.cluster_id.in_(allowed),
        models.PipelineRun.started_at >= since,
    ).all()
    total = len(runs)
    ok = sum(1 for r in runs if r.status == "ok")
    failed = sum(1 for r in runs if r.status == "fail")
    return {"deploys": total,
            "success_rate": (ok / total * 100) if total else 0.0,
            "failed": failed}


# ============================================================
# HEALTH
# ============================================================
@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.utcnow()}


# ============================================================
# LICENSING
# ============================================================
@app.get("/license/status")
def license_status():
    info = get_current_license()
    if info is None:
        return {"valid": False, "reason": "missing or expired"}
    return {
        "valid": True,
        "customer": info.customer,
        "tier": info.tier,
        "max_resources": info.max_resources,
        "expires_at": info.expires_at.isoformat(),
        "days_remaining": info.days_remaining(),
    }


@app.post("/license/upload")
def upload_license(body: LicenseIn,
                   user: models.User = Depends(require_role("admin")),
                   db: Session = Depends(get_db)):
    info = verify_license_token(body.license_key)
    if info is None:
        raise HTTPException(400, "Invalid or expired license token")

    record = db.query(models.License).first()
    if record:
        record.license_key = body.license_key
        record.updated_at = datetime.utcnow()
    else:
        db.add(models.License(license_key=body.license_key))
    db.commit()

    invalidate_license_cache()

    return {
        "status": "updated",
        "customer": info.customer,
        "expires_at": info.expires_at.isoformat(),
        "days_remaining": info.days_remaining(),
    }


# ============================================================
# IMPORT EXISTING RESOURCES
# ============================================================
@app.post("/accounts/{account_id}/import/discover")
def discover_importable(account_id: int, body: ImportDiscoverIn,
                        user: models.User = Depends(require_role("admin")),
                        db: Session = Depends(get_db)):
    account = db.get(models.CloudAccount, account_id)
    if not account or account.tenant_id != user.tenant_id:
        raise HTTPException(404, "account not found")
    if not account.cloud_account_id:
        raise HTTPException(400,
            "account has no cloud_account_id — create or register the sub-account first")

    cred = db.get(models.Credential, account.credential_id) if account.credential_id else None
    if not cred:
        raise HTTPException(400, "no root credential configured for this account")

    from . import importer
    p = cred.payload_json

    try:
        if account.provider == "aws":
            env = credentials.aws_env_from_credential(cred, account.cloud_account_id)
            cred_dict = {
                "access_key_id": env.get("AWS_ACCESS_KEY_ID"),
                "secret_access_key": env.get("AWS_SECRET_ACCESS_KEY"),
                "session_token": env.get("AWS_SESSION_TOKEN"),
            }
            resources = importer.discover_aws(account.cloud_account_id,
                                              body.region, cred_dict)

        elif account.provider == "gcp":
            env = credentials.gcp_env_from_credential(cred, account.cloud_account_id)
            cred_dict = {
                "project_id": account.cloud_account_id,
                "wif_config": p.get("wif_config"),
            }
            resources = importer.discover_gcp(account.cloud_account_id, cred_dict)

        elif account.provider == "azure":
            cred_dict = {
                "tenant_id": p["tenant_id"],
                "client_id": p["client_id"],
                "client_secret": p["client_secret"],
                "subscription_id": account.cloud_account_id,
            }
            resources = importer.discover_azure([account.cloud_account_id], cred_dict)

        elif account.provider == "oracle":
            resources = importer.discover_oracle(account.cloud_account_id, p)

        elif account.provider == "ibm":
            resources = importer.discover_ibm(account.cloud_account_id, p)

        elif account.provider == "alibaba":
            resources = importer.discover_alibaba(p)

        else:
            raise HTTPException(400, f"Import not supported for {account.provider}")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Discovery failed: {e}")

    return {"account_id": account_id, "provider": account.provider,
            "resources": resources, "count": len(resources)}


@app.post("/accounts/{account_id}/import")
def start_import(account_id: int, body: ImportStartIn,
                 user: models.User = Depends(require_role("admin")),
                 db: Session = Depends(get_db)):
    account = db.get(models.CloudAccount, account_id)
    if not account or account.tenant_id != user.tenant_id:
        raise HTTPException(404, "account not found")
    if not account.cloud_account_id:
        raise HTTPException(400,
            "account has no cloud_account_id — create or register the sub-account first")

    cred = db.get(models.Credential, account.credential_id) if account.credential_id else None
    if not cred:
        raise HTTPException(400, "no root credential configured for this account")

    from . import importer
    p = cred.payload_json

    try:
        if account.provider == "aws":
            env = credentials.aws_env_from_credential(cred, account.cloud_account_id)
            cred_dict = {
                "access_key_id": env.get("AWS_ACCESS_KEY_ID"),
                "secret_access_key": env.get("AWS_SECRET_ACCESS_KEY"),
                "session_token": env.get("AWS_SESSION_TOKEN"),
            }
            all_resources = importer.discover_aws(account.cloud_account_id,
                                                  body.region, cred_dict)
            cred_env = env

        elif account.provider == "gcp":
            env = credentials.gcp_env_from_credential(cred, account.cloud_account_id)
            cred_dict = {
                "project_id": account.cloud_account_id,
                "wif_config": p.get("wif_config"),
            }
            all_resources = importer.discover_gcp(account.cloud_account_id, cred_dict)
            cred_env = env

        elif account.provider == "azure":
            cred_dict = {
                "tenant_id": p["tenant_id"],
                "client_id": p["client_id"],
                "client_secret": p["client_secret"],
                "subscription_id": account.cloud_account_id,
            }
            all_resources = importer.discover_azure([account.cloud_account_id], cred_dict)
            cred_env = credentials.azure_env_from_credential(cred, account.cloud_account_id)

        elif account.provider == "oracle":
            all_resources = importer.discover_oracle(account.cloud_account_id, p)
            cred_env = credentials.oracle_env_from_credential(cred, account.cloud_account_id)

        elif account.provider == "ibm":
            all_resources = importer.discover_ibm(account.cloud_account_id, p)
            cred_env = credentials.ibm_env_from_credential(cred, account.cloud_account_id)

        elif account.provider == "alibaba":
            all_resources = importer.discover_alibaba(p)
            cred_env = credentials.alibaba_env_from_credential(cred, account.cloud_account_id)

        else:
            raise HTTPException(400, f"Import not supported for {account.provider}")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Discovery failed: {e}")

    selected = [r for r in all_resources if r["id"] in body.resource_ids]
    if not selected:
        raise HTTPException(400, "No matching resources found")

    if len(selected) > MAX_IMPORT_BATCH:
        raise HTTPException(
            400,
            f"Too many resources in one request ({len(selected)}). "
            f"Split into batches of {MAX_IMPORT_BATCH} or fewer."
        )

    already = {r.cloud_native_id for r in db.query(models.InventoryResource)
               .filter_by(account_id=account_id)
               .filter(models.InventoryResource.cloud_native_id.isnot(None))
               .all()}
    selected = [r for r in selected if r["id"] not in already]
    if not selected:
        raise HTTPException(400, "All selected resources are already imported")

    req = models.Request(
        tenant_id=user.tenant_id, account_id=account_id, env=account.env,
        nlp_text=f"Import {len(selected)} existing {account.provider} resources",
        status="import_queued",
        requested_by=user.id,
    )
    db.add(req); db.commit(); db.refresh(req)

    try:
        result = importer.run_import(
            tenant_id=user.tenant_id,
            account_ref=account.cloud_account_id,
            provider=account.provider,
            region=body.region,
            cred_env=cred_env,
            resources=selected,
            import_id=f"req-{req.id}",
        )
    except Exception as e:
        req.status = "failed"
        req.plan_summary = f"Import generation failed: {e}"
        db.commit()
        raise HTTPException(500, f"Import generation failed: {e}")

    req.s3_prefix = result["s3_prefix"]
    db.commit()

    enqueue(db, user.tenant_id, "request_import_apply", req.id)

    return {
        "request_id": req.id,
        "status": "import_queued",
        "resource_count": result["resource_count"],
        "hcl_preview": result.get("hcl_preview", ""),
        "skipped_already_imported": len(body.resource_ids) - len(selected),
    }



# ============================================================
# recommendations
# ============================================================
@app.get("/tenants/{tid}/finance/recommendations")
def recommendations(tid: int,
                    status: str = Query("open"),
                    user: models.User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)

    Optim = getattr(models, "OptimizationRecommendation", None)
    if Optim is None:
        return []

    allowed = visible_account_ids(user, db)
    q = db.query(Optim).filter(
        Optim.tenant_id == tid,
        Optim.account_id.in_(allowed),
    )
    if status:
        q = q.filter(Optim.status == status)
    q = q.order_by(Optim.monthly_savings.desc())

    return [
        {
            "id": r.id,
            "account_id": r.account_id,
            "resource_id": r.resource_id,
            "rule": r.rule,
            "finding": r.finding,
            "monthly_savings": r.monthly_savings,
            "effort": r.effort,
            "status": r.status,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in q.all()
    ]


@app.patch("/tenants/{tid}/finance/recommendations/{rid}")
def dismiss_recommendation(tid: int, rid: int, status: str = Query("dismissed"),
                           user: models.User = Depends(require_role("admin")),
                           db: Session = Depends(get_db)):
    if user.tenant_id != tid:
        raise HTTPException(403)
    Optim = getattr(models, "OptimizationRecommendation", None)
    if Optim is None:
        raise HTTPException(404, "recommendations feature not enabled")
    rec = db.get(Optim, rid)
    if not rec or rec.tenant_id != tid:
        raise HTTPException(404)
    if status not in ("open", "dismissed", "resolved"):
        raise HTTPException(400, "status must be open | dismissed | resolved")
    rec.status = status
    db.commit()
    return {"id": rec.id, "status": rec.status}