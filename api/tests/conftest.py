"""Pytest fixtures for API tests."""

import pytest
from datastore.sqlite_store import SQLiteStore
from fastapi.testclient import TestClient
from main import app


@pytest.fixture
def client(tmp_path):
    """Create test client for API with an isolated temp database."""
    store = SQLiteStore()
    store.db_path = tmp_path / "test_rllm_ui.db"
    store.init_db()

    with TestClient(app) as test_client:
        app.state.store = store
        yield test_client
