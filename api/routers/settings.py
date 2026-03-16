"""Settings router — per-user key-value settings (cloud mode only)."""

from auth import CurrentUser
from encryption import encrypt_value, decrypt_value
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/settings", tags=["settings"])

ALLOWED_KEYS = {"anthropic_api_key"}


def _mask_anthropic_key(key: str) -> str:
    """Mask an Anthropic API key for display: sk-ant-...xxxx."""
    if len(key) <= 8:
        return "****"
    return key[:7] + "..." + key[-4:]


class SettingValue(BaseModel):
    value: str


@router.get("")
def get_settings(request: Request, user: CurrentUser):
    """Return all user settings with sensitive values masked."""
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")

    store = request.app.state.store
    encrypted_settings = store.get_user_settings(user["id"])

    result: dict[str, str | None] = {}
    for key in ALLOWED_KEYS:
        if key in encrypted_settings:
            try:
                decrypted = decrypt_value(encrypted_settings[key])
                if key == "anthropic_api_key":
                    result[key] = _mask_anthropic_key(decrypted)
                else:
                    result[key] = "****"
            except Exception:
                result[key] = "****"
        else:
            result[key] = None

    return result


@router.put("/{key}")
def set_setting(request: Request, key: str, body: SettingValue, user: CurrentUser):
    """Store a setting (encrypted at rest)."""
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    if key not in ALLOWED_KEYS:
        raise HTTPException(status_code=400, detail=f"Unknown setting: {key}")
    if not body.value.strip():
        raise HTTPException(status_code=400, detail="Value cannot be empty")

    store = request.app.state.store
    encrypted = encrypt_value(body.value.strip())
    store.set_user_setting(user["id"], key, encrypted)
    return {"ok": True}


@router.delete("/{key}")
def delete_setting(request: Request, key: str, user: CurrentUser):
    """Remove a setting."""
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    if key not in ALLOWED_KEYS:
        raise HTTPException(status_code=400, detail=f"Unknown setting: {key}")

    store = request.app.state.store
    deleted = store.delete_user_setting(user["id"], key)
    if not deleted:
        raise HTTPException(status_code=404, detail="Setting not found")
    return {"ok": True}
