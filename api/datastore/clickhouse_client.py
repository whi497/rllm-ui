"""ClickHouse client for agent trajectory data.

Standalone module — NOT part of the DataStore hierarchy.  Handles only
agent sessions and trajectory spans stored in ClickHouse.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

import clickhouse_connect

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Schema definitions — single source of truth
# ---------------------------------------------------------------------------

AGENT_SESSIONS_COLUMNS: OrderedDict[str, str] = OrderedDict(
    [
        ("id", "String"),
        ("name", "String"),
        ("status", "String DEFAULT 'running'"),
        ("metadata", "String DEFAULT '{}'"),
        ("created_at", "DateTime64(3) DEFAULT now64(3)"),
        ("completed_at", "Nullable(DateTime64(3))"),
    ]
)

AGENT_TRAJECTORIES_COLUMNS: OrderedDict[str, str] = OrderedDict(
    [
        # Identity
        ("id", "String"),
        ("agent_session_id", "String"),
        ("span_type", "String"),
        # Trajectory identity
        ("trajectory_uid", "String"),
        ("agent_name", "String DEFAULT ''"),
        # trajectory.start fields
        ("task", "String DEFAULT '{}'"),
        ("metadata", "String DEFAULT '{}'"),
        ("signals", "String DEFAULT '{}'"),
        # trajectory.step fields
        ("step_idx", "Nullable(Int32)"),
        ("input", "String DEFAULT ''"),
        ("output", "String DEFAULT ''"),
        ("action", "String DEFAULT ''"),
        ("reward", "Nullable(Float64)"),
        ("done", "Nullable(UInt8)"),
        # trajectory.end fields
        ("num_steps", "Nullable(Int32)"),
        # Raw payload
        ("data", "String DEFAULT '{}'"),
        # Timestamp
        ("created_at", "DateTime64(3) DEFAULT now64(3)"),
    ]
)


AGENT_SPANS_COLUMNS: OrderedDict[str, str] = OrderedDict(
    [
        # Row identity
        ("id", "String"),
        ("agent_session_id", "String"),
        # Span identity
        ("span_type", "String"),
        ("span_id", "String DEFAULT ''"),
        ("invocation_id", "String DEFAULT ''"),
        ("session_id", "String DEFAULT ''"),
        # Common
        ("agent_name", "String DEFAULT ''"),
        # Timing
        ("started_at", "Nullable(Float64)"),
        ("ended_at", "Nullable(Float64)"),
        ("duration_ms", "Nullable(Float64)"),
        # LLM-specific
        ("model", "String DEFAULT ''"),
        ("input_tokens", "Nullable(Int64)"),
        ("output_tokens", "Nullable(Int64)"),
        ("total_tokens", "Nullable(Int64)"),
        # Tool-specific
        ("tool_name", "String DEFAULT ''"),
        ("tool_type", "String DEFAULT ''"),
        # Error
        ("error", "String DEFAULT ''"),
        # Raw payload
        ("data", "String DEFAULT '{}'"),
        # Timestamp
        ("created_at", "DateTime64(3) DEFAULT now64(3)"),
    ]
)


def _build_create_table(
    table_name: str,
    columns: OrderedDict[str, str],
    *,
    engine: str = "MergeTree()",
    order_by: str = "",
    partition_by: str = "",
) -> str:
    """Generate a CREATE TABLE IF NOT EXISTS statement from a column dict."""
    col_defs = ",\n    ".join(f"{name} {typ}" for name, typ in columns.items())
    ddl = f"CREATE TABLE IF NOT EXISTS {table_name} (\n    {col_defs}\n) ENGINE = {engine}"
    if partition_by:
        ddl += f"\nPARTITION BY {partition_by}"
    if order_by:
        ddl += f"\nORDER BY {order_by}"
    return ddl


def _safe_json(value: Any) -> str:
    """Serialize a value to JSON string, handling None."""
    if value is None:
        return "{}"
    if isinstance(value, str):
        return value
    return json.dumps(value, default=str)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class ClickHouseClient:
    """ClickHouse client for agent trajectory data."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.client = clickhouse_connect.get_client(
            host=os.environ.get("CLICKHOUSE_HOST", "localhost"),
            port=int(os.environ.get("CLICKHOUSE_PORT", "8443")),
            username=os.environ.get("CLICKHOUSE_USER", "default"),
            password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
            database=os.environ.get("CLICKHOUSE_DATABASE", "default"),
            secure=os.environ.get("CLICKHOUSE_SECURE", "true").lower() == "true",
        )

    # ------------------------------------------------------------------
    # Table management
    # ------------------------------------------------------------------

    def init_tables(self) -> None:
        """Create tables if they don't exist."""
        with self._lock:
            self.client.command(
                _build_create_table(
                    "agent_sessions",
                    AGENT_SESSIONS_COLUMNS,
                    order_by="(created_at, id)",
                )
            )
            self.client.command(
                _build_create_table(
                    "agent_trajectories",
                    AGENT_TRAJECTORIES_COLUMNS,
                    order_by="(agent_session_id, trajectory_uid, created_at)",
                    partition_by="toYYYYMM(created_at)",
                )
            )
            self.client.command(
                _build_create_table(
                    "agent_spans",
                    AGENT_SPANS_COLUMNS,
                    order_by="(agent_session_id, invocation_id, span_id, created_at)",
                    partition_by="toYYYYMM(created_at)",
                )
            )
            logger.info("ClickHouse tables initialized")

    # ------------------------------------------------------------------
    # Agent sessions
    # ------------------------------------------------------------------

    def insert_agent_session(
        self,
        session_id: str,
        name: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        with self._lock:
            self.client.insert(
                "agent_sessions",
                [[session_id, name, "running", _safe_json(metadata), datetime.now(timezone.utc), None]],
                column_names=["id", "name", "status", "metadata", "created_at", "completed_at"],
            )

    def get_agent_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            result = self.client.query(
                "SELECT * FROM agent_sessions WHERE id = {sid:String}",
                parameters={"sid": session_id},
            )
        if not result.result_rows:
            return None
        return self._row_to_session_dict(result.column_names, result.result_rows[0])

    def count_agent_sessions(self) -> int:
        with self._lock:
            result = self.client.query("SELECT count() AS cnt FROM agent_sessions")
        if not result.result_rows:
            return 0
        return result.result_rows[0][0]

    def get_agent_sessions(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            result = self.client.query(
                "SELECT * FROM agent_sessions ORDER BY created_at DESC "
                "LIMIT {limit:UInt32} OFFSET {offset:UInt32}",
                parameters={"limit": limit, "offset": offset},
            )
        return [
            self._row_to_session_dict(result.column_names, row)
            for row in result.result_rows
        ]

    def complete_agent_session(self, session_id: str, status: str = "completed") -> dict[str, Any] | None:
        now = datetime.now(timezone.utc)
        with self._lock:
            self.client.command(
                "ALTER TABLE agent_sessions UPDATE status = {status:String}, "
                "completed_at = {now:DateTime64(3)} WHERE id = {sid:String}",
                parameters={"status": status, "now": now, "sid": session_id},
            )
        return self.get_agent_session(session_id)

    # ------------------------------------------------------------------
    # Trajectory spans
    # ------------------------------------------------------------------

    def insert_trajectory(
        self,
        agent_session_id: str,
        span_type: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Insert a single trajectory span and return the row as a dict."""
        row_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)

        # Extract fields from span data based on span type
        trajectory_uid = data.get("uid") or data.get("trajectory_uid", "")
        agent_name = data.get("name", "")
        task = _safe_json(data.get("task"))
        metadata = _safe_json(data.get("metadata"))
        signals = _safe_json(data.get("signals"))
        step_idx = data.get("step_idx")
        input_val = _safe_json(data.get("input", ""))
        output_val = _safe_json(data.get("output", ""))
        action_val = _safe_json(data.get("action", ""))
        reward = data.get("reward")
        done_val = int(data["done"]) if "done" in data and data["done"] is not None else None
        num_steps = data.get("num_steps")
        raw_data = json.dumps(data, default=str)

        with self._lock:
            self.client.insert(
                "agent_trajectories",
                [[
                    row_id,
                    agent_session_id,
                    span_type,
                    trajectory_uid,
                    agent_name,
                    task,
                    metadata,
                    signals,
                    step_idx,
                    input_val,
                    output_val,
                    action_val,
                    reward,
                    done_val,
                    num_steps,
                    raw_data,
                    now,
                ]],
                column_names=[
                    "id",
                    "agent_session_id",
                    "span_type",
                    "trajectory_uid",
                    "agent_name",
                    "task",
                    "metadata",
                    "signals",
                    "step_idx",
                    "input",
                    "output",
                    "action",
                    "reward",
                    "done",
                    "num_steps",
                    "data",
                    "created_at",
                ],
            )

        return {
            "id": row_id,
            "agent_session_id": agent_session_id,
            "span_type": span_type,
            "trajectory_uid": trajectory_uid,
            "agent_name": agent_name,
            "data": data,
            "created_at": now,
        }

    def get_trajectories(self, agent_session_id: str) -> list[dict[str, Any]]:
        """Get all trajectory spans for a session, ordered chronologically."""
        with self._lock:
            result = self.client.query(
                "SELECT * FROM agent_trajectories "
                "WHERE agent_session_id = {sid:String} "
                "ORDER BY trajectory_uid, created_at",
                parameters={"sid": agent_session_id},
            )
        return [
            self._row_to_trajectory_dict(result.column_names, row)
            for row in result.result_rows
        ]

    def get_trajectory(self, agent_session_id: str, trajectory_uid: str) -> list[dict[str, Any]]:
        """Get all spans for a specific trajectory."""
        with self._lock:
            result = self.client.query(
                "SELECT * FROM agent_trajectories "
                "WHERE agent_session_id = {sid:String} "
                "AND trajectory_uid = {tuid:String} "
                "ORDER BY created_at",
                parameters={"sid": agent_session_id, "tuid": trajectory_uid},
            )
        return [
            self._row_to_trajectory_dict(result.column_names, row)
            for row in result.result_rows
        ]

    # ------------------------------------------------------------------
    # Agent spans (real-time observability)
    # ------------------------------------------------------------------

    def insert_span(
        self,
        agent_session_id: str,
        span_type: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Insert a single observability span and return the row as a dict."""
        row_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)

        # Extract promoted columns from the raw span data
        span_id = data.get("span_id") or data.get("invocation_id") or data.get("session_id", "")
        invocation_id = data.get("invocation_id", "")
        session_id = data.get("session_id", "")
        agent_name = data.get("agent_name", "")
        started_at = data.get("started_at")
        ended_at = data.get("ended_at")
        duration_ms = data.get("duration_ms")

        # LLM-specific
        request = data.get("request") or {}
        response = data.get("response") or {}
        model = request.get("model", "")
        usage = response.get("usage") or {}
        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        total_tokens = usage.get("total_tokens")

        # Tool-specific
        tool_name = data.get("tool_name", "")
        tool_type = data.get("tool_type", "")

        # Error
        error = data.get("error", "") or response.get("error_message", "")

        raw_data = json.dumps(data, default=str)

        with self._lock:
            self.client.insert(
                "agent_spans",
                [[
                    row_id,
                    agent_session_id,
                    span_type,
                    span_id,
                    invocation_id,
                    session_id,
                    agent_name,
                    started_at,
                    ended_at,
                    duration_ms,
                    model,
                    input_tokens,
                    output_tokens,
                    total_tokens,
                    tool_name,
                    tool_type,
                    error,
                    raw_data,
                    now,
                ]],
                column_names=[
                    "id",
                    "agent_session_id",
                    "span_type",
                    "span_id",
                    "invocation_id",
                    "session_id",
                    "agent_name",
                    "started_at",
                    "ended_at",
                    "duration_ms",
                    "model",
                    "input_tokens",
                    "output_tokens",
                    "total_tokens",
                    "tool_name",
                    "tool_type",
                    "error",
                    "data",
                    "created_at",
                ],
            )

        return {
            "id": row_id,
            "agent_session_id": agent_session_id,
            "span_type": span_type,
            "span_id": span_id,
            "invocation_id": invocation_id,
            "agent_name": agent_name,
            "model": model,
            "tool_name": tool_name,
            "duration_ms": duration_ms,
            "error": error,
            "data": data,
            "created_at": now,
        }

    def count_spans(self, agent_session_id: str, span_type: str | None = None) -> int:
        with self._lock:
            if span_type:
                result = self.client.query(
                    "SELECT count() AS cnt FROM agent_spans "
                    "WHERE agent_session_id = {sid:String} "
                    "AND span_type = {stype:String}",
                    parameters={"sid": agent_session_id, "stype": span_type},
                )
            else:
                result = self.client.query(
                    "SELECT count() AS cnt FROM agent_spans "
                    "WHERE agent_session_id = {sid:String}",
                    parameters={"sid": agent_session_id},
                )
        if not result.result_rows:
            return 0
        return result.result_rows[0][0]

    def get_spans(
        self,
        agent_session_id: str,
        span_type: str | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Get all spans for a session, optionally filtered by type."""
        with self._lock:
            if span_type:
                result = self.client.query(
                    "SELECT * FROM agent_spans "
                    "WHERE agent_session_id = {sid:String} "
                    "AND span_type = {stype:String} "
                    "ORDER BY created_at "
                    "LIMIT {limit:UInt32} OFFSET {offset:UInt32}",
                    parameters={"sid": agent_session_id, "stype": span_type, "limit": limit, "offset": offset},
                )
            else:
                result = self.client.query(
                    "SELECT * FROM agent_spans "
                    "WHERE agent_session_id = {sid:String} "
                    "ORDER BY created_at "
                    "LIMIT {limit:UInt32} OFFSET {offset:UInt32}",
                    parameters={"sid": agent_session_id, "limit": limit, "offset": offset},
                )
        return [
            self._row_to_span_dict(result.column_names, row)
            for row in result.result_rows
        ]

    def get_spans_by_invocation(
        self,
        agent_session_id: str,
        invocation_id: str,
    ) -> list[dict[str, Any]]:
        """Get all spans for a specific invocation within a session."""
        with self._lock:
            result = self.client.query(
                "SELECT * FROM agent_spans "
                "WHERE agent_session_id = {sid:String} "
                "AND invocation_id = {iid:String} "
                "ORDER BY created_at",
                parameters={"sid": agent_session_id, "iid": invocation_id},
            )
        return [
            self._row_to_span_dict(result.column_names, row)
            for row in result.result_rows
        ]

    def get_span(
        self,
        agent_session_id: str,
        span_id: str,
    ) -> list[dict[str, Any]]:
        """Get all rows for a specific span (start + end events share the same span_id)."""
        with self._lock:
            result = self.client.query(
                "SELECT * FROM agent_spans "
                "WHERE agent_session_id = {sid:String} "
                "AND span_id = {spid:String} "
                "ORDER BY created_at",
                parameters={"sid": agent_session_id, "spid": span_id},
            )
        return [
            self._row_to_span_dict(result.column_names, row)
            for row in result.result_rows
        ]

    # ------------------------------------------------------------------
    # Aggregate dashboard queries
    # ------------------------------------------------------------------

    def get_dashboard_stats(self, days: int = 7) -> dict[str, Any]:
        """Get aggregate statistics across all spans within the time window."""
        with self._lock:
            result = self.client.query(
                "SELECT "
                "  count() AS total_spans, "
                "  countIf(span_type = 'llm.end') AS llm_calls, "
                "  countIf(span_type = 'tool.end') AS tool_calls, "
                "  countIf(span_type = 'invocation.start') AS invocations, "
                "  sumIf(total_tokens, span_type = 'llm.end') AS total_tokens, "
                "  sumIf(input_tokens, span_type = 'llm.end') AS total_input_tokens, "
                "  sumIf(output_tokens, span_type = 'llm.end') AS total_output_tokens, "
                "  avgIf(duration_ms, span_type = 'llm.end' AND duration_ms > 0) AS avg_llm_latency_ms, "
                "  avgIf(duration_ms, span_type = 'tool.end' AND duration_ms > 0) AS avg_tool_latency_ms, "
                "  countIf(error != '') AS error_count "
                "FROM agent_spans "
                "WHERE created_at >= now() - INTERVAL {days:UInt32} DAY",
                parameters={"days": days},
            )
        if not result.result_rows:
            return {}
        row = dict(zip(result.column_names, result.result_rows[0]))
        # Convert None to 0 for numeric fields
        for k in row:
            if row[k] is None:
                row[k] = 0
        return row

    def get_span_timeseries(self, days: int = 7) -> list[dict[str, Any]]:
        """Get time-bucketed span counts for charting."""
        with self._lock:
            result = self.client.query(
                "SELECT "
                "  toStartOfHour(created_at) AS bucket, "
                "  count() AS total, "
                "  countIf(span_type = 'llm.end') AS llm_calls, "
                "  countIf(span_type = 'tool.end') AS tool_calls, "
                "  countIf(span_type LIKE 'agent.%') AS agent_spans, "
                "  sumIf(total_tokens, span_type = 'llm.end') AS tokens, "
                "  countIf(error != '') AS errors "
                "FROM agent_spans "
                "WHERE created_at >= now() - INTERVAL {days:UInt32} DAY "
                "GROUP BY bucket "
                "ORDER BY bucket",
                parameters={"days": days},
            )
        rows = [dict(zip(result.column_names, row)) for row in result.result_rows]
        for row in rows:
            for k in row:
                if row[k] is None and k != "bucket":
                    row[k] = 0
        return rows

    def get_top_models(self, days: int = 7, limit: int = 10) -> list[dict[str, Any]]:
        """Get most used models with token counts."""
        with self._lock:
            result = self.client.query(
                "SELECT "
                "  model, "
                "  count() AS call_count, "
                "  sum(total_tokens) AS total_tokens, "
                "  sum(input_tokens) AS input_tokens, "
                "  sum(output_tokens) AS output_tokens, "
                "  avg(duration_ms) AS avg_latency_ms "
                "FROM agent_spans "
                "WHERE span_type = 'llm.end' AND model != '' "
                "  AND created_at >= now() - INTERVAL {days:UInt32} DAY "
                "GROUP BY model "
                "ORDER BY call_count DESC "
                "LIMIT {limit:UInt32}",
                parameters={"days": days, "limit": limit},
            )
        rows = [dict(zip(result.column_names, row)) for row in result.result_rows]
        for row in rows:
            for k in row:
                if row[k] is None:
                    row[k] = 0
        return rows

    def get_top_tools(self, days: int = 7, limit: int = 10) -> list[dict[str, Any]]:
        """Get most used tools with counts and latency."""
        with self._lock:
            result = self.client.query(
                "SELECT "
                "  tool_name, "
                "  count() AS call_count, "
                "  avg(duration_ms) AS avg_latency_ms, "
                "  countIf(error != '') AS error_count "
                "FROM agent_spans "
                "WHERE span_type = 'tool.end' AND tool_name != '' "
                "  AND created_at >= now() - INTERVAL {days:UInt32} DAY "
                "GROUP BY tool_name "
                "ORDER BY call_count DESC "
                "LIMIT {limit:UInt32}",
                parameters={"days": days, "limit": limit},
            )
        rows = [dict(zip(result.column_names, row)) for row in result.result_rows]
        for row in rows:
            for k in row:
                if row[k] is None:
                    row[k] = 0
        return rows

    def get_session_count(self, days: int = 7) -> dict[str, int]:
        """Get session counts by status within the time window."""
        with self._lock:
            result = self.client.query(
                "SELECT "
                "  count() AS total, "
                "  countIf(status = 'running') AS running, "
                "  countIf(status = 'completed') AS completed, "
                "  countIf(status = 'failed') AS failed "
                "FROM agent_sessions "
                "WHERE created_at >= now() - INTERVAL {days:UInt32} DAY",
                parameters={"days": days},
            )
        if not result.result_rows:
            return {"total": 0, "running": 0, "completed": 0, "failed": 0}
        return dict(zip(result.column_names, result.result_rows[0]))

    # ------------------------------------------------------------------
    # Batch validation
    # ------------------------------------------------------------------

    def check_session_ids_exist(self, session_ids: list[str]) -> set[str]:
        """Return the subset of session_ids that exist in agent_sessions."""
        if not session_ids:
            return set()
        with self._lock:
            result = self.client.query(
                "SELECT id FROM agent_sessions WHERE id IN {ids:Array(String)}",
                parameters={"ids": list(session_ids)},
            )
        return {row[0] for row in result.result_rows}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_session_dict(column_names: list[str], row: tuple) -> dict[str, Any]:
        d = dict(zip(column_names, row))
        # Parse JSON metadata
        if isinstance(d.get("metadata"), str):
            try:
                d["metadata"] = json.loads(d["metadata"])
            except (json.JSONDecodeError, TypeError):
                d["metadata"] = {}
        return d

    @staticmethod
    def _row_to_trajectory_dict(column_names: list[str], row: tuple) -> dict[str, Any]:
        d = dict(zip(column_names, row))
        # Parse JSON fields
        for field in ("task", "metadata", "signals", "data"):
            if isinstance(d.get(field), str):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass
        # Parse input/output/action if they look like JSON
        for field in ("input", "output", "action"):
            if isinstance(d.get(field), str) and d[field].startswith(("{", "[")):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass
        return d

    @staticmethod
    def _row_to_span_dict(column_names: list[str], row: tuple) -> dict[str, Any]:
        d = dict(zip(column_names, row))
        # Parse JSON data field
        if isinstance(d.get("data"), str):
            try:
                d["data"] = json.loads(d["data"])
            except (json.JSONDecodeError, TypeError):
                d["data"] = {}
        return d

    def close(self) -> None:
        if self.client:
            self.client.close()
