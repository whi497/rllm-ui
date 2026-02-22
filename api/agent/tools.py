"""Tool definitions and implementations for the Observability Agent."""

from typing import Any

from datastore.base import DataStore

# Tool definitions for Anthropic function calling
TOOL_DEFINITIONS = [
    {
        "name": "get_session_info",
        "description": "Get session configuration and metadata including project name, experiment name, config, and timestamps. Use this to understand the training setup.",
        "input_schema": {
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "The session ID to query",
                }
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "get_metrics",
        "description": "Retrieve training metrics for a session. Returns metrics like reward/mean, loss/policy, episode/accuracy, etc. Can optionally filter by step range.",
        "input_schema": {
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "The session ID to query",
                },
                "start_step": {
                    "type": "integer",
                    "description": "Optional: Only return metrics from this step onwards",
                },
                "end_step": {
                    "type": "integer",
                    "description": "Optional: Only return metrics up to this step",
                },
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "get_episodes",
        "description": "Retrieve episode summaries for a session. Returns task, correctness, termination_reason, and metrics — but NOT full trajectory data (use get_trajectory for that). Can filter by step or correctness.",
        "input_schema": {
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "The session ID to query",
                },
                "step": {
                    "type": "integer",
                    "description": "Optional: Only return episodes from this specific step",
                },
                "is_correct": {
                    "type": "boolean",
                    "description": "Optional: Filter by correctness (true for correct, false for incorrect)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of episodes to return (default: 20)",
                },
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "get_trajectory",
        "description": "Get the full trajectory details for a specific episode. Returns all steps with observations, thoughts, actions, model responses, rewards, mc_return, and advantage. Use trajectory_name to get only a specific trajectory (e.g. 'solver'). Use start_step/end_step to limit the step range.",
        "input_schema": {
            "type": "object",
            "properties": {
                "episode_id": {
                    "type": "string",
                    "description": "The episode ID to retrieve",
                },
                "trajectory_name": {
                    "type": "string",
                    "description": "Optional: Only return the trajectory with this name (e.g. 'solver', 'judge')",
                },
                "start_step": {
                    "type": "integer",
                    "description": "Optional: Only return steps from this index onwards (0-based)",
                },
                "end_step": {
                    "type": "integer",
                    "description": "Optional: Only return steps up to this index (exclusive, 0-based)",
                },
            },
            "required": ["episode_id"],
        },
    },
    {
        "name": "search_episodes",
        "description": "Full-text search across episode content including tasks, observations, thoughts, actions, and model responses. Use this to find episodes mentioning specific terms or patterns.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query (supports full-text search)",
                },
                "session_id": {
                    "type": "string",
                    "description": "Optional: Limit search to a specific session",
                },
                "step": {
                    "type": "integer",
                    "description": "Optional: Limit search to a specific step",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of results (default: 20)",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_trajectory_groups",
        "description": "List trajectory groups for a session, optionally filtered by step. Groups show how different rollouts of the same task compare. Returns summaries with avg_reward — useful for finding tasks with low reward or high variance.",
        "input_schema": {
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "The session ID to query",
                },
                "step": {
                    "type": "integer",
                    "description": "Optional: Only return groups from this specific step",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of groups to return (default: 20)",
                },
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "get_trajectory_group",
        "description": "Get a specific trajectory group with per-trajectory summaries (episode_id, reward, num_steps) — but NOT full step data. Use this to see which rollouts succeeded/failed, then use get_trajectory with the episode_id to drill into specific ones.",
        "input_schema": {
            "type": "object",
            "properties": {
                "group_id": {
                    "type": "string",
                    "description": "The trajectory group record ID (UUID from get_trajectory_groups results)",
                },
            },
            "required": ["group_id"],
        },
    },
]


