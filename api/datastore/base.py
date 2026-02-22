from abc import ABC, abstractmethod
from typing import Any


def extract_searchable_text(episode_data: dict) -> str:
    """Extract searchable text from episode data.

    Extracts text from task, observations, actions, and model responses
    to create a searchable string for full-text search indexing.
    """
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
            parts.extend(
                [
                    str(step.get("observation", "")),
                    str(step.get("thought", "")),
                    str(step.get("action", "")),
                    str(step.get("model_response", "")),
                ]
            )
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

    @abstractmethod
    def create_session(self, project: str, experiment: str, config: dict[str, Any], source_metadata: dict[str, Any]) -> str:
        """Create a new training session."""
        pass

    @abstractmethod
    def log_metrics(self, session_id: str, step: int, data: dict[str, Any]) -> dict[str, Any] | None:
        """Log metrics for a session."""
        pass

    @abstractmethod
    def append_episode(self, session_id: str, episode_data: dict[str, Any]):
        """Append an episode to a session."""
        pass

    @abstractmethod
    def get_session(self, session_id: str) -> dict[str, Any] | None:
        """Retrieve session details."""
        pass

    @abstractmethod
    def get_all_sessions(self) -> list[dict[str, Any]]:
        """Retrieve all sessions."""
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
    def get_projects(self) -> list[dict[str, Any]]:
        """Retrieve all projects with lightweight session summaries."""
        pass

    @abstractmethod
    def get_or_create_project(self, name: str) -> str:
        """Get existing project ID by name, or create a new one. Returns project ID."""
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
