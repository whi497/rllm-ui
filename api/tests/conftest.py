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

# Override auth dependency to return a fake user for all test requests.
_TEST_USER = {"id": "test-user", "email": "test@localhost", "name": "Test User", "api_key": "rllm_test"}


async def _mock_get_current_user():
    return _TEST_USER


app.dependency_overrides[auth.get_current_user] = _mock_get_current_user


@pytest.fixture
def client(tmp_path):
    """Create test client for API with an isolated temp database."""
    store = SQLiteStore()
    store.db_path = tmp_path / "test_rllm_ui.db"
    store.init_db()

    with TestClient(app) as test_client:
        app.state.store = store
        yield test_client