class ToolExecutor:
    """Executes tools using the DataStore."""

    def __init__(self, datastore: DataStore):
        self.datastore = datastore

    def execute(self, tool_name: str, tool_input: dict[str, Any]) -> dict[str, Any]:
        """Execute a tool and return the result."""
        try:
            handler = {
                "get_session_info": self._get_session_info,
                "get_metrics": self._get_metrics,
                "get_episodes": self._get_episodes,
                "get_trajectory": self._get_trajectory,
                "search_episodes": self._search_episodes,
                "get_trajectory_groups": self._get_trajectory_groups,
                "get_trajectory_group": self._get_trajectory_group,
            }.get(tool_name)
            if handler is None:
                return {"error": f"Unknown tool: {tool_name}"}
            return handler(tool_input)
        except Exception as e:
            return {"error": str(e)}

    def _get_session_info(self, params: dict) -> dict:
        session_id = params.get("session_id")
        if not session_id:
            return {"error": "session_id is required"}

        session = self.datastore.get_session(session_id)
        if not session:
            return {"error": f"Session '{session_id}' not found"}

        return {
            "session": {
                "id": session["id"],
                "project": session["project"],
                "experiment": session["experiment"],
                "config": session.get("config"),
                "source_metadata": session.get("source_metadata"),
                "created_at": str(session["created_at"]),
                "completed_at": str(session["completed_at"]) if session.get("completed_at") else None,
            }
        }

    def _get_metrics(self, params: dict) -> dict:
        session_id = params.get("session_id")
        if not session_id:
            return {"error": "session_id is required"}

        session = self.datastore.get_session(session_id)
        if not session:
            return {"error": f"Session '{session_id}' not found"}

        metrics = self.datastore.get_metrics(session_id)

        # Apply step filtering if provided
        start_step = params.get("start_step")
        end_step = params.get("end_step")

        if start_step is not None:
            metrics = [m for m in metrics if m["step"] >= start_step]
        if end_step is not None:
            metrics = [m for m in metrics if m["step"] <= end_step]

        # Format for readability
        formatted = []
        for m in metrics:
            formatted.append({"step": m["step"], "data": m["data"]})

        return {
            "total_count": len(formatted),
            "metrics": formatted,
        }

    def _get_episodes(self, params: dict) -> dict:
        session_id = params.get("session_id")
        if not session_id:
            return {"error": "session_id is required"}

        session = self.datastore.get_session(session_id)
        if not session:
            return {"error": f"Session '{session_id}' not found"}

        episodes = self.datastore.get_episodes(session_id)

        # Apply filters
        step = params.get("step")
        is_correct = params.get("is_correct")
        limit = params.get("limit", 20)

        if step is not None:
            episodes = [e for e in episodes if e["step"] == step]
        if is_correct is not None:
            episodes = [e for e in episodes if e["is_correct"] == is_correct]

        # Limit results
        episodes = episodes[:limit]

        # Format for readability (exclude full trajectory data for summary)
        formatted = []
        for e in episodes:
            formatted.append(
                {
                    "id": e["id"],
                    "step": e["step"],
                    "is_correct": e["is_correct"],
                    "termination_reason": e.get("termination_reason"),
                    "task": e.get("task"),
                    "metrics": e.get("metrics"),
                    "trajectory_count": len(e.get("trajectories", [])),
                }
            )

        return {
            "total_count": len(formatted),
            "episodes": formatted,
        }

    def _get_trajectory(self, params: dict) -> dict:
        episode_id = params.get("episode_id")
        if not episode_id:
            return {"error": "episode_id is required"}

        episode = self.datastore.get_episode(episode_id)
        if not episode:
            return {"error": f"Episode '{episode_id}' not found"}

        trajectories = episode.get("trajectories", [])

        # Filter by trajectory name if specified
        trajectory_name = params.get("trajectory_name")
        if trajectory_name:
            trajectories = [t for t in trajectories if t.get("name") == trajectory_name]

        # Filter steps by range if specified
        start_step = params.get("start_step")
        end_step = params.get("end_step")
        if start_step is not None or end_step is not None:
            for traj in trajectories:
                steps = traj.get("steps", [])
                s = start_step if start_step is not None else 0
                e = end_step if end_step is not None else len(steps)
                traj["steps"] = steps[s:e]

        return {
            "episode_id": episode["id"],
            "step": episode["step"],
            "is_correct": episode["is_correct"],
            "termination_reason": episode.get("termination_reason"),
            "task": episode.get("task"),
            "metrics": episode.get("metrics"),
            "trajectories": trajectories,
        }

    def _search_episodes(self, params: dict) -> dict:
        query = params.get("query")
        if not query:
            return {"error": "query is required"}

        session_id = params.get("session_id")
        step = params.get("step")
        limit = params.get("limit", 20)

        result = self.datastore.search_episodes(query, session_id, limit, step)

        # Format episodes for readability
        formatted = []
        for e in result.get("episodes", []):
            formatted.append(
                {
                    "id": e["id"],
                    "session_id": e["session_id"],
                    "step": e["step"],
                    "is_correct": e["is_correct"],
                    "task": e.get("task"),
                    "rank": e.get("rank"),  # Relevance score if available
                }
            )

        return {
            "total_count": len(formatted),
            "matched_terms": result.get("matched_terms", []),
            "episodes": formatted,
        }

    def _get_trajectory_groups(self, params: dict) -> dict:
        session_id = params.get("session_id")
        if not session_id:
            return {"error": "session_id is required"}

        session = self.datastore.get_session(session_id)
        if not session:
            return {"error": f"Session '{session_id}' not found"}

        step = params.get("step")
        limit = params.get("limit", 20)
        groups = self.datastore.get_trajectory_groups(session_id, step)
        groups = groups[:limit]

        formatted = []
        for g in groups:
            formatted.append(
                {
                    "id": g["id"],
                    "group_id": g.get("group_id"),
                    "task_id": g.get("task_id"),
                    "trajectory_name": g.get("trajectory_name"),
                    "step": g.get("step"),
                    "num_trajectories": g.get("num_trajectories"),
                    "avg_reward": g.get("avg_reward"),
                }
            )

        return {
            "total_count": len(formatted),
            "groups": formatted,
        }

    def _get_trajectory_group(self, params: dict) -> dict:
        group_id = params.get("group_id")
        if not group_id:
            return {"error": "group_id is required"}

        # Fetch with trajectories to build per-trajectory summaries
        group = self.datastore.get_trajectory_group(group_id, include_trajectories=True)
        if not group:
            return {"error": f"Trajectory group '{group_id}' not found"}

        # Build lightweight per-trajectory summaries (no full step data)
        trajectories = []
        if group.get("data") and group["data"].get("trajectories"):
            for traj in group["data"]["trajectories"]:
                trajectories.append(
                    {
                        "uid": traj.get("uid"),
                        "name": traj.get("name"),
                        "reward": traj.get("reward"),
                        "num_steps": len(traj.get("steps", [])),
                    }
                )

        # Pair metadata with trajectory summaries
        metadata = group.get("metadata", [])
        rollouts = []
        for i, traj_summary in enumerate(trajectories):
            episode_id = metadata[i].get("episode_id") if i < len(metadata) else None
            rollouts.append(
                {
                    "episode_id": episode_id,
                    **traj_summary,
                }
            )

        return {
            "id": group["id"],
            "group_id": group.get("group_id"),
            "task_id": group.get("task_id"),
            "trajectory_name": group.get("trajectory_name"),
            "step": group.get("step"),
            "num_trajectories": group.get("num_trajectories"),
            "avg_reward": group.get("avg_reward"),
            "rollouts": rollouts,
        }
