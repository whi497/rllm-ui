"""OAuth router - GitHub and Google OAuth login/registration."""

import os
import secrets
import uuid

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from auth import COOKIE_NAME, IS_CLOUD, create_jwt, generate_api_key

router = APIRouter(prefix="/api/oauth", tags=["oauth"])

# ── Provider config ──────────────────────────────────────────────

GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")

OAUTH_STATE_COOKIE = "oauth_state"


def _get_frontend_url(request: Request) -> str:
    """Derive the frontend URL from CORS_ORIGINS or fall back to request base URL."""
    cors_origins = os.environ.get("CORS_ORIGINS", "")
    if cors_origins:
        return cors_origins.split(",")[0].strip()
    origin = request.headers.get("origin")
    if origin:
        return origin
    return str(request.base_url).rstrip("/")


def _get_callback_url(request: Request, provider: str) -> str:
    """Build the OAuth callback URL from the request base URL."""
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/oauth/{provider}/callback"


# ── GitHub ───────────────────────────────────────────────────────

@router.get("/github/authorize")
def github_authorize(request: Request):
    """Redirect to GitHub's OAuth authorization page."""
    if not IS_CLOUD:
        raise HTTPException(status_code=404, detail="OAuth not available in local mode")
    if not GITHUB_CLIENT_ID:
        raise HTTPException(status_code=500, detail="GitHub OAuth not configured")

    state = secrets.token_urlsafe(32)
    redirect_uri = _get_callback_url(request, "github")

    github_url = (
        f"https://github.com/login/oauth/authorize"
        f"?client_id={GITHUB_CLIENT_ID}"
        f"&redirect_uri={redirect_uri}"
        f"&scope=user:email"
        f"&state={state}"
    )

    response = RedirectResponse(url=github_url)
    response.set_cookie(
        key=OAUTH_STATE_COOKIE,
        value=state,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=600,
    )
    return response


@router.get("/github/callback")
async def github_callback(request: Request, code: str = "", state: str = ""):
    """Handle GitHub OAuth callback."""
    if not IS_CLOUD:
        raise HTTPException(status_code=404, detail="OAuth not available in local mode")

    # Validate state
    stored_state = request.cookies.get(OAUTH_STATE_COOKIE)
    if not stored_state or stored_state != state:
        raise HTTPException(status_code=400, detail="Invalid OAuth state")

    # Exchange code for access token
    async with httpx.AsyncClient() as client:
        token_res = await client.post(
            "https://github.com/login/oauth/access_token",
            data={
                "client_id": GITHUB_CLIENT_ID,
                "client_secret": GITHUB_CLIENT_SECRET,
                "code": code,
                "redirect_uri": _get_callback_url(request, "github"),
            },
            headers={"Accept": "application/json"},
        )
        if token_res.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to exchange code with GitHub")

        token_data = token_res.json()
        access_token = token_data.get("access_token")
        if not access_token:
            raise HTTPException(status_code=502, detail=f"GitHub OAuth error: {token_data.get('error_description', 'no access token')}")

        # Fetch user profile
        headers = {"Authorization": f"Bearer {access_token}"}
        user_res = await client.get("https://api.github.com/user", headers=headers)
        if user_res.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch GitHub user info")
        gh_user = user_res.json()

        # Fetch verified email
        emails_res = await client.get("https://api.github.com/user/emails", headers=headers)
        email = None
        if emails_res.status_code == 200:
            for e in emails_res.json():
                if e.get("verified") and e.get("primary"):
                    email = e["email"]
                    break
            if not email:
                for e in emails_res.json():
                    if e.get("verified"):
                        email = e["email"]
                        break

        if not email:
            email = gh_user.get("email")
        if not email:
            raise HTTPException(status_code=400, detail="Could not retrieve a verified email from GitHub")

    provider_id = str(gh_user["id"])
    name = gh_user.get("name") or gh_user.get("login")

    response = await _find_or_create_user(request, "github", provider_id, email, name)
    # Clear state cookie
    response.delete_cookie(key=OAUTH_STATE_COOKIE)
    return response


# ── Google ───────────────────────────────────────────────────────

@router.get("/google/authorize")
def google_authorize(request: Request):
    """Redirect to Google's OAuth authorization page."""
    if not IS_CLOUD:
        raise HTTPException(status_code=404, detail="OAuth not available in local mode")
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="Google OAuth not configured")

    state = secrets.token_urlsafe(32)
    redirect_uri = _get_callback_url(request, "google")

    google_url = (
        f"https://accounts.google.com/o/oauth2/v2/auth"
        f"?client_id={GOOGLE_CLIENT_ID}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code"
        f"&scope=openid%20email%20profile"
        f"&state={state}"
    )

    response = RedirectResponse(url=google_url)
    response.set_cookie(
        key=OAUTH_STATE_COOKIE,
        value=state,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=600,
    )
    return response


@router.get("/google/callback")
async def google_callback(request: Request, code: str = "", state: str = ""):
    """Handle Google OAuth callback."""
    if not IS_CLOUD:
        raise HTTPException(status_code=404, detail="OAuth not available in local mode")

    # Validate state
    stored_state = request.cookies.get(OAUTH_STATE_COOKIE)
    if not stored_state or stored_state != state:
        raise HTTPException(status_code=400, detail="Invalid OAuth state")

    # Exchange code for access token
    async with httpx.AsyncClient() as client:
        token_res = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": _get_callback_url(request, "google"),
                "grant_type": "authorization_code",
            },
        )
        if token_res.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to exchange code with Google")

        token_data = token_res.json()
        access_token = token_data.get("access_token")
        if not access_token:
            raise HTTPException(status_code=502, detail="Google OAuth error: no access token")

        # Fetch user info
        user_res = await client.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if user_res.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch Google user info")
        google_user = user_res.json()

    email = google_user.get("email")
    if not email or not google_user.get("email_verified"):
        raise HTTPException(status_code=400, detail="Could not retrieve a verified email from Google")

    provider_id = google_user["sub"]
    name = google_user.get("name")

    response = await _find_or_create_user(request, "google", provider_id, email, name)
    # Clear state cookie
    response.delete_cookie(key=OAUTH_STATE_COOKIE)
    return response


# ── Shared helper ────────────────────────────────────────────────

async def _find_or_create_user(
    request: Request,
    provider: str,
    provider_id: str,
    email: str,
    name: str | None,
) -> RedirectResponse:
    """Find or create a user from OAuth, set JWT cookie, redirect to frontend."""
    store = request.app.state.store
    frontend_url = _get_frontend_url(request)
    is_new = False

    # 1. Check if user already linked via this OAuth provider
    user = store.get_user_by_oauth(provider, provider_id)

    if not user:
        # 2. Check if email matches an existing account -> auto-link
        user = store.get_user_by_email(email)
        if user:
            store.link_oauth_to_user(user["id"], provider, provider_id)
            # Refresh user data
            user = store.get_user_by_id(user["id"])
        else:
            # 3. Create new user
            user = store.create_oauth_user(
                user_id=str(uuid.uuid4()),
                email=email,
                name=name,
                api_key=generate_api_key(),
                oauth_provider=provider,
                oauth_provider_id=provider_id,
            )
            is_new = True

    token = create_jwt(user["id"], user["email"])
    redirect_url = f"{frontend_url}/?welcome=1" if is_new else frontend_url

    response = RedirectResponse(url=redirect_url, status_code=302)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=72 * 3600,
    )
    return response
