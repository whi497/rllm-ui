"""Tests for session endpoints."""


def test_create_session(client):
    """POST /api/sessions should create and return a session."""
    response = client.post("/api/sessions", json={"project": "test-project", "experiment": "run-1", "config": {"learning_rate": 0.001}})

    assert response.status_code == 200
    data = response.json()
    assert "id" in data
    assert data["project"] == "test-project"
    assert data["experiment"] == "run-1"
    assert "project_id" in data
    assert data["completed_at"] is None


def test_create_session_minimal(client):
    """POST /api/sessions should work with just project and experiment."""
    response = client.post("/api/sessions", json={"project": "test-project", "experiment": "run-1"})

    assert response.status_code == 200
    data = response.json()
    assert data["config"] is None


def test_list_sessions(client):
    """GET /api/sessions should list all sessions."""
    client.post("/api/sessions", json={"project": "project-1", "experiment": "run-1"})
    client.post("/api/sessions", json={"project": "project-2", "experiment": "run-2"})

    response = client.get("/api/sessions")

    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2


def test_get_session(client):
    """GET /api/sessions/{id} should return session details."""
    create_response = client.post("/api/sessions", json={"project": "test-project", "experiment": "run-1"})
    session_id = create_response.json()["id"]

    response = client.get(f"/api/sessions/{session_id}")

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == session_id
    assert data["project"] == "test-project"
    assert "project_id" in data


def test_get_session_not_found(client):
    """GET /api/sessions/{id} should return 404 for unknown session."""
    response = client.get("/api/sessions/nonexistent-id")

    assert response.status_code == 404


def test_complete_session(client):
    """POST /api/sessions/{id}/complete should mark session as completed."""
    create_response = client.post("/api/sessions", json={"project": "test-project", "experiment": "run-1"})
    session_id = create_response.json()["id"]

    response = client.post(f"/api/sessions/{session_id}/complete")

    assert response.status_code == 200
    data = response.json()
    assert data["completed_at"] is not None


# ── Project rename tests ─────────────────────────────────────────

def test_rename_project_success(client):
    """PATCH /api/sessions/projects/{id} should rename a project."""
    # Create a session (auto-creates project)
    create_resp = client.post("/api/sessions", json={"project": "old-name", "experiment": "run-1"})
    project_id = create_resp.json()["project_id"]

    # Rename
    response = client.patch(f"/api/sessions/projects/{project_id}", json={"new_name": "new-name"})
    assert response.status_code == 200
    assert response.json()["name"] == "new-name"

    # Verify session now shows new project name
    session_resp = client.get(f"/api/sessions/{create_resp.json()['id']}")
    assert session_resp.json()["project"] == "new-name"


def test_rename_project_not_found(client):
    """PATCH /api/sessions/projects/{id} should return 404 for unknown project."""
    response = client.patch("/api/sessions/projects/nonexistent", json={"new_name": "whatever"})
    assert response.status_code == 404


def test_rename_project_empty_name(client):
    """PATCH /api/sessions/projects/{id} should reject empty names."""
    create_resp = client.post("/api/sessions", json={"project": "my-proj", "experiment": "run-1"})
    project_id = create_resp.json()["project_id"]

    response = client.patch(f"/api/sessions/projects/{project_id}", json={"new_name": ""})
    assert response.status_code == 400

    response = client.patch(f"/api/sessions/projects/{project_id}", json={"new_name": "   "})
    assert response.status_code == 400


def test_rename_project_name_conflict(client):
    """PATCH /api/sessions/projects/{id} should fail if name already taken."""
    client.post("/api/sessions", json={"project": "project-a", "experiment": "run-1"})
    create_resp_b = client.post("/api/sessions", json={"project": "project-b", "experiment": "run-2"})
    project_b_id = create_resp_b.json()["project_id"]

    # Try to rename project-b to project-a (already exists)
    response = client.patch(f"/api/sessions/projects/{project_b_id}", json={"new_name": "project-a"})
    # Should fail with 500 (UNIQUE constraint) — acceptable for now
    assert response.status_code in (400, 500)


# ── Project delete tests ─────────────────────────────────────────

def test_delete_project_success(client):
    """DELETE /api/sessions/projects/{id} should delete project and cascade."""
    create_resp = client.post("/api/sessions", json={"project": "doomed", "experiment": "run-1"})
    project_id = create_resp.json()["project_id"]
    session_id = create_resp.json()["id"]

    # Add metrics and episodes to the session
    client.post("/api/metrics", json={"session_id": session_id, "step": 1, "data": {"loss": 0.5}})
    client.post("/api/episodes", json={
        "session_id": session_id,
        "step": 1,
        "episode_id": "ep-1",
        "task": {"question": "test"},
        "is_correct": True,
        "trajectories": [],
    })

    # Delete project
    response = client.delete(f"/api/sessions/projects/{project_id}")
    assert response.status_code == 200

    # Session should be gone
    session_resp = client.get(f"/api/sessions/{session_id}")
    assert session_resp.status_code == 404

    # Metrics endpoint returns 404 since session is gone
    metrics_resp = client.get(f"/api/sessions/{session_id}/metrics")
    assert metrics_resp.status_code == 404

    # Projects list should not contain it
    projects_resp = client.get("/api/sessions/projects")
    project_ids = [p["id"] for p in projects_resp.json()]
    assert project_id not in project_ids


