"""Pydantic models for API request/response validation."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel


# Session models
class SessionCreate(BaseModel):
    project: str
    experiment: str
    config: dict[str, Any] | None = None
    source_metadata: dict[str, Any] | None = None


class SessionResponse(BaseModel):
    id: str
    project_id: str
    project: str
    experiment: str
    config: dict[str, Any] | None
    source_metadata: dict[str, Any] | None
    color: str | None = None
    status: str = "running"
    created_at: datetime
    completed_at: datetime | None = None


class ProjectSessionSummary(BaseModel):
    id: str
    experiment: str
    status: str = "running"
    created_at: datetime
    completed_at: datetime | None = None


class SessionFinish(BaseModel):
    status: str = "completed"
    exit_code: int | None = None


class ProjectResponse(BaseModel):
    id: str
    project: str
    sessions: list[ProjectSessionSummary]


class ProjectRename(BaseModel):
    new_name: str


class SessionUpdate(BaseModel):
    new_experiment_name: str | None = None
    color: str | None = None


# Metrics models
class MetricsCreate(BaseModel):
    session_id: str
    step: int
    data: dict[str, Any]


class MetricsResponse(BaseModel):
    id: int
    session_id: str
    step: int
    data: dict[str, Any]
    created_at: datetime


# Episode models
class TrajectoryStep(BaseModel):
    observation: Any = None
    thought: str = ""
    action: Any = None
    model_response: Any | None = None
    chat_completions: Any | None = None
    info: dict[str, Any] | None = None
    reward: float = 0.0
    done: bool = False
    mc_return: float = 0.0
    advantage: float | list[float] | None = None


class Trajectory(BaseModel):
    uid: str
    name: str | None = None
    task: dict[str, Any] | None = None
    reward: float | None = None
    info: dict[str, Any] | None = None
    steps: list[TrajectoryStep] = []


class EpisodeCreate(BaseModel):
    session_id: str
    step: int
    episode_id: str
    task: dict[str, Any]
    is_correct: bool
    termination_reason: str | None = None
    trajectories: list[Trajectory]
    metrics: dict[str, Any] | None = None
    info: dict[str, Any] | None = None


class EpisodeResponse(BaseModel):
    id: str
    session_id: str
    step: int
    task: dict[str, Any]
    is_correct: bool
    termination_reason: str | None = None
    trajectories: list[dict[str, Any]]
    metrics: dict[str, Any] | None = None
    info: dict[str, Any] | None = None
    created_at: datetime
    rank: float | None = None  # Relevance score from PostgreSQL full-text search


class EpisodeSearchResponse(BaseModel):
    """Response for episode search endpoint."""

    episodes: list[EpisodeResponse]
    matched_terms: list[str]  # Stemmed terms (PostgreSQL) or original query terms (SQLite)


# Trajectory Group models
class TrajectoryGroupMetadata(BaseModel):
    """Per-trajectory metadata within a group."""

    episode_id: str


class TrajectoryGroupCreate(BaseModel):
    """Request model for creating a trajectory group.

    Note: trajectories are NOT stored - they are fetched from episodes table when needed.
    Only metadata (with episode references) is stored.
    """

    session_id: str
    step: int
    group_id: str  # Format: "task_id:trajectory_name"
    num_trajectories: int = 0
    avg_reward: float | None = None
    metadata: list[TrajectoryGroupMetadata]


class TrajectoryGroupResponse(BaseModel):
    """Response model for trajectory group."""

    id: str
    session_id: str
    step: int
    group_id: str
    task_id: str  # Extracted from group_id
    trajectory_name: str  # Extracted from group_id
    num_trajectories: int
    avg_reward: float | None
    metadata: list[TrajectoryGroupMetadata]  # References to episodes + per-trajectory info
    data: dict[str, Any] | None = None  # Full trajectory data (populated on demand from episodes)
    created_at: datetime


class TrajectoryGroupListResponse(BaseModel):
    """Response for listing trajectory groups."""

    groups: list[TrajectoryGroupResponse]
    total: int


class TrajectoryGroupSearchResponse(BaseModel):
    """Response for trajectory group search endpoint."""

    groups: list[TrajectoryGroupResponse]
    matched_terms: list[str]


# Log models
class LogCreate(BaseModel):
    session_id: str
    timestamp: str
    stream: str = "stdout"
    message: str


class LogBatchCreate(BaseModel):
    session_id: str
    logs: list[LogCreate]


class LogResponse(BaseModel):
    id: int
    session_id: str
    timestamp: str
    stream: str
    message: str
    created_at: datetime


# Chat session models
class ChatSessionCreate(BaseModel):
    session_id: str
    title: str = "New chat"


class ChatSessionResponse(BaseModel):
    id: str
    session_id: str
    title: str
    created_at: datetime
    updated_at: datetime
    message_count: int = 0


class ChatMessageResponse(BaseModel):
    id: int
    chat_session_id: str
    role: str
    content: str
    created_at: datetime


# Health check
class HealthResponse(BaseModel):
    status: str


# Auth models
class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str | None = None


class UserResponse(BaseModel):
    id: str
    email: str
    name: str | None = None
    api_key: str | None = None


class AuthConfigResponse(BaseModel):
    auth_required: bool
    deployment_mode: str
    oauth_providers: list[str] = []
