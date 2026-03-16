"""BigQuery client for agent trace data exported by rllm_telemetry.

Standalone module — NOT part of the DataStore hierarchy.  Handles only
agent sessions (derived from spans) and observability spans stored in
BigQuery.

Key differences from the ClickHouse schema:
- No separate ``agent_sessions`` table — sessions are derived from spans
  via ``GROUP BY session_id``.
- No ``agent_session_id`` column — uses ``session_id`` instead.
- No ``total_tokens`` column — computed as ``input_tokens + output_tokens``.
- ``data`` column is native JSON type (not String).
- ``ingested_at`` is the partition key (TIMESTAMP, REQUIRED).

All methods are read-only.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

from google.cloud import bigquery

logger = logging.getLogger(__name__)


def _ensure_json(value: Any) -> Any:
    """Return *value* as a Python object.

    BigQuery's JSON type may come back as a ``dict``/``list`` (already
    parsed) or as a raw JSON ``str`` — handle both cases.
    """
    if value is None:
        return {}
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return {}
    return value


def _ts_iso(value: Any) -> str | None:
    """Normalise a timestamp value to an ISO-8601 string (or None)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value)


def _nvl(value: Any, default: Any = 0) -> Any:
    """Coalesce None to *default*."""
    return default if value is None else value


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class BigQueryClient:
    """Read-only BigQuery client for agent trace data."""

    def __init__(self) -> None:
        self._project = os.environ.get("BQ_PROJECT")  # None → default from ADC
        self._dataset = os.environ.get("BQ_DATASET", "agent_traces")
        self._table = os.environ.get("BQ_TABLE", "rllm_traces")
        self.client = bigquery.Client(project=self._project)
        # Resolve project from ADC if not explicitly set
        if not self._project:
            self._project = self.client.project
        self._fqn = f"`{self._project}`.`{self._dataset}`.`{self._table}`"
        logger.info("BigQuery client initialised — table %s", self._fqn)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _run(
        self,
        sql: str,
        params: list[bigquery.ScalarQueryParameter] | None = None,
    ) -> list[dict[str, Any]]:
        """Execute a parameterised query and return rows as dicts."""
        job_config = bigquery.QueryJobConfig()
        if params:
            job_config.query_parameters = params
        result = self.client.query(sql, job_config=job_config)
        return [dict(row) for row in result]

    def _run_one(
        self,
        sql: str,
        params: list[bigquery.ScalarQueryParameter] | None = None,
    ) -> dict[str, Any] | None:
        rows = self._run(sql, params)
        return rows[0] if rows else None

    # ------------------------------------------------------------------
    # Row conversion helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _to_session_dict(row: dict[str, Any]) -> dict[str, Any]:
        """Convert a session-aggregate row into the shape expected by
        ``AgentSessionResponse``.
        """
        return {
            "id": row["session_id"],
            "name": row.get("name") or f"session-{row['session_id'][:8]}",
            "status": "completed",
            "metadata": {},
            "created_at": row.get("created_at") or row.get("min_started_at"),
            "completed_at": row.get("completed_at") or row.get("max_ended_at"),
        }

    @staticmethod
    def _to_span_dict(row: dict[str, Any]) -> dict[str, Any]:
        """Convert a spans-table row into the shape expected by
        ``SpanResponse``.
        """
        return {
            "id": row["id"],
            "agent_session_id": row["session_id"],
            "span_type": row["span_type"],
            "span_id": row.get("span_id") or "",
            "invocation_id": row.get("invocation_id") or "",
            "agent_name": row.get("agent_name") or "",
            "model": row.get("model") or "",
            "tool_name": row.get("tool_name") or "",
            "duration_ms": row.get("duration_ms"),
            "error": row.get("error") or "",
            "data": _ensure_json(row.get("data")),
            "created_at": row.get("started_at") or row.get("ingested_at"),
        }

    # ------------------------------------------------------------------
    # Agent sessions (derived from spans via GROUP BY session_id)
    # ------------------------------------------------------------------

    def get_agent_sessions(
        self,
        limit: int = 50,
        offset: int = 0,
        user_id: str | None = None,  # TODO: filter by user_id when BQ is migrated
    ) -> list[dict[str, Any]]:
        """Return sessions derived from spans, most recent first.

        Each "session" is a ``GROUP BY session_id`` over the spans table.
        """
        sql = f"""
            SELECT
                session_id,
                COALESCE(
                    MAX(IF(span_type = 'session', JSON_VALUE(data, '$.app_name'), NULL)),
                    MAX(IF(agent_name IS NOT NULL AND agent_name != '', agent_name, NULL)),
                    CONCAT('session-', SUBSTR(session_id, 1, 8))
                ) AS name,
                MIN(started_at) AS created_at,
                MAX(ended_at) AS completed_at,
                MIN(started_at) AS min_started_at,
                MAX(ended_at) AS max_ended_at
            FROM {self._fqn}
            GROUP BY session_id
            ORDER BY MIN(started_at) DESC
            LIMIT @limit OFFSET @offset
        """
        rows = self._run(sql, [
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
            bigquery.ScalarQueryParameter("offset", "INT64", offset),
        ])
        return [self._to_session_dict(r) for r in rows]

    def count_agent_sessions(self, user_id: str | None = None) -> int:
        """Return the total number of distinct sessions."""
        sql = f"SELECT COUNT(DISTINCT session_id) AS cnt FROM {self._fqn}"
        row = self._run_one(sql)
        return row["cnt"] if row else 0

    def get_agent_session(self, session_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        """Return a single session (derived from its spans)."""
        sql = f"""
            SELECT
                session_id,
                COALESCE(
                    MAX(IF(span_type = 'session', JSON_VALUE(data, '$.app_name'), NULL)),
                    MAX(IF(agent_name IS NOT NULL AND agent_name != '', agent_name, NULL)),
                    CONCAT('session-', SUBSTR(session_id, 1, 8))
                ) AS name,
                MIN(started_at) AS created_at,
                MAX(ended_at) AS completed_at,
                MIN(started_at) AS min_started_at,
                MAX(ended_at) AS max_ended_at
            FROM {self._fqn}
            WHERE session_id = @session_id
            GROUP BY session_id
        """
        row = self._run_one(sql, [
            bigquery.ScalarQueryParameter("session_id", "STRING", session_id),
        ])
        if row is None:
            return None
        return self._to_session_dict(row)

    # ------------------------------------------------------------------
    # Spans
    # ------------------------------------------------------------------

    def get_spans(
        self,
        session_id: str,
        span_type: str | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Return spans for a session, optionally filtered by type."""
        where = "WHERE session_id = @session_id"
        params: list[bigquery.ScalarQueryParameter] = [
            bigquery.ScalarQueryParameter("session_id", "STRING", session_id),
        ]
        if span_type:
            where += " AND span_type = @span_type"
            params.append(
                bigquery.ScalarQueryParameter("span_type", "STRING", span_type),
            )
        params.extend([
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
            bigquery.ScalarQueryParameter("offset", "INT64", offset),
        ])
        sql = f"""
            SELECT *
            FROM {self._fqn}
            {where}
            ORDER BY started_at
            LIMIT @limit OFFSET @offset
        """
        rows = self._run(sql, params)
        return [self._to_span_dict(r) for r in rows]

    def count_spans(
        self,
        session_id: str,
        span_type: str | None = None,
    ) -> int:
        """Count spans for a session, optionally filtered by type."""
        where = "WHERE session_id = @session_id"
        params: list[bigquery.ScalarQueryParameter] = [
            bigquery.ScalarQueryParameter("session_id", "STRING", session_id),
        ]
        if span_type:
            where += " AND span_type = @span_type"
            params.append(
                bigquery.ScalarQueryParameter("span_type", "STRING", span_type),
            )
        sql = f"SELECT COUNT(*) AS cnt FROM {self._fqn} {where}"
        row = self._run_one(sql, params)
        return row["cnt"] if row else 0

    def get_spans_by_invocation(
        self,
        session_id: str,
        invocation_id: str,
    ) -> list[dict[str, Any]]:
        """Return all spans for a specific invocation within a session."""
        sql = f"""
            SELECT *
            FROM {self._fqn}
            WHERE session_id = @session_id
              AND invocation_id = @invocation_id
            ORDER BY started_at
        """
        rows = self._run(sql, [
            bigquery.ScalarQueryParameter("session_id", "STRING", session_id),
            bigquery.ScalarQueryParameter("invocation_id", "STRING", invocation_id),
        ])
        return [self._to_span_dict(r) for r in rows]

    def get_span(
        self,
        session_id: str,
        span_id: str,
    ) -> list[dict[str, Any]]:
        """Return all rows for a specific span (start + end events share
        the same ``span_id``).
        """
        sql = f"""
            SELECT *
            FROM {self._fqn}
            WHERE session_id = @session_id
              AND span_id = @span_id
            ORDER BY started_at
        """
        rows = self._run(sql, [
            bigquery.ScalarQueryParameter("session_id", "STRING", session_id),
            bigquery.ScalarQueryParameter("span_id", "STRING", span_id),
        ])
        return [self._to_span_dict(r) for r in rows]

    # ------------------------------------------------------------------
    # Dashboard aggregates
    # ------------------------------------------------------------------

    def get_dashboard_stats(self, days: int = 7, user_id: str | None = None) -> dict[str, Any]:
        """Aggregate statistics across all spans within the time window."""
        sql = f"""
            SELECT
                COUNT(*) AS total_spans,
                COUNTIF(span_type = 'llm.end') AS llm_calls,
                COUNTIF(span_type = 'tool.end') AS tool_calls,
                COUNTIF(span_type = 'invocation.start') AS invocations,
                COALESCE(SUM(IF(span_type = 'llm.end', IFNULL(input_tokens, 0) + IFNULL(output_tokens, 0), 0)), 0) AS total_tokens,
                COALESCE(SUM(IF(span_type = 'llm.end', input_tokens, 0)), 0) AS total_input_tokens,
                COALESCE(SUM(IF(span_type = 'llm.end', output_tokens, 0)), 0) AS total_output_tokens,
                AVG(IF(span_type = 'llm.end' AND duration_ms > 0, duration_ms, NULL)) AS avg_llm_latency_ms,
                AVG(IF(span_type = 'tool.end' AND duration_ms > 0, duration_ms, NULL)) AS avg_tool_latency_ms,
                COUNTIF(error IS NOT NULL AND error != '') AS error_count
            FROM {self._fqn}
            WHERE ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        """
        row = self._run_one(sql, [
            bigquery.ScalarQueryParameter("days", "INT64", days),
        ])
        if not row:
            return {
                "total_spans": 0,
                "llm_calls": 0,
                "tool_calls": 0,
                "invocations": 0,
                "total_tokens": 0,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "avg_llm_latency_ms": 0,
                "avg_tool_latency_ms": 0,
                "error_count": 0,
            }
        return {k: _nvl(v) for k, v in row.items()}

    def get_span_timeseries(self, days: int = 7, user_id: str | None = None) -> list[dict[str, Any]]:
        """Time-bucketed span counts for charting."""
        sql = f"""
            SELECT
                TIMESTAMP_TRUNC(ingested_at, HOUR) AS bucket,
                COUNT(*) AS total,
                COUNTIF(span_type = 'llm.end') AS llm_calls,
                COUNTIF(span_type = 'tool.end') AS tool_calls,
                COUNTIF(span_type LIKE 'agent.%') AS agent_spans,
                COALESCE(SUM(IF(span_type = 'llm.end', IFNULL(input_tokens, 0) + IFNULL(output_tokens, 0), 0)), 0) AS tokens,
                COUNTIF(error IS NOT NULL AND error != '') AS errors
            FROM {self._fqn}
            WHERE ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
            GROUP BY bucket
            ORDER BY bucket
        """
        rows = self._run(sql, [
            bigquery.ScalarQueryParameter("days", "INT64", days),
        ])
        for row in rows:
            for k in row:
                if row[k] is None and k != "bucket":
                    row[k] = 0
        return rows

    def get_top_models(
        self,
        days: int = 7,
        limit: int = 10,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Most-used models with token counts."""
        sql = f"""
            SELECT
                model,
                COUNT(*) AS call_count,
                COALESCE(SUM(IFNULL(input_tokens, 0) + IFNULL(output_tokens, 0)), 0) AS total_tokens,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                AVG(duration_ms) AS avg_latency_ms
            FROM {self._fqn}
            WHERE span_type = 'llm.end'
              AND model IS NOT NULL AND model != ''
              AND ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
            GROUP BY model
            ORDER BY call_count DESC
            LIMIT @limit
        """
        rows = self._run(sql, [
            bigquery.ScalarQueryParameter("days", "INT64", days),
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
        ])
        for row in rows:
            for k in row:
                if row[k] is None:
                    row[k] = 0
        return rows

    def get_top_tools(
        self,
        days: int = 7,
        limit: int = 10,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Most-used tools with counts and latency."""
        sql = f"""
            SELECT
                tool_name,
                COUNT(*) AS call_count,
                AVG(duration_ms) AS avg_latency_ms,
                COUNTIF(error IS NOT NULL AND error != '') AS error_count
            FROM {self._fqn}
            WHERE span_type = 'tool.end'
              AND tool_name IS NOT NULL AND tool_name != ''
              AND ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
            GROUP BY tool_name
            ORDER BY call_count DESC
            LIMIT @limit
        """
        rows = self._run(sql, [
            bigquery.ScalarQueryParameter("days", "INT64", days),
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
        ])
        for row in rows:
            for k in row:
                if row[k] is None:
                    row[k] = 0
        return rows

    def get_session_count(self, days: int = 7, user_id: str | None = None) -> dict[str, int]:
        """Session counts within the time window.

        All BigQuery sessions are treated as ``completed`` since the data
        is post-hoc exported.
        """
        sql = f"""
            SELECT COUNT(DISTINCT session_id) AS total
            FROM {self._fqn}
            WHERE ingested_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        """
        row = self._run_one(sql, [
            bigquery.ScalarQueryParameter("days", "INT64", days),
        ])
        total = row["total"] if row else 0
        return {
            "total": total,
            "running": 0,
            "completed": total,
            "failed": 0,
        }

    def get_span_activity(self, user_id: str | None = None) -> list[dict[str, Any]]:
        """Daily span counts over the full stored time range."""
        sql = f"""
            SELECT DATE(ingested_at) AS day, COUNT(*) AS count
            FROM {self._fqn}
            GROUP BY day ORDER BY day
        """
        return self._run(sql, [])

    # ------------------------------------------------------------------
    # Batch validation
    # ------------------------------------------------------------------

    def check_session_ids_exist(self, session_ids: list[str], user_id: str | None = None) -> set[str]:
        """Return the subset of session_ids that exist in spans."""
        if not session_ids:
            return set()
        sql = f"""
            SELECT DISTINCT session_id
            FROM {self._fqn}
            WHERE session_id IN UNNEST(@session_ids)
        """
        rows = self._run(sql, [
            bigquery.ArrayQueryParameter("session_ids", "STRING", list(session_ids)),
        ])
        return {row["session_id"] for row in rows}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def delete_all(self) -> dict[str, int]:
        """Delete all rows from the traces table. Returns count of deleted rows."""
        count_row = self._run_one(f"SELECT COUNT(*) AS cnt FROM {self._fqn}")
        count = count_row["cnt"] if count_row else 0
        # BigQuery DML DELETE requires a WHERE clause
        self.client.query(f"DELETE FROM {self._fqn} WHERE TRUE").result()
        return {"traces": count}

    def close(self) -> None:
        """Close the underlying BigQuery client transport."""
        if self.client:
            self.client.close()