def test_delete_project_not_found(client):
    """DELETE /api/sessions/projects/{id} should return 404."""
    response = client.delete("/api/sessions/projects/nonexistent")
    assert response.status_code == 404


# ── Session rename tests ─────────────────────────────────────────

def test_rename_session_success(client):
    """PATCH /api/sessions/{id} should rename experiment."""
    create_resp = client.post("/api/sessions", json={"project": "proj", "experiment": "old-exp"})
    session_id = create_resp.json()["id"]

    response = client.patch(f"/api/sessions/{session_id}", json={"new_experiment_name": "new-exp"})
    assert response.status_code == 200
    assert response.json()["experiment"] == "new-exp"


def test_rename_session_not_found(client):
    """PATCH /api/sessions/{id} should return 404."""
    response = client.patch("/api/sessions/nonexistent", json={"new_experiment_name": "whatever"})
    assert response.status_code == 404


def test_rename_session_empty_name(client):
    """PATCH /api/sessions/{id} should reject empty names."""
    create_resp = client.post("/api/sessions", json={"project": "proj", "experiment": "exp"})
    session_id = create_resp.json()["id"]

    response = client.patch(f"/api/sessions/{session_id}", json={"new_experiment_name": ""})
    assert response.status_code == 400


# ── Session color tests ──────────────────────────────────────────

def test_update_session_color(client):
    """PATCH /api/sessions/{id} should update color."""
    create_resp = client.post("/api/sessions", json={"project": "proj", "experiment": "exp"})
    session_id = create_resp.json()["id"]

    response = client.patch(f"/api/sessions/{session_id}", json={"color": "#dc2626"})
    assert response.status_code == 200
    assert response.json()["color"] == "#dc2626"

    # Verify it persists
    get_resp = client.get(f"/api/sessions/{session_id}")
    assert get_resp.json()["color"] == "#dc2626"


def test_update_session_color_and_name(client):
    """PATCH /api/sessions/{id} should update both name and color."""
    create_resp = client.post("/api/sessions", json={"project": "proj", "experiment": "old"})
    session_id = create_resp.json()["id"]

    response = client.patch(f"/api/sessions/{session_id}", json={
        "new_experiment_name": "new",
        "color": "#16a34a",
    })
    assert response.status_code == 200
    assert response.json()["experiment"] == "new"
    assert response.json()["color"] == "#16a34a"


def test_update_session_no_fields(client):
    """PATCH /api/sessions/{id} should reject when no fields provided."""
    create_resp = client.post("/api/sessions", json={"project": "proj", "experiment": "exp"})
    session_id = create_resp.json()["id"]

    response = client.patch(f"/api/sessions/{session_id}", json={})
    assert response.status_code == 400


# ── Session delete tests ─────────────────────────────────────────

def test_delete_session_success(client):
    """DELETE /api/sessions/{id} should delete session and cascade children."""
    create_resp = client.post("/api/sessions", json={"project": "proj", "experiment": "doomed-exp"})
    session_id = create_resp.json()["id"]

    # Add metrics
    client.post("/api/metrics", json={"session_id": session_id, "step": 1, "data": {"loss": 0.5}})

    # Delete session
    response = client.delete(f"/api/sessions/{session_id}")
    assert response.status_code == 200

    # Session gone
    assert client.get(f"/api/sessions/{session_id}").status_code == 404

    # Metrics endpoint returns 404 since session is gone
    metrics_resp = client.get(f"/api/sessions/{session_id}/metrics")
    assert metrics_resp.status_code == 404


def test_delete_session_not_found(client):
    """DELETE /api/sessions/{id} should return 404."""
    response = client.delete("/api/sessions/nonexistent")
    assert response.status_code == 404


# ── Projects list with IDs ───────────────────────────────────────

def test_list_projects_has_id(client):
    """GET /api/sessions/projects should return project IDs."""
    client.post("/api/sessions", json={"project": "my-project", "experiment": "run-1"})

    response = client.get("/api/sessions/projects")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert "id" in data[0]
    assert data[0]["project"] == "my-project"
    assert len(data[0]["sessions"]) == 1


def test_same_project_name_reuses_project(client):
    """Creating sessions with same project name should reuse the project."""
    resp1 = client.post("/api/sessions", json={"project": "shared", "experiment": "run-1"})
    resp2 = client.post("/api/sessions", json={"project": "shared", "experiment": "run-2"})

    assert resp1.json()["project_id"] == resp2.json()["project_id"]

    projects_resp = client.get("/api/sessions/projects")
    data = projects_resp.json()
    assert len(data) == 1
    assert len(data[0]["sessions"]) == 2
