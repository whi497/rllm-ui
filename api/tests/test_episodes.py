"""Tests for episode endpoints."""

import pytest


@pytest.fixture
def test_session(client):
    """Create a test session."""
    response = client.post(
        "/api/sessions",
        json={"project": "test-project", "experiment": "test-exp"},
    )
    return response.json()


@pytest.fixture
def eval_session(client):
    """Create a test eval session."""
    response = client.post(
        "/api/sessions",
        json={"project": "test-project", "experiment": "eval-run", "session_type": "eval"},
    )
    return response.json()


def test_post_episode_stores_trajectory(client, test_session):
    """POST /api/episodes should store episode with trajectories including all fields."""
    episode_data = {
        "session_id": test_session["id"],
        "step": 1,
        "episode_id": "task1:0",
        "task": {"question": "What is 2+2?"},
        "is_correct": True,
        "termination_reason": "success",
        "metrics": {"solve_time": 1.5, "num_steps": 1},
        "trajectories": [
            {
                "uid": "abc123",
                "reward": 1.0,
                "info": {"solver_type": "chain_of_thought"},
                "steps": [
                    {
                        "observation": "What is 2+2?",
                        "thought": "I need to add 2 and 2 together",
                        "action": "The answer is 4",
                        "reward": 1.0,
                        "done": True,
                        "mc_return": 1.0,
                        "advantage": 0.5,
                        "info": {"token_count": 10},
                        "chat_completions": [
                            {"role": "user", "content": "What is 2+2?"},
                            {"role": "assistant", "content": "The answer is 4"},
                        ],
                        "model_response": "The answer is 4",
                    }
                ],
            }
        ],
    }

    response = client.post("/api/episodes", json=episode_data)
    assert response.status_code == 200

    data = response.json()
    assert data["id"] == "task1:0"
    assert data["session_id"] == test_session["id"]
    assert data["step"] == 1
    assert data["is_correct"] is True
    assert data["termination_reason"] == "success"
    assert data["metrics"] == {"solve_time": 1.5, "num_steps": 1}
    assert data["task"] == {"question": "What is 2+2?"}
    assert "trajectories" in data
    assert len(data["trajectories"]) == 1

    # Verify trajectory-level fields round-trip
    traj = data["trajectories"][0]
    assert traj["info"] == {"solver_type": "chain_of_thought"}

    # Verify step-level fields round-trip
    step = traj["steps"][0]
    assert step["thought"] == "I need to add 2 and 2 together"
    assert step["info"] == {"token_count": 10}
    assert step["mc_return"] == 1.0
    assert step["advantage"] == 0.5


def test_post_episode_requires_valid_session(client):
    """POST /api/episodes should fail if session doesn't exist."""
    episode_data = {
        "session_id": "nonexistent",
        "step": 1,
        "episode_id": "task1:0",
        "task": {},
        "is_correct": True,
        "trajectories": [],
    }

    response = client.post("/api/episodes", json=episode_data)
    assert response.status_code == 404
    assert "Session not found" in response.json()["detail"]


def test_get_episodes_returns_all_for_session(client, test_session):
    """GET /api/episodes should return all episodes for a session."""
    # Create multiple episodes
    for i in range(3):
        client.post(
            "/api/episodes",
            json={
                "session_id": test_session["id"],
                "step": i,
                "episode_id": f"task{i}:0",
                "task": {"question": f"Question {i}"},
                "is_correct": i % 2 == 0,
                "trajectories": [],
            },
        )

    response = client.get(f"/api/episodes?session_id={test_session['id']}")
    assert response.status_code == 200

    episodes = response.json()
    assert len(episodes) == 3
    assert episodes[0]["id"] == "task0:0"


def test_get_episodes_requires_session_id(client):
    """GET /api/episodes should require session_id parameter."""
    response = client.get("/api/episodes")
    assert response.status_code == 422  # Validation error


