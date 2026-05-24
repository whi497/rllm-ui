"""Pydantic models for API request/response validation."""

from datetime import date, datetime
from typing import Any, ClassVar, Literal

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
    signals: dict[str, Any] = {}
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
    team: str | None = None
    is_superuser: bool = False
    impersonating: bool = False


class AdminUserResponse(BaseModel):
    """User record for the admin user list (no sensitive fields)."""
    id: str
    email: str
    name: str | None = None
    team: str | None = None
    is_superuser: bool = False
    oauth_provider: str | None = None
    created_at: datetime


class AuthConfigResponse(BaseModel):
    auth_required: bool
    deployment_mode: str
    oauth_providers: list[str] = []
    local_dev_login: bool = False


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
    created_at: datetime


# Agent session models (ClickHouse-backed)
class AgentSessionCreate(BaseModel):
    name: str = ""
    metadata: dict[str, Any] | None = None


class AgentSessionResponse(BaseModel):
    id: str
    name: str
    status: str = "running"
    metadata: dict[str, Any] | None = None
    created_at: datetime
    completed_at: datetime | None = None
    span_count: int | None = None


class AgentTrajectoryIngest(BaseModel):
    """Mirrors the NDJSON export TraceEnvelope: {"type": "trajectory.*", "data": {...}}"""

    type: Literal["trajectory.start", "trajectory.step", "trajectory.end"]
    data: dict[str, Any]


class AgentTrajectoryResponse(BaseModel):
    id: str
    agent_session_id: str
    span_type: str
    trajectory_uid: str
    agent_name: str = ""
    data: dict[str, Any]
    created_at: datetime


# Agent span models (ClickHouse-backed, real-time observability)
class SpanIngest(BaseModel):
    """Mirrors TraceEnvelope: {"type": "<span_type>", "data": {...}}"""

    type: str
    data: dict[str, Any]


class SpanResponse(BaseModel):
    id: str
    agent_session_id: str
    span_type: str
    span_id: str
    invocation_id: str = ""
    agent_name: str = ""
    model: str = ""
    tool_name: str = ""
    duration_ms: float | None = None
    error: str = ""
    data: dict[str, Any]
    created_at: datetime


# Agent dashboard aggregate models
class DashboardStats(BaseModel):
    total_spans: int = 0
    llm_calls: int = 0
    tool_calls: int = 0
    invocations: int = 0
    total_tokens: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    avg_llm_latency_ms: float = 0
    avg_tool_latency_ms: float = 0
    error_count: int = 0


class TimeseriesBucket(BaseModel):
    bucket: datetime
    total: int = 0
    llm_calls: int = 0
    tool_calls: int = 0
    agent_spans: int = 0
    tokens: int = 0
    errors: int = 0


class ModelUsage(BaseModel):
    model: str
    call_count: int = 0
    total_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    avg_latency_ms: float = 0


class ToolUsage(BaseModel):
    tool_name: str
    call_count: int = 0
    avg_latency_ms: float = 0
    error_count: int = 0


class SessionCounts(BaseModel):
    total: int = 0
    running: int = 0
    completed: int = 0
    failed: int = 0


class DashboardResponse(BaseModel):
    stats: DashboardStats
    timeseries: list[TimeseriesBucket]
    models: list[ModelUsage]
    tools: list[ToolUsage]
    sessions: SessionCounts


class SpanActivityBucket(BaseModel):
    day: date
    count: int


class SpanActivityResponse(BaseModel):
    buckets: list[SpanActivityBucket]


# Skill distillation models
class SkillCreate(BaseModel):
    title: str
    description: str
    category: str = "general"
    confidence: float = 0.0
    reward_delta: float = 0.0
    success_rate: str = ""
    evidence_count: int = 0
    source_session_ids: list[str] = []
    tags: list[str] = []
    metadata: dict[str, Any] | None = None


class SkillResponse(BaseModel):
    id: str
    title: str
    description: str
    category: str
    confidence: float
    reward_delta: float
    success_rate: str
    evidence_count: int
    source_session_ids: list[str]
    tags: list[str]
    is_active: bool = False
    metadata: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


class SkillUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    category: str | None = None
    is_active: bool | None = None
    tags: list[str] | None = None


# Paginated response wrappers
class PaginatedSessionsResponse(BaseModel):
    items: list[AgentSessionResponse]
    total: int
    offset: int
    limit: int


class PaginatedSpansResponse(BaseModel):
    items: list[SpanResponse]
    total: int
    offset: int
    limit: int


class DistillRequest(BaseModel):
    session_ids: list[str]
    source: str = "clickhouse"


# Span upload models (agent span CSV import)
class SpanUploadResponse(BaseModel):
    upload_id: str
    filename: str
    row_count: int
    session_count: int
    created_at: datetime


class SpanUploadListResponse(BaseModel):
    uploads: list[SpanUploadResponse]
    total: int


class SpanUploadSessionResponse(BaseModel):
    id: str
    name: str
    status: str
    span_count: int
    created_at: datetime
    completed_at: datetime | None = None


class SpanUploadSessionListResponse(BaseModel):
    sessions: list[SpanUploadSessionResponse]
    total: int


# Eval explorer models (joined eval rows + session metadata)
class EvalExplorerSessionInfo(BaseModel):
    name: str = ""
    status: str = "unknown"
    agent_name: str | None = None
    span_count: int = 0
    llm_calls: int = 0
    tool_calls: int = 0
    created_at: datetime | None = None


class EvalExplorerRow(BaseModel):
    id: int
    upload_id: str
    session_id: str
    ground_truth: str
    rating: str = ""
    trajectory_alignment: str = ""
    task_success: str = ""
    tags: str
    reference_trajectory: str = ""
    reference_state: str = ""
    reference_answer: str = ""
    created_at: datetime
    session: EvalExplorerSessionInfo | None = None


# Eval upload models (CSV import)
class EvalUploadResponse(BaseModel):
    upload_id: str
    filename: str
    row_count: int
    created_at: datetime


class EvalUploadRowResponse(BaseModel):
    id: int
    upload_id: str
    session_id: str
    agent_trajectory: str
    ground_truth: str
    rating: str = ""
    trajectory_alignment: str = ""
    task_success: str = ""
    tags: str
    reference_trajectory: str = ""
    reference_state: str = ""
    reference_answer: str = ""
    created_at: datetime


# Background job models
class BackgroundJobResponse(BaseModel):
    id: str
    job_type: str
    status: str
    progress: dict[str, Any] = {}
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: datetime
    updated_at: datetime


# Cluster models
class ClusterResponse(BaseModel):
    id: str
    name: str
    task_type: str
    description: str = ""
    member_count: int = 0
    metadata: dict[str, Any] = {}
    job_id: str | None = None
    created_at: datetime
    updated_at: datetime


class ClusterMemberResponse(BaseModel):
    id: str
    cluster_id: str
    session_id: str
    labels: dict[str, Any] = {}
    summary: str = ""
    created_at: datetime


class ClusterDetailResponse(ClusterResponse):
    members: list[ClusterMemberResponse] = []
