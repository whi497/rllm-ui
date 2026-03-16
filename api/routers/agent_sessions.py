"""Agent session and trajectory span endpoints.

Supports two data source backends:
- ``clickhouse`` (default): Uses ClickHouse for real-time streaming spans.
- ``bigquery``: Reads historical trace data exported by rllm_telemetry.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from auth import CurrentUser
from fastapi import APIRouter, HTTPException, Query, Request

logger = logging.getLogger(__name__)

from models import (
    AgentSessionCreate,
    AgentSessionResponse,
    AgentTrajectoryIngest,
    AgentTrajectoryResponse,
    DashboardResponse,
    DashboardStats,
    ModelUsage,
    PaginatedSessionsResponse,
    PaginatedSpansResponse,
    SessionCounts,
    SpanActivityBucket,
    SpanActivityResponse,
    SpanIngest,
    SpanResponse,
    TimeseriesBucket,
    ToolUsage,
)

router = APIRouter(prefix="/api/agent-sessions", tags=["agent-sessions"])

DataSource = Literal["clickhouse", "bigquery", "postgres"]


def _get_clickhouse(request: Request):
    """Extract the ClickHouse client from app state, or raise 503."""
    ch = getattr(request.app.state, "clickhouse", None)
    if ch is None:
        raise HTTPException(
            status_code=503,
            detail="ClickHouse not configured. Set CLICKHOUSE_HOST to enable agent trajectory features.",
        )
    return ch


def _get_bigquery(request: Request):
    """Extract the BigQuery client from app state, lazily initializing if needed."""
    bq = getattr(request.app.state, "bigquery", None)
    if bq is None:
        try:
            from datastore.bigquery_client import BigQueryClient

            bq = BigQueryClient()
            request.app.state.bigquery = bq
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Failed to initialize BigQuery client: {exc}",
            ) from exc
    return bq


def _get_postgres_spans(request: Request):
    """Extract the PostgreSQL span client from app state, or raise 503."""
    pg = getattr(request.app.state, "postgres_spans", None)
    if pg is None:
        raise HTTPException(
            status_code=503,
            detail="PostgreSQL span store not configured.",
        )
    return pg


def _get_client(request: Request, source: DataSource):
    """Get the appropriate data source client."""
    if source == "bigquery":
        # BigQuery is temporarily disabled — not yet migrated to user-aware queries.
        raise HTTPException(status_code=503, detail="BigQuery source coming soon.")
        # return _get_bigquery(request)
    if source == "postgres":
        return _get_postgres_spans(request)
    return _get_clickhouse(request)


# ------------------------------------------------------------------
# Data source availability
# ------------------------------------------------------------------


@router.get("/sources")
def get_available_sources(request: Request, user: CurrentUser):
    """Return which data sources are configured and available."""
    sources = []
    if getattr(request.app.state, "clickhouse", None) is not None:
        sources.append("clickhouse")
    # BigQuery temporarily disabled — not yet migrated to user-aware queries.
    # if getattr(request.app.state, "bigquery", None) is not None:
    #     sources.append("bigquery")
    if getattr(request.app.state, "postgres_spans", None) is not None:
        sources.append("postgres")
    return {"sources": sources}


# ------------------------------------------------------------------
# Delete all data
# ------------------------------------------------------------------


@router.delete("/all")
def delete_all_data(
    request: Request,
    user: CurrentUser,
    source: DataSource = "clickhouse",
):
    """Delete data for the current user in a given source, plus all derived resources
    (skills, clusters, eval results, etc.).

    This is a destructive operation intended for testing / resetting to a clean state.
    """
    store = request.app.state.store
    uid = user["id"]
    deleted: dict[str, int] = {}

    # 1. Delete source-specific span/session data (scoped to current user)
    if source == "clickhouse":
        ch = getattr(request.app.state, "clickhouse", None)
        if ch is None:
            raise HTTPException(status_code=503, detail="ClickHouse not configured.")
        deleted.update(ch.delete_all(user_id=uid))
    elif source == "postgres":
        pg = getattr(request.app.state, "postgres_spans", None)
        if pg is None:
            raise HTTPException(status_code=503, detail="PostgreSQL span store not configured.")
        deleted.update(pg.delete_all(user_id=uid))
    elif source == "bigquery":
        # BigQuery temporarily disabled — not yet migrated to user-aware queries.
        raise HTTPException(status_code=503, detail="BigQuery source coming soon.")
        # bq = getattr(request.app.state, "bigquery", None)
        # if bq is None:
        #     raise HTTPException(status_code=503, detail="BigQuery not configured.")
        # deleted.update(bq.delete_all())
    else:
        raise HTTPException(status_code=400, detail=f"Unknown source: {source}")

    # 2. Delete all derived resources (scoped to current user)
    deleted["skills"] = store.delete_all_skills(user_id=uid)
    deleted["clusters"] = store.delete_all_clusters(user_id=uid)
    deleted["eval_results"] = store.delete_all_eval_results(user_id=uid)
    deleted["eval_uploads"] = store.delete_all_eval_uploads(user_id=uid)
    deleted["jobs"] = store.delete_all_jobs(user_id=uid)

    logger.info("delete_all_data(source=%s): %s", source, deleted)
    return {"source": source, "deleted": deleted}


# ------------------------------------------------------------------
# Dashboard (aggregate metrics)
# ------------------------------------------------------------------


@router.get("/dashboard", response_model=DashboardResponse)
def get_dashboard(
    request: Request,
    user: CurrentUser,
    days: int = 7,
    source: DataSource = "clickhouse",
):
    """Get aggregate dashboard metrics across the user's sessions."""
    client = _get_client(request, source)
    uid = user["id"]
    stats = client.get_dashboard_stats(days, user_id=uid)
    timeseries = client.get_span_timeseries(days, user_id=uid)
    models = client.get_top_models(days, user_id=uid)
    tools = client.get_top_tools(days, user_id=uid)
    sessions = client.get_session_count(days, user_id=uid)
    return DashboardResponse(
        stats=DashboardStats(**stats) if stats else DashboardStats(),
        timeseries=[TimeseriesBucket(**b) for b in timeseries],
        models=[ModelUsage(**m) for m in models],
        tools=[ToolUsage(**t) for t in tools],
        sessions=SessionCounts(**sessions) if sessions else SessionCounts(),
    )


