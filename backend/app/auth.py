import os
from datetime import datetime, timedelta
import jwt
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, Header
from sqlalchemy.orm import Session
from .db import get_db
from . import models

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGO = "HS256"
JWT_TTL_HOURS = 24


def hash_password(p: str) -> str:
    return pwd.hash(p)


def verify_password(p: str, h: str) -> bool:
    return pwd.verify(p, h)


def create_token(user: models.User) -> str:
    payload = {
        "sub": user.id, "email": user.email, "role": user.role,
        "tenant_id": user.tenant_id, "team_id": user.team_id,
        "exp": datetime.utcnow() + timedelta(hours=JWT_TTL_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)

def get_current_user(authorization: str = Header(None),
                     db: Session = Depends(get_db)) -> models.User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    try:
        payload = jwt.decode(authorization.split(" ", 1)[1], JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid token")
    user = db.get(models.User, payload["sub"])
    if not user:
        raise HTTPException(401, "user not found")

    # --- soft-delete enforcement ---
    if user.deleted_at is not None:
        raise HTTPException(401, "user disabled")
    if user.team_id is not None:
        team = db.get(models.Team, user.team_id)
        if team and team.deleted_at is not None:
            raise HTTPException(401, "user disabled")
    # --------------------------------

    return user


def require_role(*allowed):
    def _check(user: models.User = Depends(get_current_user)):
        if user.role not in allowed:
            raise HTTPException(403, f"role '{user.role}' not allowed")
        return user
    return _check


def visible_account_ids(user: models.User, db: Session) -> list[int]:
    """
    Admin: all accounts in tenant.
    Member/Viewer: accounts linked to their team.
    """
    if user.role == "admin":
        rows = db.query(models.CloudAccount.id).filter_by(tenant_id=user.tenant_id).all()
    else:
        if user.team_id is None:
            return []
        rows = db.query(models.CloudAccount.id).join(
            models.TeamAccount, models.TeamAccount.account_id == models.CloudAccount.id
        ).filter(models.TeamAccount.team_id == user.team_id).all()
    return [r[0] for r in rows]