def test_get_episode_by_id_returns_full_data(client, test_session):
    """GET /api/episodes/{id} should return full trajectory data."""
    episode_data = {
        "session_id": test_session["id"],
        "step": 1,
        "episode_id": "detailed-episode",
        "task": {"question": "Complex task"},
        "is_correct": False,
        "trajectories": [
            {
                "uid": "traj1",
                "reward": 0.5,
                "steps": [
                    {
                        "observation": "obs1",
                        "action": "act1",
                        "reward": 0.5,
                        "done": False,
                    },
                    {
                        "observation": "obs2",
                        "action": "act2",
                        "reward": 0.0,
                        "done": True,
                    },
                ],
            }
        ],
    }

    # Create episode
    client.post("/api/episodes", json=episode_data)

    # Get it back
    response = client.get("/api/episodes/detailed-episode")
    assert response.status_code == 200

    episode = response.json()
    assert episode["id"] == "detailed-episode"
    assert episode["is_correct"] is False
    assert len(episode["trajectories"]) == 1
    assert len(episode["trajectories"][0]["steps"]) == 2


def test_get_episode_not_found(client):
    """GET /api/episodes/{id} should return 404 for nonexistent episode."""
    response = client.get("/api/episodes/nonexistent")
    assert response.status_code == 404
    assert "Episode not found" in response.json()["detail"]


def test_search_episodes(client, test_session):
    """GET /api/episodes/search should find episodes by text content."""
    # Create episodes with distinct searchable text
    client.post(
        "/api/episodes",
        json={
            "session_id": test_session["id"],
            "step": 1,
            "episode_id": "search-python",
            "task": {"question": "What is Python?"},
            "is_correct": True,
            "trajectories": [
                {
                    "uid": "t1",
                    "reward": 1.0,
                    "steps": [
                        {
                            "observation": "Question about Python",
                            "action": "Python is a programming language",
                            "reward": 1.0,
                            "done": True,
                        }
                    ],
                }
            ],
        },
    )

    client.post(
        "/api/episodes",
        json={
            "session_id": test_session["id"],
            "step": 2,
            "episode_id": "search-java",
            "task": {"question": "What is Java?"},
            "is_correct": True,
            "trajectories": [
                {
                    "uid": "t2",
                    "reward": 1.0,
                    "steps": [
                        {
                            "observation": "Question about Java",
                            "action": "Java is also a programming language",
                            "reward": 1.0,
                            "done": True,
                        }
                    ],
                }
            ],
        },
    )

    # Search for "Python" - should find only the Python episode
    response = client.get("/api/episodes/search?q=Python")
    assert response.status_code == 200
    results = response.json()
    assert len(results["episodes"]) == 1
    assert results["episodes"][0]["id"] == "search-python"

    # Search for "programming" - should find both
    response = client.get("/api/episodes/search?q=programming")
    assert response.status_code == 200
    results = response.json()
    assert len(results["episodes"]) == 2


def test_search_episodes_with_session_filter(client, test_session):
    """GET /api/episodes/search should filter by session_id."""
    # Create an episode
    client.post(
        "/api/episodes",
        json={
            "session_id": test_session["id"],
            "step": 1,
            "episode_id": "filter-test",
            "task": {"question": "unique query text xyz123"},
            "is_correct": True,
            "trajectories": [],
        },
    )

    # Search with session filter
    response = client.get(f"/api/episodes/search?q=xyz123&session_id={test_session['id']}")
    assert response.status_code == 200
    results = response.json()
    assert len(results["episodes"]) == 1

    # Search with wrong session filter
    response = client.get("/api/episodes/search?q=xyz123&session_id=nonexistent")
    assert response.status_code == 200
    results = response.json()
    assert len(results["episodes"]) == 0


def test_post_eval_episode_preserves_all_fields(client, eval_session):
    """POST /api/episodes with session_type=eval should preserve types.Step fields."""
    episode_data = {
        "session_id": eval_session["id"],
        "session_type": "eval",
        "step": 0,
        "episode_id": "eval-task1:0",
        "task": {"question": "What is 2+2?", "ground_truth": 4},
        "is_correct": True,
        "metadata": {"model": "gpt-4o-mini", "agent": "math_agent"},
        "artifacts": {"answer": "The answer is 4"},
        "trajectories": [
            {
                "uid": "traj-uuid-1",
                "name": "solver",
                "reward": 1.0,
                "signals": {"accuracy": 1.0},
                "steps": [
                    {
                        "id": "step-uuid-1",
                        "input": "What is 2+2?",
                        "output": "The answer is \\boxed{4}",
                        "reward": 0.0,
                        "done": True,
                        "metadata": {"token_count": 42},
                    }
                ],
            }
        ],
    }

    response = client.post("/api/episodes", json=episode_data)
    assert response.status_code == 200

    data = response.json()
    assert data["id"] == "eval-task1:0"
    assert data["artifacts"] == {"answer": "The answer is 4"}
    assert data["metadata"] == {"model": "gpt-4o-mini", "agent": "math_agent"}

    # Verify trajectory-level eval fields
    traj = data["trajectories"][0]
    assert traj["name"] == "solver"
    assert traj["signals"] == {"accuracy": 1.0}

    # Verify step-level eval fields preserved (not remapped to observation/model_response)
    step = traj["steps"][0]
    assert step["input"] == "What is 2+2?"
    assert step["output"] == "The answer is \\boxed{4}"
    assert step["metadata"] == {"token_count": 42}
    # These training-only fields should NOT be present
    assert "observation" not in step or step.get("observation") is None
    assert "model_response" not in step or step.get("model_response") is None


