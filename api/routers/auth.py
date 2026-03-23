"""Auth router - registration, login, logout, user info."""

import os

import local_settings
from fastapi import APIRouter, HTTPException, Request, Response

from auth import (
    COOKIE_NAME,
    DEPLOYMENT_MODE,
    LOCAL_DEV_USER,
    SECURE_COOKIES,
    CurrentUser,
    create_jwt,
    detect_team,
    generate_api_key,
    hash_password,
    is_superuser_email,
    verify_password,
)
from models import AuthConfigResponse, LoginRequest, RegisterRequest, UserResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_response(user: dict, *, impersonating: bool = False) -> UserResponse:
    """Build a UserResponse from a user dict, including team/superuser fields."""
    return UserResponse(
        id=user["id"],
        email=user["email"],
        name=user.get("name"),
        api_key=user.get("api_key"),
        team=user.get("team"),
        is_superuser=bool(user.get("is_superuser")),
        impersonating=impersonating,
    )


@router.get("/config", response_model=AuthConfigResponse)
def get_auth_config():
    """Returns whether auth is required and the deployment mode.

    Always public - the frontend calls this on mount to decide
    whether to show the login page.
    """
    providers = []
    if os.environ.get("GITHUB_CLIENT_ID"):
        providers.append("github")
    if os.environ.get("GOOGLE_CLIENT_ID"):
        providers.append("google")
    local_dev_login = DEPLOYMENT_MODE == "local"
    return AuthConfigResponse(auth_required=True, deployment_mode=DEPLOYMENT_MODE, oauth_providers=providers, local_dev_login=local_dev_login)


@router.post("/register", response_model=UserResponse)
def register(request: Request, response: Response, body: RegisterRequest):
    """Create a new user account. Sets an httpOnly session cookie."""
    store = request.app.state.store

    # Check if email already exists
    existing = store.get_user_by_email(body.email)
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    import uuid

    user_id = str(uuid.uuid4())
    password_hash = hash_password(body.password)
    api_key = generate_api_key()

    user = store.create_user(
        user_id=user_id,
        email=body.email,
        password_hash=password_hash,
        name=body.name,
        api_key=api_key,
    )

    # Auto-assign team from email domain
    team = detect_team(body.email)
    if team:
        store.update_user_team(user["id"], team)
        user["team"] = team

    # Set session cookie
    token = create_jwt(user["id"], user["email"])
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=SECURE_COOKIES,
        samesite="lax",
        max_age=72 * 3600,
    )

    return _user_response(user)


@router.post("/local-dev-login", response_model=UserResponse)
def local_dev_login(request: Request, response: Response):
    """One-click login for local development.

    Creates a default local user on first call, then logs them in.
    Only available when DEPLOYMENT_MODE is "local".
    """
    if DEPLOYMENT_MODE != "local":
        raise HTTPException(status_code=403, detail="Local dev login is only available in local mode")

    token = create_jwt(LOCAL_DEV_USER["id"], LOCAL_DEV_USER["email"], local_dev=True)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=SECURE_COOKIES,
        samesite="lax",
        max_age=72 * 3600,
    )

    return _user_response(LOCAL_DEV_USER)


@router.post("/login", response_model=UserResponse)
def login(request: Request, response: Response, body: LoginRequest):
    """Authenticate with email and password.

    Sets an httpOnly session cookie on success.
    """
    store = request.app.state.store

    user = store.get_user_by_email(body.email)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # OAuth-only users have no password_hash
    if not user.get("password_hash"):
        provider = user.get("oauth_provider", "OAuth")
        raise HTTPException(
            status_code=400,
            detail=f"This account uses {provider.title()} sign-in. Please use the '{provider.title()}' button to log in.",
        )

    if not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Backfill team if missing
    if not user.get("team"):
        team = detect_team(user["email"])
        if team:
            store.update_user_team(user["id"], team)
            user["team"] = team

    token = create_jwt(user["id"], user["email"])
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=SECURE_COOKIES,
        samesite="lax",
        max_age=72 * 3600,
    )

    return _user_response(user)


@router.post("/logout")
def logout(response: Response, user: CurrentUser):
    """Clear the session cookie."""
    response.delete_cookie(key=COOKIE_NAME)
    return {"ok": True}


@router.post("/delete-account")
def delete_account(request: Request, response: Response, user: CurrentUser):
    """Delete the current user's account and all associated data. Clears the session cookie."""
    store = request.app.state.store
    store.delete_user(user["id"])

    response.delete_cookie(key=COOKIE_NAME)
    return {"ok": True}


@router.post("/api-key/regenerate")
def regenerate_api_key(request: Request, user: CurrentUser):
    """Generate a new API key, replacing the old one.

    The new key is returned once and cannot be retrieved again.
    """
    store = request.app.state.store
    new_key = generate_api_key()
    updated = store.update_user_api_key(user["id"], new_key)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    return {"api_key": new_key}


@router.get("/me", response_model=UserResponse)
def get_current_user_info(user: CurrentUser):
    """Return the currently authenticated user's info + API key."""
    impersonating = "impersonator_id" in user
    return _user_response(user, impersonating=impersonating)
