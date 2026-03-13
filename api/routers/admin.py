"""Admin router - superuser-only endpoints for user management and impersonation."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response

from auth import COOKIE_NAME, IS_CLOUD, CurrentUser, create_jwt
from models import AdminUserResponse

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _require_superuser(user: dict | None) -> dict:
    """Raise 403 if the user is not a superuser."""
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not user.get("is_superuser"):
        raise HTTPException(status_code=403, detail="Superuser access required")
    return user


# ------------------------------------------------------------------
# User management
# ------------------------------------------------------------------


@router.get("/users", response_model=list[AdminUserResponse])
def list_users(request: Request, user: CurrentUser):
    """List all users (superuser only)."""
    if not IS_CLOUD:
        raise HTTPException(status_code=404)
    _require_superuser(user)
    store = request.app.state.store
    rows = store.get_all_users()
    return [AdminUserResponse(**row) for row in rows]


# ------------------------------------------------------------------
# Impersonation
# ------------------------------------------------------------------


@router.post("/impersonate/{target_user_id}")
def impersonate(request: Request, response: Response, target_user_id: str, user: CurrentUser):
    """Start impersonating another user (superuser only).

    Issues a new JWT with the target user's identity but with an
    ``impersonator`` claim so the frontend can show a banner and
    the original session can be restored.
    """
    if not IS_CLOUD:
        raise HTTPException(status_code=404)
    su = _require_superuser(user)
    store = request.app.state.store

    target = store.get_user_by_id(target_user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    # Issue JWT as target user but with impersonator claim
    token = create_jwt(target["id"], target["email"], impersonator_id=su["id"])
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=72 * 3600,
    )
    return {"ok": True, "impersonating": target["email"]}


@router.post("/stop-impersonate")
def stop_impersonate(request: Request, response: Response, user: CurrentUser):
    """Stop impersonating and revert to the original superuser session."""
    if not IS_CLOUD:
        raise HTTPException(status_code=404)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    impersonator_id = user.get("impersonator_id")
    if not impersonator_id:
        raise HTTPException(status_code=400, detail="Not currently impersonating")

    store = request.app.state.store
    original = store.get_user_by_id(impersonator_id)
    if not original:
        raise HTTPException(status_code=404, detail="Original user not found")

    # Restore the original superuser session
    token = create_jwt(original["id"], original["email"])
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=72 * 3600,
    )
    return {"ok": True, "restored": original["email"]}
