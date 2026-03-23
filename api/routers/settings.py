"""Settings router — per-user key-value settings.

In cloud mode, settings are stored encrypted in PostgreSQL.
In local mode, settings are stored in a JSON file on the data volume.
"""

import local_settings
from auth import DEPLOYMENT_MODE, CurrentUser
from encryption import encrypt_value, decrypt_value
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/settings", tags=["settings"])

ALLOWED_KEYS = {"anthropic_api_key", "bq_project", "bq_dataset", "bq_table"}

# Keys whose values are shown in full (not sensitive)
_PLAINTEXT_KEYS = {"bq_project", "bq_dataset", "bq_table"}

_LOCAL_MODE = DEPLOYMENT_MODE == "local"


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

    if _LOCAL_MODE:
        all_settings = local_settings.get_all()
        return {key: all_settings.get(key) for key in ALLOWED_KEYS}

    store = request.app.state.store
    encrypted_settings = store.get_user_settings(user["id"])

    result: dict[str, str | None] = {}
    for key in ALLOWED_KEYS:
        if key in encrypted_settings:
            try:
                decrypted = decrypt_value(encrypted_settings[key])
                if key in _PLAINTEXT_KEYS:
                    result[key] = decrypted
                elif key == "anthropic_api_key":
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
    """Store a setting (encrypted at rest in cloud, plaintext JSON in local)."""
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    if key not in ALLOWED_KEYS:
        raise HTTPException(status_code=400, detail=f"Unknown setting: {key}")
    if not body.value.strip():
        raise HTTPException(status_code=400, detail="Value cannot be empty")

    if _LOCAL_MODE:
        local_settings.put(key, body.value.strip())
        # Re-initialize BigQuery client with new settings
        if key.startswith("bq_"):
            _reinit_bigquery(request)
        return {"ok": True}

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

    if _LOCAL_MODE:
        deleted = local_settings.delete(key)
        if not deleted:
            raise HTTPException(status_code=404, detail="Setting not found")
        if key.startswith("bq_"):
            _reinit_bigquery(request)
        return {"ok": True}

    store = request.app.state.store
    deleted = store.delete_user_setting(user["id"], key)
    if not deleted:
        raise HTTPException(status_code=404, detail="Setting not found")
    return {"ok": True}


def _reinit_bigquery(request: Request) -> None:
    """Re-initialize the global BigQuery client from local_settings."""
    project = local_settings.get("bq_project")
    if not project:
        request.app.state.bigquery = None
        return
    try:
        from datastore.bigquery_client import BigQueryClient

        dataset = local_settings.get("bq_dataset")
        table = local_settings.get("bq_table")
        request.app.state.bigquery = BigQueryClient(project=project, dataset=dataset, table=table)
    except Exception:
        request.app.state.bigquery = None
