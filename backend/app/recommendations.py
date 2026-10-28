"""
Cost optimization rules.

Runs after cost_ingest. Each rule scans cost_records + inventory_resources
for a tenant, and upserts open findings into optimization_recommendations.

Idempotent: re-running does not duplicate a finding that's already open
for the same (tenant, account, resource, rule).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from collections import defaultdict

from sqlalchemy import func
from sqlalchemy.orm import Session

from . import models


# ============================================================
# Thresholds — tune these per tenant tier later if needed
# ============================================================
IDLE_COST_THRESHOLD = 50.0          # $/30d before we flag an instance
ORPHANED_COST_THRESHOLD = 5.0       # $/30d before we flag missing inventory
HIGH_COST_THRESHOLD = 500.0         # $/30d before we flag "review this"
LOOKBACK_DAYS = 30


# ============================================================
# Helpers
# ============================================================
def _has_open(db: Session, tenant_id: int, account_id: int,
              resource_id: str, rule: str) -> bool:
    return db.query(models.OptimizationRecommendation).filter_by(
        tenant_id=tenant_id,
        account_id=account_id,
        resource_id=resource_id,
        rule=rule,
        status="open",
    ).first() is not None


def _add(db: Session, **kwargs) -> None:
    db.add(models.OptimizationRecommendation(**kwargs))


# ============================================================
# Rule 1 — idle compute
#
# Heuristic: any aws_instance / google_compute_instance / etc.
# whose 30-day cost is above IDLE_COST_THRESHOLD. Without CloudWatch
# CPU metrics this over-flags busy instances, so we also require that
# the instance type appears in a small "downsize candidate" set.
# ============================================================
DOWNSIZE_CANDIDATES = {
    # AWS — instance types that are usually overprovisioned
    "m5.4xlarge", "m5.2xlarge", "m5.xlarge",
    "m6i.4xlarge", "m6i.2xlarge", "m6i.xlarge",
    "c5.4xlarge", "c5.2xlarge", "c5.xlarge",
    "r5.4xlarge", "r5.2xlarge", "r5.xlarge",
    # GCP
    "n2-standard-16", "n2-standard-8", "n2-standard-4",
    "e2-standard-16", "e2-standard-8",
    # Azure
    "Standard_D8s_v5", "Standard_D4s_v5", "Standard_D2s_v5",
    "Standard_E8s_v5", "Standard_E4s_v5",
}

COMPUTE_TYPES = {
    "aws_instance",
    "google_compute_instance",
    "azurerm_linux_virtual_machine",
    "azurerm_windows_virtual_machine",
    "oci_core_instance",
    "ibm_is_instance",
    "alicloud_instance",
}


def _rule_idle_compute(db: Session, tenant_id: int) -> int:
    since = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    created = 0

    for res in db.query(models.InventoryResource).filter(
        models.InventoryResource.tenant_id == tenant_id,
        models.InventoryResource.resource_type.in_(COMPUTE_TYPES),
    ).all():
        meta = res.meta_json or {}
        itype = meta.get("instance_type") or meta.get("machine_type") or meta.get("size")
        if itype not in DOWNSIZE_CANDIDATES:
            continue

        cost_30d = db.query(
            func.coalesce(func.sum(models.CostRecord.amount), 0.0)
        ).filter(
            models.CostRecord.account_id == res.account_id,
            models.CostRecord.resource_id == res.resource_id,
            models.CostRecord.recorded_at >= since,
        ).scalar() or 0.0

        if cost_30d < IDLE_COST_THRESHOLD:
            continue

        if _has_open(db, tenant_id, res.account_id, res.resource_id, "idle-compute"):
            continue

        # Assume downsizing to the next size down saves ~50% — conservative.
        _add(
            db,
            tenant_id=tenant_id,
            account_id=res.account_id,
            resource_id=res.resource_id,
            rule="idle-compute",
            finding=(
                f"{res.resource_type} '{res.resource_id}' ({itype}) cost "
                f"${cost_30d:.0f} in {LOOKBACK_DAYS}d. "
                f"Consider downsizing by one tier."
            ),
            monthly_savings=round(cost_30d * 0.5, 2),
            effort="medium",
        )
        created += 1

    return created


# ============================================================
# Rule 2 — orphaned cost
#
# Any CostRecord with no matching InventoryResource. This catches
# spend CloudPilot is paying for but doesn't manage — abandoned
# resources, deleted-but-still-billing, resources outside Terraform.
# ============================================================
def _rule_orphaned_cost(db: Session, tenant_id: int) -> int:
    since = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    created = 0

    # Cost grouped by (account_id, resource_id) in the window
    rows = db.query(
        models.CostRecord.account_id,
        models.CostRecord.resource_id,
        func.coalesce(func.sum(models.CostRecord.amount), 0.0).label("total"),
    ).filter(
        models.CostRecord.tenant_id == tenant_id,
        models.CostRecord.recorded_at >= since,
        models.CostRecord.resource_id != "",
    ).group_by(
        models.CostRecord.account_id,
        models.CostRecord.resource_id,
    ).all()

    # Fast lookup: set of (account_id, resource_id) that have inventory rows
    inventory_pairs = {
        (r.account_id, r.resource_id)
        for r in db.query(
            models.InventoryResource.account_id,
            models.InventoryResource.resource_id,
        ).filter_by(tenant_id=tenant_id).all()
    }

    for account_id, resource_id, total in rows:
        total = float(total)
        if total < ORPHANED_COST_THRESHOLD:
            continue
        if (account_id, resource_id) in inventory_pairs:
            continue
        if _has_open(db, tenant_id, account_id, resource_id, "orphaned-cost"):
            continue

        _add(
            db,
            tenant_id=tenant_id,
            account_id=account_id,
            resource_id=resource_id,
            rule="orphaned-cost",
            finding=(
                f"${total:.0f} in {LOOKBACK_DAYS}d billed to '{resource_id}', "
                f"but no CloudPilot inventory tracks it. Investigate or tag it."
            ),
            monthly_savings=round(total * 0.1, 2),   # conservative 10% recovery
            effort="low",
        )
        created += 1

    return created


# ============================================================
# Rule 3 — high-cost resource
#
# Any single resource over HIGH_COST_THRESHOLD in the window gets
# a "review" finding. Not a specific waste pattern — just a signal
# that a human should look at it.
# ============================================================
def _rule_high_cost(db: Session, tenant_id: int) -> int:
    since = datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)
    created = 0

    rows = db.query(
        models.CostRecord.account_id,
        models.CostRecord.resource_id,
        models.CostRecord.resource_type,
        func.coalesce(func.sum(models.CostRecord.amount), 0.0).label("total"),
    ).filter(
        models.CostRecord.tenant_id == tenant_id,
        models.CostRecord.recorded_at >= since,
        models.CostRecord.resource_id != "",
    ).group_by(
        models.CostRecord.account_id,
        models.CostRecord.resource_id,
        models.CostRecord.resource_type,
    ).having(func.sum(models.CostRecord.amount) >= HIGH_COST_THRESHOLD).all()

    for account_id, resource_id, rtype, total in rows:
        if _has_open(db, tenant_id, account_id, resource_id, "high-cost"):
            continue
        _add(
            db,
            tenant_id=tenant_id,
            account_id=account_id,
            resource_id=resource_id,
            rule="high-cost",
            finding=(
                f"'{resource_id}' ({rtype or 'unknown'}) cost "
                f"${float(total):.0f} in {LOOKBACK_DAYS}d — review for rightsizing or commitment discount."
            ),
            monthly_savings=round(float(total) * 0.05, 2),
            effort="medium",
        )
        created += 1

    return created


# ============================================================
# Public entry point — call from cost_ingest after each ingest
# ============================================================
RULES = (
    _rule_idle_compute,
    _rule_orphaned_cost,
    _rule_high_cost,
)


def analyze_tenant(db: Session, tenant_id: int) -> dict:
    """
    Run every rule for one tenant. Commits once at the end.

    Returns { "idle-compute": N, "orphaned-cost": N, "high-cost": N, "total": N }
    so the caller can log how many findings were produced.
    """
    counts: dict[str, int] = {}
    for rule in RULES:
        name = rule.__name__.removeprefix("_rule_").replace("_", "-")
        try:
            counts[name] = rule(db, tenant_id)
        except Exception as e:
            # One rule failing shouldn't poison the others.
            db.rollback()
            counts[name] = -1
            print(f"[recommendations] tenant {tenant_id} rule {name} failed: {e}")

    db.commit()
    counts["total"] = sum(v for v in counts.values() if v > 0)
    return counts