# ------------------------------------------------------------------
# Span activity (lightweight daily counts)
# ------------------------------------------------------------------


@router.get("/span-activity", response_model=SpanActivityResponse)
def get_span_activity(
    request: Request,
    user: CurrentUser,
    source: DataSource = "clickhouse",
):
    """Daily span counts over the full stored time range."""
    client = _get_client(request, source)
    buckets = client.get_span_activity(user_id=user["id"])
    return SpanActivityResponse(
        buckets=[SpanActivityBucket(**b) for b in buckets],
    )


# ------------------------------------------------------------------
# Agent sessions
# ------------------------------------------------------------------


@router.post("", response_model=AgentSessionResponse)
def create_agent_session(request: Request, body: AgentSessionCreate, user: CurrentUser):
    """Create a new agent session (ClickHouse only)."""
    ch = _get_clickhouse(request)
    session_id = str(uuid.uuid4())
    name = body.name or f"agent-{session_id[:8]}"
    ch.insert_agent_session(session_id, name, body.metadata, user_id=user["id"])
    return AgentSessionResponse(
        id=session_id,
        name=name,
        status="running",
        metadata=body.metadata,
        created_at=datetime.now(timezone.utc),
    )


@router.get("", response_model=PaginatedSessionsResponse)
def list_agent_sessions(
    request: Request,
    user: CurrentUser,
    source: DataSource = "clickhouse",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """List agent sessions with pagination."""
    client = _get_client(request, source)
    uid = user["id"]
    rows = client.get_agent_sessions(limit=limit, offset=offset, user_id=uid)
    total = client.count_agent_sessions(user_id=uid)
    return PaginatedSessionsResponse(
        items=[AgentSessionResponse(**row) for row in rows],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.get("/{session_id}", response_model=AgentSessionResponse)
def get_agent_session(
    request: Request,
    session_id: str,
    user: CurrentUser,
    source: DataSource = "clickhouse",
):
    """Get a single agent session."""
    client = _get_client(request, source)
    row = client.get_agent_session(session_id, user_id=user["id"])
    if row is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return AgentSessionResponse(**row)


@router.post("/{session_id}/complete", response_model=AgentSessionResponse)
def complete_agent_session(request: Request, session_id: str, user: CurrentUser):
    """Mark an agent session as completed (ClickHouse only)."""
    ch = _get_clickhouse(request)
    # Verify ownership
    existing = ch.get_agent_session(session_id, user_id=user["id"])
    if existing is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    row = ch.complete_agent_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return AgentSessionResponse(**row)


# ------------------------------------------------------------------
# Span ingestion & querying
# ------------------------------------------------------------------

_TRAJECTORY_TYPES = frozenset({"trajectory.start", "trajectory.step", "trajectory.end"})


@router.post("/{session_id}/spans", response_model=SpanResponse)
def ingest_span(
    request: Request,
    session_id: str,
    body: SpanIngest,
    user: CurrentUser,
):
    """Ingest a single span (ClickHouse only)."""
    ch = _get_clickhouse(request)
    # Auto-create session if it doesn't exist (for telemetry clients that don't call create first)
    existing = ch.get_agent_session(session_id, user_id=user["id"])
    if existing is None:
        ch.insert_agent_session(session_id, f"agent-{session_id[:8]}", user_id=user["id"])
    row = ch.insert_span(session_id, body.type, body.data)
    if body.type in _TRAJECTORY_TYPES:
        ch.insert_trajectory(session_id, body.type, body.data)
    return SpanResponse(**row)


@router.get("/{session_id}/spans", response_model=PaginatedSpansResponse)
def get_spans(
    request: Request,
    session_id: str,
    user: CurrentUser,
    type: str | None = None,
    source: DataSource = "clickhouse",
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    """Get spans for a session with pagination."""
    client = _get_client(request, source)
    # Verify session ownership
    session = client.get_agent_session(session_id, user_id=user["id"])
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    rows = client.get_spans(session_id, span_type=type, limit=limit, offset=offset)
    total = client.count_spans(session_id, span_type=type)
    return PaginatedSpansResponse(
        items=[SpanResponse(**row) for row in rows],
        total=total,
        offset=offset,
        limit=limit,
    )


@router.get(
    "/{session_id}/spans/invocation/{invocation_id}",
    response_model=list[SpanResponse],
)
def get_spans_by_invocation(
    request: Request,
    session_id: str,
    invocation_id: str,
    user: CurrentUser,
    source: DataSource = "clickhouse",
):
    """Get all spans for a specific invocation within a session."""
    client = _get_client(request, source)
    session = client.get_agent_session(session_id, user_id=user["id"])
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    rows = client.get_spans_by_invocation(session_id, invocation_id)
    return [SpanResponse(**row) for row in rows]


@router.get(
    "/{session_id}/spans/{span_id}",
    response_model=list[SpanResponse],
)
def get_span(
    request: Request,
    session_id: str,
    span_id: str,
    user: CurrentUser,
    source: DataSource = "clickhouse",
):
    """Get all rows for a specific span."""
    client = _get_client(request, source)
    session = client.get_agent_session(session_id, user_id=user["id"])
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    rows = client.get_span(session_id, span_id)
    if not rows:
        raise HTTPException(status_code=404, detail="Span not found")
    return [SpanResponse(**row) for row in rows]


@router.get("/{session_id}/trajectories", response_model=list[AgentTrajectoryResponse])
def get_trajectories(request: Request, session_id: str, user: CurrentUser):
    """Get all trajectory spans for an agent session (ClickHouse only)."""
    ch = _get_clickhouse(request)
    existing = ch.get_agent_session(session_id, user_id=user["id"])
    if existing is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    rows = ch.get_trajectories(session_id)
    return [AgentTrajectoryResponse(**row) for row in rows]


@router.get(
    "/{session_id}/trajectories/{trajectory_uid}",
    response_model=list[AgentTrajectoryResponse],
)
def get_trajectory(request: Request, session_id: str, trajectory_uid: str, user: CurrentUser):
    """Get all spans for a specific trajectory (ClickHouse only)."""
    ch = _get_clickhouse(request)
    existing = ch.get_agent_session(session_id, user_id=user["id"])
    if existing is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    rows = ch.get_trajectory(session_id, trajectory_uid)
    if not rows:
        raise HTTPException(status_code=404, detail="Trajectory not found")
    return [AgentTrajectoryResponse(**row) for row in rows]
