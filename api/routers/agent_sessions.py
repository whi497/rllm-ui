"""Agent session and trajectory span endpoints.

Supports two data source backends:
- ``clickhouse`` (default): Uses ClickHouse for real-time streaming spans.
- ``bigquery``: Reads historical trace data exported by rllm_telemetry.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request

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
        return _get_bigquery(request)
    if source == "postgres":
        return _get_postgres_spans(request)
    return _get_clickhouse(request)


# ------------------------------------------------------------------
# Data source availability
# ------------------------------------------------------------------


@router.get("/sources")
def get_available_sources(request: Request):
    """Return which data sources are configured and available."""
    sources = []
    if getattr(request.app.state, "clickhouse", None) is not None:
        sources.append("clickhouse")
    if getattr(request.app.state, "bigquery", None) is not None:
        sources.append("bigquery")
    if getattr(request.app.state, "postgres_spans", None) is not None:
        sources.append("postgres")
    return {"sources": sources}


# ------------------------------------------------------------------
# Dashboard (aggregate metrics)
# ------------------------------------------------------------------


@router.get("/dashboard", response_model=DashboardResponse)
def get_dashboard(
    request: Request,
    days: int = 7,
    source: DataSource = "clickhouse",
):
    """Get aggregate dashboard metrics across all sessions."""
    client = _get_client(request, source)
    stats = client.get_dashboard_stats(days)
    timeseries = client.get_span_timeseries(days)
    models = client.get_top_models(days)
    tools = client.get_top_tools(days)
    sessions = client.get_session_count(days)
    return DashboardResponse(
        stats=DashboardStats(**stats) if stats else DashboardStats(),
        timeseries=[TimeseriesBucket(**b) for b in timeseries],
        models=[ModelUsage(**m) for m in models],
        tools=[ToolUsage(**t) for t in tools],
        sessions=SessionCounts(**sessions) if sessions else SessionCounts(),
    )


# ------------------------------------------------------------------
# Agent sessions
# ------------------------------------------------------------------


@router.post("", response_model=AgentSessionResponse)
def create_agent_session(request: Request, body: AgentSessionCreate):
    """Create a new agent session (ClickHouse only)."""
    ch = _get_clickhouse(request)
    session_id = str(uuid.uuid4())
    name = body.name or f"agent-{session_id[:8]}"
    ch.insert_agent_session(session_id, name, body.metadata)
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
    source: DataSource = "clickhouse",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """List agent sessions with pagination."""
    client = _get_client(request, source)
    rows = client.get_agent_sessions(limit=limit, offset=offset)
    total = client.count_agent_sessions()
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
    source: DataSource = "clickhouse",
):
    """Get a single agent session."""
    client = _get_client(request, source)
    row = client.get_agent_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return AgentSessionResponse(**row)


@router.post("/{session_id}/complete", response_model=AgentSessionResponse)
def complete_agent_session(request: Request, session_id: str):
    """Mark an agent session as completed (ClickHouse only)."""
    ch = _get_clickhouse(request)
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
):
    """Ingest a single span (ClickHouse only)."""
    ch = _get_clickhouse(request)
    row = ch.insert_span(session_id, body.type, body.data)
    if body.type in _TRAJECTORY_TYPES:
        ch.insert_trajectory(session_id, body.type, body.data)
    return SpanResponse(**row)


@router.get("/{session_id}/spans", response_model=PaginatedSpansResponse)
def get_spans(
    request: Request,
    session_id: str,
    type: str | None = None,
    source: DataSource = "clickhouse",
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    """Get spans for a session with pagination."""
    client = _get_client(request, source)
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
    source: DataSource = "clickhouse",
):
    """Get all spans for a specific invocation within a session."""
    client = _get_client(request, source)
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
    source: DataSource = "clickhouse",
):
    """Get all rows for a specific span."""
    client = _get_client(request, source)
    rows = client.get_span(session_id, span_id)
    if not rows:
        raise HTTPException(status_code=404, detail="Span not found")
    return [SpanResponse(**row) for row in rows]


@router.get("/{session_id}/trajectories", response_model=list[AgentTrajectoryResponse])
def get_trajectories(request: Request, session_id: str):
    """Get all trajectory spans for an agent session (ClickHouse only)."""
    ch = _get_clickhouse(request)
    rows = ch.get_trajectories(session_id)
    return [AgentTrajectoryResponse(**row) for row in rows]


@router.get(
    "/{session_id}/trajectories/{trajectory_uid}",
    response_model=list[AgentTrajectoryResponse],
)
def get_trajectory(request: Request, session_id: str, trajectory_uid: str):
    """Get all spans for a specific trajectory (ClickHouse only)."""
    ch = _get_clickhouse(request)
    rows = ch.get_trajectory(session_id, trajectory_uid)
    if not rows:
        raise HTTPException(status_code=404, detail="Trajectory not found")
    return [AgentTrajectoryResponse(**row) for row in rows]
