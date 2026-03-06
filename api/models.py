"""Pydantic models for API request/response validation."""

from datetime import datetime
from typing import Any, ClassVar

from pydantic import BaseModel


# Session models
class SessionCreate(BaseModel):
    project: str
    experiment: str
    config: dict[str, Any] | None = None
    source_metadata: dict[str, Any] | None = None
    session_type: str = "training"


class SessionResponse(BaseModel):
    id: str
    project_id: str
    project: str
    experiment: str
    config: dict[str, Any] | None
    source_metadata: dict[str, Any] | None
    color: str | None = None
    status: str = "running"
    session_type: str = "training"
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


# Episode models — Base (mirrors rllm.types.*)
class Step(BaseModel):
    _searchable_fields: ClassVar[list[str]] = ["input", "output", "action"]

    id: str | None = None
    input: Any = None
    output: Any = None
    action: Any = None
    reward: float = 0.0
    done: bool = False
    metadata: dict[str, Any] | None = None


class Trajectory(BaseModel):
    uid: str
    name: str = "agent"
    task: Any = None
    steps: list[Step] = []
    reward: float | None = None
    input: dict | None = None
    output: Any = None
    signals: dict[str, float] = {}
    metadata: dict[str, Any] | None = None


class Episode(BaseModel):
    session_id: str
    session_type: str = "training"
    step: int
    episode_id: str
    task: dict[str, Any]
    is_correct: bool
    termination_reason: str | None = None
    trajectories: list[Trajectory]
    metrics: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    artifacts: dict[str, Any] | None = None


# Episode models — Agent (extends base, mirrors rllm.agents.agent.*)
class AgentStep(Step):
    _searchable_fields: ClassVar[list[str]] = ["observation", "thought", "action", "model_response"]

    observation: Any = None
    thought: str = ""
    model_response: Any | None = None
    chat_completions: Any | None = None
    info: dict[str, Any] | None = None
    mc_return: float = 0.0
    advantage: float | list[float] | None = None


class AgentTrajectory(Trajectory):
    steps: list[AgentStep] = []
    info: dict[str, Any] | None = None


class AgentEpisode(Episode):
    trajectories: list[AgentTrajectory]
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
    metadata: dict[str, Any] | None = None
    artifacts: dict[str, Any] | None = None
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


# Eval models
class EvalItemCreate(BaseModel):
    idx: int
    reward: float
    is_correct: bool
    error: str | None = None
    signals: dict[str, float] = {}


class EvalResultCreate(BaseModel):
    session_id: str
    dataset_name: str
    model: str
    agent: str
    score: float
    total: int
    correct: int
    errors: int
    signal_averages: dict[str, float] = {}
    items: list[EvalItemCreate] = []


class EvalResultResponse(EvalResultCreate):
    id: str
    created_at: str
