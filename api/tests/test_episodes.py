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


def test_post_episode_stores_trajectory(client, test_session):
    """POST /api/episodes should store episode with trajectories including all fields."""
    episode_data = {
        "session_id": test_session["id"],
        "step": 1,
        "episode_id": "task1:0",
        "task": {"question": "What is 2+2?"},
        "is_correct": True,
        "reward": 1.0,
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
    assert data["reward"] == 1.0
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
                "reward": float(i),
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
        "reward": 0.5,
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
            "reward": 1.0,
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
            "reward": 1.0,
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
