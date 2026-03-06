from abc import ABC, abstractmethod
from typing import Any


def extract_searchable_text(episode_data: dict, step_model: type | None = None) -> str:
    """Extract searchable text from episode data.

    Uses the step model's _searchable_fields to determine which fields to index.
    Falls back to AgentStep fields if no model is provided.
    """
    if step_model is None:
        from models import AgentStep
        step_model = AgentStep

    searchable_fields = getattr(step_model, "_searchable_fields", ["input", "output", "action"])

    parts = []

    # Task question/description
    task = episode_data.get("task", {})
    if isinstance(task, dict):
        parts.append(str(task.get("question", "")))
        parts.append(str(task.get("description", "")))
    elif isinstance(task, str):
        parts.append(task)

    # Trajectory steps
    for traj in episode_data.get("trajectories", []):
        for step in traj.get("steps", []):
            for field in searchable_fields:
                val = step.get(field, "")
                if val:
                    parts.append(str(val))
            # Also extract from chat_completions if present
            for msg in step.get("chat_completions", []) or []:
                if isinstance(msg, dict):
                    parts.append(str(msg.get("content", "")))

    return " ".join(filter(None, parts))


class DataStore(ABC):
    """Abstract base class for data storage implementations."""

    @abstractmethod
    def init_db(self):
        """Initialize the database schema."""
        pass

    @abstractmethod
    def reset(self):
        """Reset the data store (destructive, mainly for tests)."""
        pass

    # ── User methods (cloud mode only) ────────────────────────────

    @abstractmethod
    def create_user(self, user_id: str, email: str, password_hash: str, name: str | None, api_key: str) -> dict[str, Any]:
        """Create a new user. Returns the user dict."""
        pass

    @abstractmethod
    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        """Look up a user by email."""
        pass

    @abstractmethod
    def get_user_by_api_key(self, api_key: str) -> dict[str, Any] | None:
        """Look up a user by API key."""
        pass

    @abstractmethod
    def get_user_by_id(self, user_id: str) -> dict[str, Any] | None:
        """Look up a user by ID."""
        pass

    @abstractmethod
    def get_user_by_oauth(self, provider: str, provider_id: str) -> dict[str, Any] | None:
        """Look up a user by OAuth provider and provider user ID."""
        pass

    @abstractmethod
    def create_oauth_user(self, user_id: str, email: str, name: str | None, api_key: str,
                          oauth_provider: str, oauth_provider_id: str) -> dict[str, Any]:
        """Create a new user from OAuth. Returns the user dict."""
        pass

    @abstractmethod
    def link_oauth_to_user(self, user_id: str, oauth_provider: str, oauth_provider_id: str) -> dict[str, Any] | None:
        """Link an OAuth provider to an existing user. Returns updated user dict."""
        pass

    @abstractmethod
    def update_user_api_key(self, user_id: str, new_api_key: str) -> dict[str, Any] | None:
        """Replace a user's API key. Returns updated user dict or None if not found."""
        pass

    @abstractmethod
    def delete_user(self, user_id: str) -> bool:
        """Delete a user and all associated data (projects, sessions, etc.).

        Relies on ON DELETE CASCADE from projects.owner_id → users.id.
        Returns True if user existed, False otherwise.
        """
        pass

    # ── User settings methods (cloud mode only) ────────────────────

    @abstractmethod
    def get_user_settings(self, user_id: str) -> dict[str, str]:
        """Return all settings for a user as {key: value}. Values are stored encrypted."""
        pass

    @abstractmethod
    def set_user_setting(self, user_id: str, key: str, value: str) -> None:
        """Upsert a single setting for a user."""
        pass

    @abstractmethod
    def delete_user_setting(self, user_id: str, key: str) -> bool:
        """Delete a single setting. Returns True if it existed."""
        pass

    # ── Session / project methods ─────────────────────────────────

    @abstractmethod
    def create_session(self, project: str, experiment: str, config: dict[str, Any], source_metadata: dict[str, Any], owner_id: str | None = None, session_type: str = "training") -> str:
        """Create a new training session."""
        pass

    @abstractmethod
    def log_metrics(self, session_id: str, step: int, data: dict[str, Any]) -> dict[str, Any] | None:
        """Log metrics for a session."""
        pass

    @abstractmethod
    def append_episode(self, session_id: str, episode_data: dict[str, Any], search_text: str | None = None):
        """Append an episode to a session."""
        pass

    @abstractmethod
    def get_session(self, session_id: str) -> dict[str, Any] | None:
        """Retrieve session details."""
        pass

    @abstractmethod
    def get_all_sessions(self, owner_id: str | None = None) -> list[dict[str, Any]]:
        """Retrieve all sessions, optionally filtered by owner."""
        pass

    @abstractmethod
    def complete_session(self, session_id: str, status: str = "completed") -> dict[str, Any] | None:
        """Mark a session as completed.

        Args:
            session_id: Session ID
            status: Final status - 'completed' or 'failed'
        """
        pass

    @abstractmethod
    def heartbeat_session(self, session_id: str) -> bool:
        """Update the last_heartbeat_at timestamp for a session.

        Returns True if the session exists, False otherwise.
        """
        pass

    @abstractmethod
    def mark_crashed_sessions(self, timeout_seconds: int = 300) -> int:
        """Mark stale running sessions as crashed.

        Updates all sessions where status='running' and last_heartbeat_at
        is older than timeout_seconds ago.

        Returns the number of sessions marked as crashed.
        """
        pass

    @abstractmethod
    def get_new_metrics(self, session_id: str, last_id: int) -> list[dict[str, Any]]:
        """Retrieve metrics since last_id."""
        pass

    @abstractmethod
    def get_metrics(self, session_id: str) -> list[dict[str, Any]]:
        """Retrieve metrics for a session."""
        pass

    @abstractmethod
    def get_episodes(self, session_id: str) -> list[dict[str, Any]]:
        """Retrieve episodes for a session."""
        pass

    @abstractmethod
    def get_episode(self, episode_id: str) -> dict[str, Any] | None:
        """Retrieve a specific episode."""
        pass

    @abstractmethod
    def search_episodes(self, query: str, session_id: str | None = None, step: int | None = None) -> dict[str, Any]:
        """Search episodes by text content.

        Args:
            query: Search query string
            session_id: Optional session ID to filter results
            step: Optional step number to filter results

        Returns:
            Dict with:
                - episodes: List of matching episodes (PostgreSQL includes 'rank' field)
                - matched_terms: List of terms used for matching (stemmed for PostgreSQL)
        """
        pass

    @abstractmethod
    def search_trajectory_groups(self, query: str, session_id: str | None = None,
                                  step: int | None = None) -> dict[str, Any]:
        """Search trajectory groups by matching group metadata fields and linked episode content.

        Args:
            query: Search query string
            session_id: Optional session ID to filter results
            step: Optional step number to filter results

        Returns:
            Dict with:
                - groups: List of matching trajectory groups
                - matched_terms: List of terms used for matching
        """
        pass

    @abstractmethod
    def append_trajectory_group(self, session_id: str, group_data: dict[str, Any]):
        """Append a trajectory group to a session.

        Args:
            session_id: Session ID
            group_data: Trajectory group data containing group_id, trajectories, and metadata
        """
        pass

    @abstractmethod
    def get_trajectory_groups(self, session_id: str, step: int | None = None) -> list[dict[str, Any]]:
        """Retrieve trajectory groups for a session.

        Args:
            session_id: Session ID
            step: Optional step number to filter results

        Returns:
            List of trajectory groups
        """
        pass

    @abstractmethod
    def get_trajectory_group(self, group_id: str, include_trajectories: bool = True) -> dict[str, Any] | None:
        """Retrieve a specific trajectory group by ID.

        Args:
            group_id: Trajectory group record ID
            include_trajectories: If True, fetch full trajectory data from episodes

        Returns:
            Trajectory group data (with optional full trajectory data) or None if not found
        """
        pass

    @abstractmethod
    def get_projects(self, owner_id: str | None = None) -> list[dict[str, Any]]:
        """Retrieve all projects with lightweight session summaries, optionally filtered by owner."""
        pass

    @abstractmethod
    def get_or_create_project(self, name: str, owner_id: str | None = None) -> str:
        """Get existing project ID by name (and owner), or create a new one. Returns project ID."""
        pass

    @abstractmethod
    def get_project(self, project_id: str) -> dict[str, Any] | None:
        """Get a single project by ID."""
        pass

    @abstractmethod
    def rename_project(self, project_id: str, new_name: str) -> dict[str, Any] | None:
        """Rename a project. Returns updated project dict or None if not found."""
        pass

    @abstractmethod
    def delete_project(self, project_id: str) -> bool:
        """Delete a project and cascade to all sessions + children. Returns True if deleted."""
        pass

    @abstractmethod
    def update_session(self, session_id: str, experiment: str | None = None, color: str | None = None) -> dict[str, Any] | None:
        """Update a session's experiment name and/or color. Returns updated session or None."""
        pass

    @abstractmethod
    def delete_session(self, session_id: str) -> bool:
        """Delete a session and cascade to all children. Returns True if deleted."""
        pass

    @abstractmethod
    def append_log(self, session_id: str, log_data: dict) -> None:
        """Append a log entry to a session."""
        pass

    @abstractmethod
    def get_logs(self, session_id: str, stream: str | None = None, limit: int = 1000, offset: int = 0) -> list[dict[str, Any]]:
        """Retrieve logs for a session with optional stream filter."""
        pass

    @abstractmethod
    def get_new_logs(self, session_id: str, last_id: int) -> list[dict[str, Any]]:
        """Retrieve logs since last_id."""
        pass

    # ── Chat session methods ─────────────────────────────────────────

    @abstractmethod
    def create_chat_session(self, session_id: str, title: str = "New chat") -> dict[str, Any]:
        """Create a new chat session for a training run. Returns the chat session dict."""
        pass

    @abstractmethod
    def get_chat_sessions(self, session_id: str) -> list[dict[str, Any]]:
        """Get all chat sessions for a training run, ordered by updated_at desc."""
        pass

    @abstractmethod
    def delete_chat_session(self, chat_session_id: str) -> bool:
        """Delete a chat session and its messages. Returns True if deleted."""
        pass

    @abstractmethod
    def get_chat_messages(self, chat_session_id: str) -> list[dict[str, Any]]:
        """Get all messages for a chat session, ordered by created_at asc."""
        pass

    @abstractmethod
    def append_chat_message(self, chat_session_id: str, role: str, content: str) -> dict[str, Any]:
        """Append a message to a chat session. Updates the session's updated_at. Returns the message dict."""
        pass

    # ── Eval result methods ─────────────────────────────────────────

    @abstractmethod
    def create_eval_result(self, data: dict[str, Any]) -> dict[str, Any]:
        """Store an eval result. Returns the created record."""
        pass

    @abstractmethod
    def get_eval_results(self, session_id: str | None = None) -> list[dict[str, Any]]:
        """Get eval results, optionally filtered by session_id."""
        pass

    @abstractmethod
    def get_eval_result(self, result_id: str) -> dict[str, Any] | None:
        """Get a single eval result by ID."""
        pass

    @abstractmethod
    def get_eval_results_by_project(self, project_id: str) -> list[dict[str, Any]]:
        """Get all eval results for sessions in a project (for leaderboard grouping)."""
        pass

    def close(self):
        """Close any resources held by the data store (e.g. connection pools)."""
        pass
