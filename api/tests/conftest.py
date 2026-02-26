"""Pytest fixtures for API tests."""

import os

# Force local mode before any app modules are imported (main.py calls load_dotenv()
# which may pick up DEPLOYMENT_MODE=cloud from a .env file).
os.environ["DEPLOYMENT_MODE"] = "local"

import auth  # noqa: E402
import pytest  # noqa: E402
from datastore.sqlite_store import SQLiteStore  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

# Patch the already-computed module-level flag so auth dependency skips checks.
auth.DEPLOYMENT_MODE = "local"
auth.IS_CLOUD = False


@pytest.fixture
def client(tmp_path):
    """Create test client for API with an isolated temp database."""
    store = SQLiteStore()
    store.db_path = tmp_path / "test_rllm_ui.db"
    store.init_db()

    with TestClient(app) as test_client:
        app.state.store = store
        yield test_client
