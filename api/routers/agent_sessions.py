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

import local_settings
from auth import DEPLOYMENT_MODE, CurrentUser
from encryption import decrypt_value
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


def _get_user_bq_settings(request: Request, user: dict) -> tuple[str | None, str | None]:
    """Return (bq_project, bq_dataset) from user settings, or (None, None)."""
    try:
        store = request.app.state.store
        encrypted = store.get_user_settings(user["id"])
        project = decrypt_value(encrypted["bq_project"]) if "bq_project" in encrypted else None
        dataset = decrypt_value(encrypted["bq_dataset"]) if "bq_dataset" in encrypted else None
        return project, dataset
    except Exception:
        return None, None


def _get_bigquery(request: Request, user: dict | None = None):
    """Extract the BigQuery client, preferring user/local settings over global config."""
    from datastore.bigquery_client import BigQueryClient

    # In local mode, use local_settings JSON as the source of truth
    if DEPLOYMENT_MODE == "local":
        project = local_settings.get("bq_project")
        if project:
            dataset = local_settings.get("bq_dataset") or "agent_traces"
            table = local_settings.get("bq_table") or "rllm_traces"
            # Re-use cached client if config hasn't changed
            bq = getattr(request.app.state, "bigquery", None)
            if bq and bq._project == project and bq._dataset == dataset and bq._table == table:
                return bq
            try:
                bq = BigQueryClient(project=project, dataset=dataset, table=table)
                request.app.state.bigquery = bq
                return bq
            except Exception as exc:
                raise HTTPException(
                    status_code=503,
                    detail=f"Failed to initialize BigQuery client: {exc}",
                ) from exc
        raise HTTPException(
            status_code=503,
            detail="BigQuery not configured. Go to Settings to set your GCP project.",
        )

    # Cloud mode: check per-user BQ settings first
    if user:
        project, dataset = _get_user_bq_settings(request, user)
        if project:
            try:
                return BigQueryClient(project=project, dataset=dataset or None)
            except Exception as exc:
                raise HTTPException(
                    status_code=503,
                    detail=f"Failed to initialize BigQuery client with your settings: {exc}",
                ) from exc

    # Fall back to global BigQuery client
    bq = getattr(request.app.state, "bigquery", None)
    if bq is None:
        try:
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


def _get_client(request: Request, source: DataSource, user: dict | None = None):
    """Get the appropriate data source client."""
    if source == "bigquery":
        return _get_bigquery(request, user=user)
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
    # BigQuery available via global config OR user settings
    # BigQuery: check local settings (local mode), global config, or per-user settings
    if getattr(request.app.state, "bigquery", None) is not None:
        sources.append("bigquery")
    elif DEPLOYMENT_MODE == "local" and local_settings.get("bq_project"):
        sources.append("bigquery")
    elif user:
        project, _ = _get_user_bq_settings(request, user)
        if project:
            sources.append("bigquery")
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
        # BigQuery delete is disabled — BQ data is shared/read-only.
        raise HTTPException(status_code=400, detail="Cannot delete BigQuery data from the UI. BigQuery is a read-only source.")
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
    client = _get_client(request, source, user=user)
    uid = user["id"]
    stats = client.get_dashboard_stats(days, user_id=uid)
    timeseries = client.get_span_timeseries(days, user_id=uid)
    models = client.get_top_models(days, user_id=uid)
    tools = client.get_top_tools(days, user_id=uid)

    # BigQuery includes total_sessions in the stats query to avoid a
    # redundant full-table scan; other backends use a separate call.
    if "total_sessions" in stats:
        total = stats.pop("total_sessions")
        sessions = {"total": total, "running": 0, "completed": total, "failed": 0}
    else:
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
    client = _get_client(request, source, user=user)
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
    client = _get_client(request, source, user=user)
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
    client = _get_client(request, source, user=user)
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
    client = _get_client(request, source, user=user)
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
    client = _get_client(request, source, user=user)
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
    client = _get_client(request, source, user=user)
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
