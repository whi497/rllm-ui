"""Auth router - registration, login, logout, user info."""

import os

from fastapi import APIRouter, HTTPException, Request, Response

from auth import (
    COOKIE_NAME,
    IS_CLOUD,
    DEPLOYMENT_MODE,
    CurrentUser,
    create_jwt,
    generate_api_key,
    hash_password,
    verify_password,
)
from models import AuthConfigResponse, LoginRequest, RegisterRequest, UserResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])


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
    return AuthConfigResponse(auth_required=IS_CLOUD, deployment_mode=DEPLOYMENT_MODE, oauth_providers=providers)


@router.post("/register", response_model=UserResponse)
def register(request: Request, response: Response, body: RegisterRequest):
    """Create a new user account.

    Only available in cloud mode. Sets an httpOnly session cookie.
    """
    if not IS_CLOUD:
        raise HTTPException(status_code=404, detail="Registration not available in local mode")

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

    # Set session cookie
    token = create_jwt(user["id"], user["email"])
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=72 * 3600,
    )

    return UserResponse(id=user["id"], email=user["email"], name=user.get("name"), api_key=user["api_key"])


@router.post("/login", response_model=UserResponse)
def login(request: Request, response: Response, body: LoginRequest):
    """Authenticate with email and password.

    Sets an httpOnly session cookie on success.
    """
    if not IS_CLOUD:
        raise HTTPException(status_code=404, detail="Login not available in local mode")

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

    token = create_jwt(user["id"], user["email"])
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=72 * 3600,
    )

    return UserResponse(id=user["id"], email=user["email"], name=user.get("name"), api_key=user["api_key"])


@router.post("/logout")
def logout(response: Response, user: CurrentUser):
    """Clear the session cookie."""
    response.delete_cookie(key=COOKIE_NAME)
    return {"ok": True}


@router.post("/delete-account")
def delete_account(request: Request, response: Response, user: CurrentUser):
    """Delete the current user's account and all associated data.

    Only available in cloud mode. Clears the session cookie.
    """
    if not IS_CLOUD:
        raise HTTPException(status_code=404, detail="Not available in local mode")

    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    store = request.app.state.store
    store.delete_user(user["id"])

    response.delete_cookie(key=COOKIE_NAME)
    return {"ok": True}


@router.post("/api-key/regenerate")
def regenerate_api_key(request: Request, user: CurrentUser):
    """Generate a new API key, replacing the old one.

    The new key is returned once and cannot be retrieved again.
    """
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    store = request.app.state.store
    new_key = generate_api_key()
    updated = store.update_user_api_key(user["id"], new_key)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    return {"api_key": new_key}


@router.get("/me", response_model=UserResponse)
def get_current_user_info(user: CurrentUser):
    """Return the currently authenticated user's info + API key.

    In local mode (user is None), returns a placeholder.
    """
    if user is None:
        return UserResponse(id="local", email="local@localhost", name="Local User", api_key=None)

    return UserResponse(id=user["id"], email=user["email"], name=user.get("name"), api_key=user.get("api_key"))
