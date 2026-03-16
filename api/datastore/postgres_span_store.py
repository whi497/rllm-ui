"""PostgreSQL-backed span store — implements the same query interface as
ClickHouseClient and BigQueryClient, reading from imported_agent_sessions
and imported_agent_spans tables.

Used as the 'postgres' data source in the observability UI and distillation pipeline.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool

logger = logging.getLogger(__name__)


class PostgresSpanClient:
    """Postgres-backed span client — mirrors the ClickHouse/BigQuery client interface."""

    def __init__(self, url: str, minconn: int = 2, maxconn: int = 10) -> None:
        self._pool = ThreadedConnectionPool(
            minconn, maxconn, url,
            cursor_factory=RealDictCursor,
            connect_timeout=5,
        )
        self._ensure_indexes()

    def _ensure_indexes(self) -> None:
        """Create indexes if they don't exist (idempotent)."""
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "CREATE INDEX IF NOT EXISTS idx_imported_sessions_created_at "
                        "ON imported_agent_sessions(created_at DESC)"
                    )
                conn.commit()
        except Exception:
            logger.debug("Could not ensure indexes (table may not exist yet)", exc_info=True)

    @contextmanager
    def _get_conn(self):
        conn = self._pool.getconn()
        try:
            yield conn
        finally:
            self._pool.putconn(conn)

    def close(self) -> None:
        if self._pool:
            self._pool.closeall()

    # ------------------------------------------------------------------
    # Span upload CRUD (for the import UI)
    # ------------------------------------------------------------------

    def create_span_upload(
        self,
        upload_id: str,
        filename: str,
        sessions: dict[str, list[dict[str, Any]]],
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Store a span CSV upload: create upload metadata, sessions, and spans in a transaction."""
        total_rows = sum(len(spans) for spans in sessions.values())
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO span_uploads (upload_id, filename, row_count, session_count, user_id) "
                    "VALUES (%s, %s, %s, %s, %s) RETURNING *",
                    (upload_id, filename, total_rows, len(sessions), user_id),
                )
                upload = dict(cur.fetchone())

                for session_id, spans in sessions.items():
                    session_name = f"import-{session_id[:8]}"
                    # Derive timestamps from spans
                    started_ats = [s.get("started_at") for s in spans if s.get("started_at")]
                    ended_ats = [s.get("ended_at") for s in spans if s.get("ended_at")]
                    created_at = datetime.fromtimestamp(min(started_ats), tz=timezone.utc) if started_ats else datetime.now(timezone.utc)
                    completed_at = datetime.fromtimestamp(max(ended_ats), tz=timezone.utc) if ended_ats else None

                    cur.execute(
                        "INSERT INTO imported_agent_sessions (id, name, status, upload_id, created_at, completed_at, user_id) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                        (session_id, session_name, "completed", upload_id, created_at, completed_at, user_id),
                    )

                    for span in spans:
                        span_id = span.get("span_id") or str(uuid.uuid4())
                        data = span.get("data", {})
                        if isinstance(data, str):
                            try:
                                data = json.loads(data)
                            except (json.JSONDecodeError, TypeError):
                                data = {}
                        data_json = json.dumps(data, default=str)

                        # Extract promoted columns from data if not provided at top level
                        invocation_id = span.get("invocation_id") or data.get("invocation_id", "")
                        agent_name = span.get("agent_name") or data.get("agent_name", "")
                        model = span.get("model") or ""
                        tool_name = span.get("tool_name") or ""
                        tool_type = span.get("tool_type") or ""
                        error = span.get("error") or ""
                        duration_ms = span.get("duration_ms")
                        started_at = span.get("started_at")
                        ended_at = span.get("ended_at")
                        input_tokens = span.get("input_tokens")
                        output_tokens = span.get("output_tokens")
                        total_tokens = span.get("total_tokens")

                        # Try extracting from data for LLM spans
                        if span["span_type"].startswith("llm."):
                            request = data.get("request") or {}
                            response = data.get("response") or {}
                            model = model or request.get("model", "")
                            usage = response.get("usage") or {}
                            input_tokens = input_tokens or usage.get("input_tokens")
                            output_tokens = output_tokens or usage.get("output_tokens")
                            total_tokens = total_tokens or usage.get("total_tokens")
                        elif span["span_type"].startswith("tool."):
                            tool_name = tool_name or data.get("tool_name", "")
                            tool_type = tool_type or data.get("tool_type", "")

                        error = error or data.get("error", "") or ""
                        if isinstance(error, dict):
                            error = json.dumps(error, default=str)

                        row_id = str(uuid.uuid4())
                        cur.execute(
                            """INSERT INTO imported_agent_spans
                            (id, agent_session_id, span_type, span_id, invocation_id,
                             agent_name, started_at, ended_at, duration_ms,
                             model, input_tokens, output_tokens, total_tokens,
                             tool_name, tool_type, error, data)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (
                                row_id, session_id, span["span_type"], span_id, invocation_id,
                                agent_name, started_at, ended_at, duration_ms,
                                model, input_tokens, output_tokens, total_tokens,
                                tool_name, tool_type, error, data_json,
                            ),
                        )

                conn.commit()
                return upload

    def get_span_uploads(self, limit: int = 0, offset: int = 0, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                where = "WHERE user_id = %s " if user_id else ""
                params: list = [user_id] if user_id else []
                if limit > 0:
                    cur.execute(
                        f"SELECT * FROM span_uploads {where}ORDER BY created_at DESC LIMIT %s OFFSET %s",
                        (*params, limit, offset),
                    )
                else:
                    cur.execute(f"SELECT * FROM span_uploads {where}ORDER BY created_at DESC", params)
                return [dict(row) for row in cur.fetchall()]

    def count_span_uploads(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if user_id:
                    cur.execute("SELECT count(*) AS cnt FROM span_uploads WHERE user_id = %s", (user_id,))
                else:
                    cur.execute("SELECT count(*) AS cnt FROM span_uploads")
                return cur.fetchone()["cnt"]

    def get_span_upload_sessions(
        self, upload_id: str, limit: int = 0, offset: int = 0, user_id: str | None = None,
    ) -> list[dict[str, Any]] | None:
        """Return sessions for an upload, or None if upload doesn't exist (or doesn't belong to user)."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if user_id:
                    cur.execute("SELECT upload_id FROM span_uploads WHERE upload_id = %s AND user_id = %s", (upload_id, user_id))
                else:
                    cur.execute("SELECT upload_id FROM span_uploads WHERE upload_id = %s", (upload_id,))
                if not cur.fetchone():
                    return None
                query = (
                    "SELECT s.*, "
                    "(SELECT count(*) FROM imported_agent_spans sp WHERE sp.agent_session_id = s.id) AS span_count "
                    "FROM imported_agent_sessions s WHERE s.upload_id = %s ORDER BY s.created_at"
                )
                if limit > 0:
                    query += " LIMIT %s OFFSET %s"
                    cur.execute(query, (upload_id, limit, offset))
                else:
                    cur.execute(query, (upload_id,))
                return [dict(row) for row in cur.fetchall()]

    def count_span_upload_sessions(self, upload_id: str) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) AS cnt FROM imported_agent_sessions WHERE upload_id = %s",
                    (upload_id,),
                )
                return cur.fetchone()["cnt"]

    def delete_span_upload(self, upload_id: str, user_id: str | None = None) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if user_id:
                    cur.execute(
                        "DELETE FROM span_uploads WHERE upload_id = %s AND user_id = %s RETURNING upload_id",
                        (upload_id, user_id),
                    )
                else:
                    cur.execute("DELETE FROM span_uploads WHERE upload_id = %s RETURNING upload_id", (upload_id,))
                deleted = cur.fetchone() is not None
                conn.commit()
                return deleted

    def delete_all(self, user_id: str | None = None) -> dict[str, int]:
        """Delete imported span data. If *user_id* is given, only that user's
        data is removed; otherwise **all** data is deleted.

        Returns counts of deleted rows.
        """
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if user_id:
                    cur.execute(
                        "SELECT count(*) AS cnt FROM imported_agent_spans "
                        "WHERE agent_session_id IN (SELECT id FROM imported_agent_sessions WHERE user_id = %s)",
                        (user_id,),
                    )
                    span_count = cur.fetchone()["cnt"]
                    cur.execute(
                        "SELECT count(*) AS cnt FROM imported_agent_sessions WHERE user_id = %s",
                        (user_id,),
                    )
                    session_count = cur.fetchone()["cnt"]
                    cur.execute(
                        "SELECT count(*) AS cnt FROM span_uploads WHERE user_id = %s",
                        (user_id,),
                    )
                    upload_count = cur.fetchone()["cnt"]
                    # Cascade from span_uploads handles sessions + spans linked via upload
                    cur.execute("DELETE FROM span_uploads WHERE user_id = %s", (user_id,))
                    # Clean up any orphaned sessions/spans for this user not linked to an upload
                    cur.execute(
                        "DELETE FROM imported_agent_spans "
                        "WHERE agent_session_id IN (SELECT id FROM imported_agent_sessions WHERE user_id = %s)",
                        (user_id,),
                    )
                    cur.execute("DELETE FROM imported_agent_sessions WHERE user_id = %s", (user_id,))
                else:
                    cur.execute("SELECT count(*) AS cnt FROM imported_agent_spans")
                    span_count = cur.fetchone()["cnt"]
                    cur.execute("SELECT count(*) AS cnt FROM imported_agent_sessions")
                    session_count = cur.fetchone()["cnt"]
                    cur.execute("SELECT count(*) AS cnt FROM span_uploads")
                    upload_count = cur.fetchone()["cnt"]
                    cur.execute("DELETE FROM span_uploads")
                    cur.execute("DELETE FROM imported_agent_spans")
                    cur.execute("DELETE FROM imported_agent_sessions")
                conn.commit()
                return {
                    "imported_agent_spans": span_count,
                    "imported_agent_sessions": session_count,
                    "span_uploads": upload_count,
                }

    # ------------------------------------------------------------------
    # Agent sessions (mirrors ClickHouseClient / BigQueryClient interface)
    # ------------------------------------------------------------------

    def get_agent_sessions(self, limit: int = 50, offset: int = 0, user_id: str | None = None) -> list[dict[str, Any]]:
        t0 = time.perf_counter()
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                where = "WHERE s.user_id = %s " if user_id else ""
                params: list = [user_id] if user_id else []
                cur.execute(
                    f"""SELECT s.*, COALESCE(c.cnt, 0) AS span_count
                    FROM imported_agent_sessions s
                    LEFT JOIN LATERAL (
                        SELECT count(*) AS cnt
                        FROM imported_agent_spans
                        WHERE agent_session_id = s.id
                    ) c ON TRUE
                    {where}ORDER BY s.created_at DESC LIMIT %s OFFSET %s""",
                    (*params, limit, offset),
                )
                rows = [self._to_session_dict(row) for row in cur.fetchall()]
        elapsed = time.perf_counter() - t0
        logger.info("get_agent_sessions(limit=%s, offset=%s) returned %d rows in %.3fs", limit, offset, len(rows), elapsed)
        return rows

    def count_agent_sessions(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if user_id:
                    cur.execute("SELECT count(*) AS cnt FROM imported_agent_sessions WHERE user_id = %s", (user_id,))
                else:
                    cur.execute("SELECT count(*) AS cnt FROM imported_agent_sessions")
                return cur.fetchone()["cnt"]

    def get_agent_session(self, session_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if user_id:
                    cur.execute("SELECT * FROM imported_agent_sessions WHERE id = %s AND user_id = %s", (session_id, user_id))
                else:
                    cur.execute("SELECT * FROM imported_agent_sessions WHERE id = %s", (session_id,))
                row = cur.fetchone()
                return self._to_session_dict(row) if row else None

    def get_session_summaries(self, session_ids: list[str]) -> dict[str, dict[str, Any]]:
        """Return session metadata + span stats for a batch of session IDs.
        Returns a dict keyed by session_id."""
        if not session_ids:
            return {}
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT
                        s.id, s.name, s.status, s.created_at, s.completed_at,
                        COALESCE(c.span_count, 0) AS span_count,
                        COALESCE(c.llm_calls, 0) AS llm_calls,
                        COALESCE(c.tool_calls, 0) AS tool_calls,
                        c.agent_name
                    FROM imported_agent_sessions s
                    LEFT JOIN LATERAL (
                        SELECT
                            count(*) AS span_count,
                            count(*) FILTER (WHERE span_type = 'llm.end') AS llm_calls,
                            count(*) FILTER (WHERE span_type = 'tool.end') AS tool_calls,
                            MAX(agent_name) FILTER (WHERE agent_name != '') AS agent_name
                        FROM imported_agent_spans sp
                        WHERE sp.agent_session_id = s.id
                    ) c ON TRUE
                    WHERE s.id = ANY(%s)""",
                    (session_ids,),
                )
                result = {}
                for row in cur.fetchall():
                    d = dict(row)
                    result[d["id"]] = d
                return result

    def check_session_ids_exist(self, session_ids: list[str], user_id: str | None = None) -> set[str]:
        if not session_ids:
            return set()
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if user_id:
                    cur.execute(
                        "SELECT id FROM imported_agent_sessions WHERE id = ANY(%s) AND user_id = %s",
                        (session_ids, user_id),
                    )
                else:
                    cur.execute(
                        "SELECT id FROM imported_agent_sessions WHERE id = ANY(%s)",
                        (session_ids,),
                    )
                return {row["id"] for row in cur.fetchall()}

    # ------------------------------------------------------------------
    # Spans (mirrors ClickHouseClient / BigQueryClient interface)
    # ------------------------------------------------------------------

    def get_spans(
        self,
        session_id: str,
        span_type: str | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if span_type:
                    cur.execute(
                        "SELECT * FROM imported_agent_spans "
                        "WHERE agent_session_id = %s AND span_type = %s "
                        "ORDER BY created_at LIMIT %s OFFSET %s",
                        (session_id, span_type, limit, offset),
                    )
                else:
                    cur.execute(
                        "SELECT * FROM imported_agent_spans "
                        "WHERE agent_session_id = %s "
                        "ORDER BY created_at LIMIT %s OFFSET %s",
                        (session_id, limit, offset),
                    )
                return [self._to_span_dict(row) for row in cur.fetchall()]

    def count_spans(self, session_id: str, span_type: str | None = None) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if span_type:
                    cur.execute(
                        "SELECT count(*) AS cnt FROM imported_agent_spans "
                        "WHERE agent_session_id = %s AND span_type = %s",
                        (session_id, span_type),
                    )
                else:
                    cur.execute(
                        "SELECT count(*) AS cnt FROM imported_agent_spans WHERE agent_session_id = %s",
                        (session_id,),
                    )
                return cur.fetchone()["cnt"]

    def get_spans_by_invocation(self, session_id: str, invocation_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM imported_agent_spans "
                    "WHERE agent_session_id = %s AND invocation_id = %s "
                    "ORDER BY created_at",
                    (session_id, invocation_id),
                )
                return [self._to_span_dict(row) for row in cur.fetchall()]

    def get_span(self, session_id: str, span_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM imported_agent_spans "
                    "WHERE agent_session_id = %s AND span_id = %s "
                    "ORDER BY created_at",
                    (session_id, span_id),
                )
                return [self._to_span_dict(row) for row in cur.fetchall()]

    # ------------------------------------------------------------------
    # Trajectories (reconstructed from trajectory.* spans)
    # ------------------------------------------------------------------

    def get_trajectories(self, session_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM imported_agent_spans "
                    "WHERE agent_session_id = %s AND span_type LIKE 'trajectory.%%' "
                    "ORDER BY created_at",
                    (session_id,),
                )
                results = []
                for row in cur.fetchall():
                    d = dict(row)
                    data = d.get("data") or {}
                    if isinstance(data, str):
                        try:
                            data = json.loads(data)
                        except (json.JSONDecodeError, TypeError):
                            data = {}
                    results.append({
                        "id": d["id"],
                        "agent_session_id": d["agent_session_id"],
                        "span_type": d["span_type"],
                        "trajectory_uid": data.get("uid") or data.get("trajectory_uid", ""),
                        "agent_name": data.get("name") or d.get("agent_name", ""),
                        "task": data.get("task", {}),
                        "metadata": data.get("metadata", {}),
                        "signals": data.get("signals", {}),
                        "step_idx": data.get("step_idx"),
                        "input": data.get("input", ""),
                        "output": data.get("output", ""),
                        "action": data.get("action", ""),
                        "reward": data.get("reward"),
                        "done": data.get("done"),
                        "num_steps": data.get("num_steps"),
                        "data": data,
                        "created_at": d["created_at"],
                    })
                return results

    def get_trajectory(self, session_id: str, trajectory_uid: str) -> list[dict[str, Any]]:
        """Get trajectory spans filtered by trajectory_uid (stored in data JSON)."""
        all_trajs = self.get_trajectories(session_id)
        return [t for t in all_trajs if t.get("trajectory_uid") == trajectory_uid]

    # ------------------------------------------------------------------
    # Dashboard aggregates
    # ------------------------------------------------------------------

    def _user_session_subquery(self, user_id: str | None) -> str:
        """Return a SQL clause to filter spans by user's sessions."""
        if user_id:
            return "AND agent_session_id IN (SELECT id FROM imported_agent_sessions WHERE user_id = %s) "
        return ""

    def get_dashboard_stats(self, days: int = 7, user_id: str | None = None) -> dict[str, Any]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                user_clause = self._user_session_subquery(user_id)
                params: list = [days]
                if user_id:
                    params.append(user_id)
                cur.execute(
                    f"""SELECT
                        count(*) AS total_spans,
                        count(*) FILTER (WHERE span_type = 'llm.end') AS llm_calls,
                        count(*) FILTER (WHERE span_type = 'tool.end') AS tool_calls,
                        count(*) FILTER (WHERE span_type = 'invocation.start') AS invocations,
                        COALESCE(sum(total_tokens) FILTER (WHERE span_type = 'llm.end'), 0) AS total_tokens,
                        COALESCE(sum(input_tokens) FILTER (WHERE span_type = 'llm.end'), 0) AS total_input_tokens,
                        COALESCE(sum(output_tokens) FILTER (WHERE span_type = 'llm.end'), 0) AS total_output_tokens,
                        avg(duration_ms) FILTER (WHERE span_type = 'llm.end' AND duration_ms > 0) AS avg_llm_latency_ms,
                        avg(duration_ms) FILTER (WHERE span_type = 'tool.end' AND duration_ms > 0) AS avg_tool_latency_ms,
                        count(*) FILTER (WHERE error != '') AS error_count
                    FROM imported_agent_spans
                    WHERE created_at >= NOW() - INTERVAL '%s days'
                    {user_clause}""",
                    params,
                )
                row = dict(cur.fetchone())
                return {k: (v if v is not None else 0) for k, v in row.items()}

    def get_span_timeseries(self, days: int = 7, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                user_clause = self._user_session_subquery(user_id)
                params: list = [days]
                if user_id:
                    params.append(user_id)
                cur.execute(
                    f"""SELECT
                        date_trunc('hour', created_at) AS bucket,
                        count(*) AS total,
                        count(*) FILTER (WHERE span_type = 'llm.end') AS llm_calls,
                        count(*) FILTER (WHERE span_type = 'tool.end') AS tool_calls,
                        count(*) FILTER (WHERE span_type LIKE 'agent.%%') AS agent_spans,
                        COALESCE(sum(total_tokens) FILTER (WHERE span_type = 'llm.end'), 0) AS tokens,
                        count(*) FILTER (WHERE error != '') AS errors
                    FROM imported_agent_spans
                    WHERE created_at >= NOW() - INTERVAL '%s days'
                    {user_clause}
                    GROUP BY bucket ORDER BY bucket""",
                    params,
                )
                rows = [dict(r) for r in cur.fetchall()]
                for row in rows:
                    for k in row:
                        if row[k] is None and k != "bucket":
                            row[k] = 0
                return rows

    def get_top_models(self, days: int = 7, limit: int = 10, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                user_clause = self._user_session_subquery(user_id)
                params: list = [days]
                if user_id:
                    params.append(user_id)
                params.append(limit)
                cur.execute(
                    f"""SELECT
                        model,
                        count(*) AS call_count,
                        COALESCE(sum(total_tokens), 0) AS total_tokens,
                        COALESCE(sum(input_tokens), 0) AS input_tokens,
                        COALESCE(sum(output_tokens), 0) AS output_tokens,
                        avg(duration_ms) AS avg_latency_ms
                    FROM imported_agent_spans
                    WHERE span_type = 'llm.end' AND model != ''
                        AND created_at >= NOW() - INTERVAL '%s days'
                    {user_clause}
                    GROUP BY model ORDER BY call_count DESC LIMIT %s""",
                    params,
                )
                rows = [dict(r) for r in cur.fetchall()]
                for row in rows:
                    for k in row:
                        if row[k] is None:
                            row[k] = 0
                return rows

    def get_top_tools(self, days: int = 7, limit: int = 10, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                user_clause = self._user_session_subquery(user_id)
                params: list = [days]
                if user_id:
                    params.append(user_id)
                params.append(limit)
                cur.execute(
                    f"""SELECT
                        tool_name,
                        count(*) AS call_count,
                        avg(duration_ms) AS avg_latency_ms,
                        count(*) FILTER (WHERE error != '') AS error_count
                    FROM imported_agent_spans
                    WHERE span_type = 'tool.end' AND tool_name != ''
                        AND created_at >= NOW() - INTERVAL '%s days'
                    {user_clause}
                    GROUP BY tool_name ORDER BY call_count DESC LIMIT %s""",
                    params,
                )
                rows = [dict(r) for r in cur.fetchall()]
                for row in rows:
                    for k in row:
                        if row[k] is None:
                            row[k] = 0
                return rows

    def get_session_count(self, days: int = 7, user_id: str | None = None) -> dict[str, int]:
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                user_filter = "AND user_id = %s " if user_id else ""
                params: list = [days]
                if user_id:
                    params.append(user_id)
                cur.execute(
                    f"""SELECT
                        count(*) AS total,
                        count(*) FILTER (WHERE status = 'running') AS running,
                        count(*) FILTER (WHERE status = 'completed') AS completed,
                        count(*) FILTER (WHERE status = 'failed') AS failed
                    FROM imported_agent_sessions
                    WHERE created_at >= NOW() - INTERVAL '%s days'
                    {user_filter}""",
                    params,
                )
                return dict(cur.fetchone())

    def get_span_activity(self, user_id: str | None = None) -> list[dict[str, Any]]:
        """Daily span counts over the full stored time range.

        Uses ``started_at`` (epoch float) as the span's real timestamp since
        ``created_at`` is just the import time.
        """
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                user_clause = self._user_session_subquery(user_id)
                params: list = [user_id] if user_id else []
                cur.execute(
                    f"""SELECT to_timestamp(started_at)::date AS day, count(*) AS count
                    FROM imported_agent_spans
                    WHERE started_at IS NOT NULL
                    {user_clause}
                    GROUP BY day ORDER BY day""",
                    params if params else None,
                )
                return [dict(r) for r in cur.fetchall()]

    # ------------------------------------------------------------------
    # Clustering helpers
    # ------------------------------------------------------------------

    def get_session_start_data(self, session_ids: list[str]) -> dict[str, dict[str, Any]]:
        """Fetch the data JSONB from session.start spans, keyed by session_id."""
        if not session_ids:
            return {}
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT agent_session_id, data
                    FROM imported_agent_spans
                    WHERE agent_session_id = ANY(%s) AND span_type = 'session.start'""",
                    (session_ids,),
                )
                result: dict[str, dict[str, Any]] = {}
                for row in cur.fetchall():
                    d = dict(row)
                    data = d.get("data", {})
                    if isinstance(data, str):
                        try:
                            data = json.loads(data)
                        except (json.JSONDecodeError, TypeError):
                            data = {}
                    result[d["agent_session_id"]] = data or {}
                return result

    def get_session_tool_names(self, session_ids: list[str]) -> dict[str, list[str]]:
        """Fetch distinct tool names per session."""
        if not session_ids:
            return {}
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT agent_session_id, array_agg(DISTINCT tool_name) AS tools
                    FROM imported_agent_spans
                    WHERE agent_session_id = ANY(%s) AND span_type = 'tool.end' AND tool_name != ''
                    GROUP BY agent_session_id""",
                    (session_ids,),
                )
                result: dict[str, list[str]] = {}
                for row in cur.fetchall():
                    d = dict(row)
                    result[d["agent_session_id"]] = d.get("tools") or []
                return result

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _to_session_dict(row) -> dict[str, Any]:
        d = dict(row)
        if isinstance(d.get("metadata"), str):
            try:
                d["metadata"] = json.loads(d["metadata"])
            except (json.JSONDecodeError, TypeError):
                d["metadata"] = {}
        d.setdefault("metadata", {})
        return d

    @staticmethod
    def _to_span_dict(row) -> dict[str, Any]:
        d = dict(row)
        if isinstance(d.get("data"), str):
            try:
                d["data"] = json.loads(d["data"])
            except (json.JSONDecodeError, TypeError):
                d["data"] = {}
        d.setdefault("data", {})
        return d