def test_eval_episode_search_indexes_input_output(client, eval_session):
    """Search should index eval step fields (input/output) not just training fields."""
    client.post(
        "/api/episodes",
        json={
            "session_id": eval_session["id"],
            "session_type": "eval",
            "step": 0,
            "episode_id": "eval-search-test",
            "task": {"question": "unique_eval_searchterm"},
            "is_correct": True,
            "trajectories": [
                {
                    "uid": "t1",
                    "name": "solver",
                    "steps": [
                        {
                            "input": "eval_specific_input_xyz",
                            "output": "eval_specific_output_abc",
                            "done": True,
                        }
                    ],
                }
            ],
        },
    )

    # Should find by input text
    response = client.get(f"/api/episodes/search?q=eval_specific_input_xyz&session_id={eval_session['id']}")
    assert response.status_code == 200
    results = response.json()
    assert len(results["episodes"]) == 1
    assert results["episodes"][0]["id"] == "eval-search-test"

    # Should find by output text
    response = client.get(f"/api/episodes/search?q=eval_specific_output_abc&session_id={eval_session['id']}")
    assert response.status_code == 200
    results = response.json()
    assert len(results["episodes"]) == 1


def test_training_episode_still_works_after_schema_change(client, test_session):
    """Training episodes with AgentStep fields should still work correctly."""
    episode_data = {
        "session_id": test_session["id"],
        "session_type": "training",
        "step": 1,
        "episode_id": "training-compat-test",
        "task": {"question": "Compat test"},
        "is_correct": True,
        "trajectories": [
            {
                "uid": "t1",
                "reward": 1.0,
                "info": {"solver": "cot"},
                "steps": [
                    {
                        "observation": "Compat test question",
                        "thought": "Let me think...",
                        "model_response": "Answer is 42",
                        "action": "submit(42)",
                        "reward": 1.0,
                        "done": True,
                        "mc_return": 0.95,
                        "advantage": 0.3,
                    }
                ],
            }
        ],
    }

    response = client.post("/api/episodes", json=episode_data)
    assert response.status_code == 200

    data = response.json()
    step = data["trajectories"][0]["steps"][0]
    assert step["observation"] == "Compat test question"
    assert step["model_response"] == "Answer is 42"
    assert step["mc_return"] == 0.95
    assert step["advantage"] == 0.3


def test_batch_post_training_episode_accepts_categorical_signals(client, test_session):
    """Training episodes may include non-numeric trajectory signals such as ALFWorld task_type."""
    episode_data = {
        "session_id": test_session["id"],
        "session_type": "training",
        "step": 1,
        "episode_id": "training-signal-test",
        "task": {"question": "ALFWorld task"},
        "is_correct": False,
        "trajectories": [
            {
                "uid": "traj-with-task-type",
                "reward": 0.0,
                "signals": {
                    "accuracy": 0.0,
                    "task_type": "pick_and_place_simple",
                },
                "steps": [
                    {
                        "observation": "You are in the middle of a room.",
                        "action": "look",
                        "reward": 0.0,
                        "done": False,
                    }
                ],
            }
        ],
    }

    response = client.post(
        "/api/episodes/batch",
        json={"session_id": test_session["id"], "episodes": [episode_data]},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "count": 1}

    response = client.get(f"/api/episodes?session_id={test_session['id']}")
    assert response.status_code == 200
    [episode] = [ep for ep in response.json() if ep["id"] == "training-signal-test"]
    assert episode["trajectories"][0]["signals"] == {
        "accuracy": 0.0,
        "task_type": "pick_and_place_simple",
    }
