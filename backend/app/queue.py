import os, uuid
from datetime import datetime, timedelta
from sqlalchemy import text
from .db import SessionLocal

WORKER_ID = f"{os.getenv('HOSTNAME', 'worker')}-{uuid.uuid4().hex[:8]}"
LEASE_MINUTES = 30


def enqueue(db, tenant_id: int, job_type: str, ref_id: int) -> int:
    """Insert a job row. Called inside the caller's transaction."""
    row = db.execute(text("""
        INSERT INTO jobs (tenant_id, job_type, ref_id, status, created_at)
        VALUES (:tid, :jt, :rid, 'queued', :now)
        RETURNING id
    """), {"tid": tenant_id, "jt": job_type, "rid": ref_id,
           "now": datetime.utcnow()}).fetchone()
    db.commit()
    return row[0]


def claim_one(db, worker_id: str = WORKER_ID) -> tuple | None:
    """Atomically claim one queued or expired job. Returns (id, job_type, ref_id) or None."""
    now = datetime.utcnow()
    row = db.execute(text("""
        UPDATE jobs
        SET status = 'running', claimed_by = :wid, claimed_at = :now,
            lease_expires = :lease
        WHERE id = (
            SELECT id FROM jobs
            WHERE status = 'queued'
               OR (status = 'running' AND lease_expires < :now)
            ORDER BY created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, job_type, ref_id
    """), {"wid": worker_id, "now": now,
           "lease": now + timedelta(minutes=LEASE_MINUTES)}).fetchone()
    db.commit()
    return (row[0], row[1], row[2]) if row else None


def mark_done(db, job_id: int, worker_id: str = WORKER_ID):
    db.execute(text("""
        UPDATE jobs SET status = 'done', lease_expires = NULL
        WHERE id = :id AND claimed_by = :wid
    """), {"id": job_id, "wid": worker_id})
    db.commit()


def mark_failed(db, job_id: int, error: str, worker_id: str = WORKER_ID):
    db.execute(text("""
        UPDATE jobs SET status = 'failed', error = :err, lease_expires = NULL
        WHERE id = :id AND claimed_by = :wid
    """), {"id": job_id, "err": error[:1000], "wid": worker_id})
    db.commit()