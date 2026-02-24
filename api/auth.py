"""Auth utilities for rllm-ui cloud mode.

A single env var DEPLOYMENT_MODE (default "local") controls everything.
When "local", the app behaves exactly as today - no auth.
When "cloud", full auth is enforced.
"""

import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request

# ── Config constants ──────────────────────────────────────────────

DEPLOYMENT_MODE = os.environ.get("DEPLOYMENT_MODE", "local")  # "local" | "cloud"
IS_CLOUD = DEPLOYMENT_MODE == "cloud"
JWT_SECRET = os.environ.get("JWT_SECRET", "")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 72
COOKIE_NAME = "rllm_session"
API_KEY_HEADER = "X-API-Key"

# ── Password hashing ─────────────────────────────────────────────


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


# ── JWT ───────────────────────────────────────────────────────────

def create_jwt(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(UTC) + timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.now(UTC),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None


# ── API key ───────────────────────────────────────────────────────

def generate_api_key() -> str:
    return f"rllm_{uuid.uuid4().hex}"


# ── FastAPI dependency ────────────────────────────────────────────

async def get_current_user(request: Request) -> dict | None:
    """Core auth dependency.

    - If IS_CLOUD is False -> returns None (no auth enforced)
    - If IS_CLOUD is True -> checks X-API-Key header, then JWT cookie
    - Raises 401 if no valid auth found in cloud mode
    """
    if not IS_CLOUD:
        return None

    store = request.app.state.store

    # 1. Check API key header
    api_key = request.headers.get(API_KEY_HEADER)
    if api_key:
        user = store.get_user_by_api_key(api_key)
        if user:
            return user
        raise HTTPException(status_code=401, detail="Invalid API key")

    # 2. Check JWT cookie
    token = request.cookies.get(COOKIE_NAME)
    if token:
        payload = decode_jwt(token)
        if payload:
            user = store.get_user_by_id(payload["sub"])
            if user:
                return user
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    raise HTTPException(status_code=401, detail="Authentication required")


CurrentUser = Annotated[dict | None, Depends(get_current_user)]
