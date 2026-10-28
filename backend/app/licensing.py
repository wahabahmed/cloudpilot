import json
import os
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from cryptography.hazmat.primitives import serialization
import jwt

# ============================================================
# YOUR PUBLIC KEY — paste the PEM from `vendor_public.pub` here.
# This is safe to commit; it can only verify, not sign.
# ============================================================
TRUSTED_PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADJ1fW5LnClgwEtyR0MLWqaWI3rEwg6z0AO1wPTbWZ2o=
-----END PUBLIC KEY-----"""


class LicenseInfo:
    def __init__(self, payload: dict):
        self.customer = payload.get("customer", "Unknown")
        self.expires_at = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        self.max_resources = payload.get("max_resources", 1000)
        self.tier = payload.get("tier", "basic")
        self.issued_at = datetime.fromtimestamp(payload.get("iat", 0), tz=timezone.utc)

    def is_valid(self) -> bool:
        return datetime.now(timezone.utc) < self.expires_at

    def days_remaining(self) -> int:
        delta = self.expires_at - datetime.now(timezone.utc)
        return max(0, delta.days)


def verify_license_token(token: str) -> Optional[LicenseInfo]:
    """Verify a JWT signed by the vendor's private key."""
    if not token:
        return None
    try:
        public_key = serialization.load_pem_public_key(TRUSTED_PUBLIC_KEY_PEM.encode())
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["EdDSA"],       # pinned algorithm — prevents alg confusion
            options={"verify_exp": False},  # we check expiry ourselves for grace period
        )
        info = LicenseInfo(payload)
        if not info.is_valid():
            return None
        return info
    except Exception as e:
        print(f"[license] verification failed: {e}")
        return None


# ============================================================
# Load from database with a short cache
# ============================================================
_cache = {"info": None, "at": 0.0}
CACHE_TTL = 60  # seconds


def load_license_from_db() -> Optional[LicenseInfo]:
    """Read the singleton license row from Postgres."""
    from .db import SessionLocal
    from . import models

    db = SessionLocal()
    try:
        record = db.query(models.License).first()
        if not record:
            return None
        return verify_license_token(record.license_key)
    finally:
        db.close()


def get_current_license() -> Optional[LicenseInfo]:
    """Cached lookup — refreshes at most once per CACHE_TTL seconds."""
    now = time.time()
    if _cache["info"] is None or now - _cache["at"] > CACHE_TTL:
        _cache["info"] = load_license_from_db()
        _cache["at"] = now
    return _cache["info"]


def invalidate_license_cache():
    """Call this after uploading a new license to force immediate refresh."""
    _cache["info"] = None
    _cache["at"] = 0.0


# ============================================================
# Middleware — blocks writes when license is missing/expired
# ============================================================
PUBLIC_PATHS = {
    "/health",
    "/auth/login",
    "/tenants",          # bootstrap endpoint — must work before any license exists
    "/license/status",
    "/license/upload",
    "/docs",
    "/openapi.json",
    "/redoc",
}


class LicenseMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Always allow public paths
        if path in PUBLIC_PATHS or path.startswith("/internal/"):
            return await call_next(request)

        info = get_current_license()

        if info is None:
            # Allow GETs (read-only) even without a valid license — but block writes
            if request.method != "GET":
                return JSONResponse(
                    {"detail": "License expired or missing. Upload a valid license to continue."},
                    status_code=403,
                )
        return await call_next(request)


# ============================================================
# Helper for route-level enforcement
# ============================================================
def require_license() -> LicenseInfo:
    """Use as a FastAPI dependency: Depends(require_license)."""
    info = get_current_license()
    if info is None:
        raise HTTPException(403, "License expired or missing")
    return info