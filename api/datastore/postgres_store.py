"""PostgreSQL implementation of DataStore."""

import json
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

from .base import DataStore, extract_searchable_text


class PostgresStore(DataStore):
    """PostgreSQL-backed data store."""

    def __init__(self, url: str):
        self.url = url
        self._conn = None

    @contextmanager
    def _get_conn(self):
        """Get a database connection with RealDictCursor for dict-like row access."""
        conn = psycopg2.connect(self.url, cursor_factory=RealDictCursor, connect_timeout=5)
        try:
            yield conn
        finally:
            conn.close()

    def init_db(self):
        """Initialize the database schema."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                # Projects table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS projects (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL UNIQUE,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Sessions table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS sessions (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        experiment TEXT NOT NULL,
                        config JSONB,
                        source_metadata JSONB,
                        color TEXT,
                        status TEXT DEFAULT 'running',
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        completed_at TIMESTAMP,
                        last_heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Metrics table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS metrics (
                        id SERIAL PRIMARY KEY,
                        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                        step INTEGER,
                        data JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Episodes table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS episodes (
                        id TEXT PRIMARY KEY,
                        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                        step INTEGER,
                        task JSONB,
                        is_correct BOOLEAN,
                        termination_reason TEXT,
                        trajectories JSONB,
                        metrics JSONB,
                        info JSONB,
                        search_text TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Create indexes for better query performance
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_metrics_session_id ON metrics(session_id)
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_episodes_session_id ON episodes(session_id)
                """)
                # GIN index for fast full-text search
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_episodes_search
                    ON episodes USING GIN(to_tsvector('english', COALESCE(search_text, '')))
                """)

                # Logs table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS logs (
                        id SERIAL PRIMARY KEY,
                        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                        timestamp TEXT NOT NULL,
                        stream TEXT NOT NULL DEFAULT 'stdout',
                        message TEXT NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_logs_session_id ON logs(session_id)
                """)

                # Trajectory groups table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS trajectory_groups (
                        id TEXT PRIMARY KEY,
                        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                        step INTEGER,
                        group_id TEXT,
                        task_id TEXT,
                        trajectory_name TEXT,
                        num_trajectories INTEGER,
                        avg_reward REAL,
                        metadata JSONB,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                conn.commit()

    def reset(self):
        """Reset the data store by dropping and recreating all tables."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("DROP TABLE IF EXISTS logs CASCADE")
                cursor.execute("DROP TABLE IF EXISTS trajectory_groups CASCADE")
                cursor.execute("DROP TABLE IF EXISTS episodes CASCADE")
                cursor.execute("DROP TABLE IF EXISTS metrics CASCADE")
                cursor.execute("DROP TABLE IF EXISTS sessions CASCADE")
                cursor.execute("DROP TABLE IF EXISTS projects CASCADE")
                conn.commit()
        self.init_db()

    # ── Project methods ──────────────────────────────────────────────

    def get_or_create_project(self, name: str) -> str:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM projects WHERE name = %s", (name,))
                row = cursor.fetchone()
                if row:
                    return row["id"]
                project_id = str(uuid.uuid4())
                cursor.execute("INSERT INTO projects (id, name) VALUES (%s, %s)", (project_id, name))
                conn.commit()
                return project_id

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT * FROM projects WHERE id = %s", (project_id,))
                row = cursor.fetchone()
                if row:
                    return dict(row)
        return None

    def rename_project(self, project_id: str, new_name: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
                if not cursor.fetchone():
                    return None
                cursor.execute("SELECT id FROM projects WHERE name = %s AND id != %s", (new_name, project_id))
                if cursor.fetchone():
                    raise ValueError(f"Project name '{new_name}' already exists")
                cursor.execute("UPDATE projects SET name = %s WHERE id = %s", (new_name, project_id))
                conn.commit()
                cursor.execute("SELECT * FROM projects WHERE id = %s", (project_id,))
                return dict(cursor.fetchone())

    def delete_project(self, project_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
                if not cursor.fetchone():
                    return False
                cursor.execute("DELETE FROM projects WHERE id = %s", (project_id,))
                conn.commit()
                return True

    def update_session(self, session_id: str, experiment: str | None = None, color: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM sessions WHERE id = %s", (session_id,))
                if not cursor.fetchone():
                    return None
                if experiment is not None:
                    cursor.execute("UPDATE sessions SET experiment = %s WHERE id = %s", (experiment, session_id))
                if color is not None:
                    cursor.execute("UPDATE sessions SET color = %s WHERE id = %s", (color, session_id))
                conn.commit()
        return self.get_session(session_id)

    def delete_session(self, session_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM sessions WHERE id = %s", (session_id,))
                if not cursor.fetchone():
                    return False
                cursor.execute("DELETE FROM sessions WHERE id = %s", (session_id,))
                conn.commit()
                return True

    # ── Session methods ──────────────────────────────────────────────

    def create_session(self, project: str, experiment: str, config: dict[str, Any], source_metadata: dict[str, Any]) -> str:
        """Create a new training session."""
        project_id = self.get_or_create_project(project)
        session_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO sessions (id, project_id, experiment, config, source_metadata)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (session_id, project_id, experiment, json.dumps(config), json.dumps(source_metadata)),
                )
                conn.commit()
        return session_id

    def log_metrics(self, session_id: str, step: int, data: dict[str, Any]) -> dict[str, Any] | None:
        """Log metrics for a session."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO metrics (session_id, step, data)
                    VALUES (%s, %s, %s)
                    RETURNING id, session_id, step, data, created_at
                    """,
                    (session_id, step, json.dumps(data)),
                )
                row = cursor.fetchone()
                conn.commit()
                if row:
                    return dict(row)
        return None

    def append_episode(self, session_id: str, episode_data: dict[str, Any]):
        """Append an episode to a session."""
        ep_id = episode_data.get("episode_id")
        step = episode_data.get("step")
        task = json.dumps(episode_data.get("task"))
        is_correct = episode_data.get("is_correct")
        termination_reason = episode_data.get("termination_reason")
        trajectories = json.dumps(episode_data.get("trajectories", []))
        metrics = json.dumps(episode_data.get("metrics"))
        info = json.dumps(episode_data.get("info"))

        search_text = extract_searchable_text(episode_data)

        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO episodes (id, session_id, step, task, is_correct, termination_reason, trajectories, metrics, info, search_text)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (ep_id, session_id, step, task, is_correct, termination_reason, trajectories, metrics, info, search_text),
                )
                conn.commit()

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        """Retrieve session details."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT s.*, p.name AS project FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = %s",
                    (session_id,),
                )
                row = cursor.fetchone()
                if row:
                    return dict(row)
        return None

    def get_all_sessions(self) -> list[dict[str, Any]]:
        """Retrieve all sessions."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT s.*, p.name AS project FROM sessions s JOIN projects p ON s.project_id = p.id ORDER BY s.created_at DESC"
                )
                rows = cursor.fetchall()
                return [dict(row) for row in rows]

    def complete_session(self, session_id: str, status: str = "completed") -> dict[str, Any] | None:
        """Mark a session as completed."""
        now = datetime.now(UTC).isoformat()
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE sessions SET completed_at = %s, status = %s WHERE id = %s",
                    (now, status, session_id),
                )
                conn.commit()
        return self.get_session(session_id)

    def heartbeat_session(self, session_id: str) -> bool:
        """Update the last_heartbeat_at timestamp for a session."""
        now = datetime.now(UTC).isoformat()
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE sessions SET last_heartbeat_at = %s WHERE id = %s",
                    (now, session_id),
                )
                rowcount = cursor.rowcount
                conn.commit()
                return rowcount > 0

    def mark_crashed_sessions(self, timeout_seconds: int = 300) -> int:
        """Mark stale running sessions as crashed."""
        from datetime import timedelta

        now = datetime.now(UTC)
        cutoff = (now - timedelta(seconds=timeout_seconds)).isoformat()
        now_iso = now.isoformat()
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE sessions SET status = 'crashed', completed_at = %s WHERE status = 'running' AND last_heartbeat_at < %s",
                    (now_iso, cutoff),
                )
                rowcount = cursor.rowcount
                conn.commit()
                return rowcount

    def get_metrics(self, session_id: str) -> list[dict[str, Any]]:
        """Retrieve metrics for a session."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM metrics WHERE session_id = %s ORDER BY step",
                    (session_id,),
                )
                rows = cursor.fetchall()
                return [dict(row) for row in rows]

    def get_new_metrics(self, session_id: str, last_id: int) -> list[dict[str, Any]]:
        """Retrieve metrics since last_id."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM metrics WHERE session_id = %s AND id > %s ORDER BY id",
                    (session_id, last_id),
                )
                rows = cursor.fetchall()
                return [dict(row) for row in rows]

    def get_episodes(self, session_id: str) -> list[dict[str, Any]]:
        """Retrieve episodes for a session."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM episodes WHERE session_id = %s ORDER BY step",
                    (session_id,),
                )
                rows = cursor.fetchall()
                results = []
                for row in rows:
                    d = dict(row)
                    d.setdefault("trajectories", [])
                    d.setdefault("metrics", {})
                    results.append(d)
                return results

    def get_episode(self, episode_id: str) -> dict[str, Any] | None:
        """Retrieve a specific episode."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT * FROM episodes WHERE id = %s", (episode_id,))
                row = cursor.fetchone()
                if row:
                    d = dict(row)
                    d.setdefault("trajectories", [])
                    d.setdefault("metrics", {})
                    return d
        return None

    def search_episodes(self, query: str, session_id: str | None = None, step: int | None = None) -> dict[str, Any]:
        """Search episodes using PostgreSQL full-text search with ranking."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT plainto_tsquery('english', %s)::text AS query_text", (query,))
                query_result = cursor.fetchone()
                query_text = query_result["query_text"] if query_result else ""
                import re

                matched_terms = re.findall(r"'([^']+)'", query_text)

                sql = """
                    SELECT *,
                           ts_rank(
                               to_tsvector('english', COALESCE(search_text, '')),
                               plainto_tsquery('english', %s)
                           ) AS rank
                    FROM episodes
                    WHERE to_tsvector('english', COALESCE(search_text, ''))
                          @@ plainto_tsquery('english', %s)
                """
                params: list = [query, query]

                if session_id:
                    sql += " AND session_id = %s"
                    params.append(session_id)

                if step is not None:
                    sql += " AND step = %s"
                    params.append(step)

                sql += " ORDER BY rank DESC"

                cursor.execute(sql, params)
                rows = cursor.fetchall()

                results = []
                for row in rows:
                    d = dict(row)
                    d.setdefault("trajectories", [])
                    d.setdefault("metrics", {})
                    results.append(d)

                return {
                    "episodes": results,
                    "matched_terms": matched_terms,
                }

    def search_trajectory_groups(self, query: str, session_id: str | None = None,
                                  step: int | None = None) -> dict[str, Any]:
        """Search trajectory groups using PostgreSQL full-text search."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                # Get matched terms from tsquery for highlighting
                cursor.execute("SELECT plainto_tsquery('english', %s)::text AS query_text", (query,))
                query_result = cursor.fetchone()
                query_text = query_result["query_text"] if query_result else ""
                import re
                matched_terms = re.findall(r"'([^']+)'", query_text)

                like_q = f"%{query}%"
                sql = """
                    SELECT DISTINCT tg.* FROM trajectory_groups tg
                    WHERE (
                        tg.task_id ILIKE %s OR tg.trajectory_name ILIKE %s OR tg.group_id ILIKE %s
                        OR EXISTS (
                            SELECT 1 FROM jsonb_array_elements(tg.metadata) AS m
                            JOIN episodes e ON (m->>'episode_id') = e.id
                            WHERE to_tsvector('english', COALESCE(e.search_text, ''))
                                  @@ plainto_tsquery('english', %s)
                        )
                    )
                """
                params: list = [like_q, like_q, like_q, query]

                if session_id:
                    sql += " AND tg.session_id = %s"
                    params.append(session_id)

                if step is not None:
                    sql += " AND tg.step = %s"
                    params.append(step)

                sql += " ORDER BY tg.created_at"

                cursor.execute(sql, params)
                rows = cursor.fetchall()

                results = []
                for row in rows:
                    d = dict(row)
                    if d.get("metadata") is None:
                        d["metadata"] = []
                    results.append(d)

                return {
                    "groups": results,
                    "matched_terms": matched_terms,
                }

    def append_trajectory_group(self, session_id: str, group_data: dict[str, Any]):
        """Store a trajectory group (metadata only, trajectories live in episodes table)."""
        group_id = group_data.get("group_id", "")
        parts = group_id.split(":", 1)
        task_id = parts[0] if parts else ""
        trajectory_name = parts[1] if len(parts) > 1 else ""

        metadata = group_data.get("metadata", [])

        num_trajectories = group_data.get("num_trajectories", len(metadata))
        avg_reward = group_data.get("avg_reward")

        record_id = str(uuid.uuid4())
        metadata_json = json.dumps(metadata)

        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO trajectory_groups
                    (id, session_id, step, group_id, task_id, trajectory_name,
                     num_trajectories, avg_reward, metadata)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        record_id,
                        session_id,
                        group_data.get("step"),
                        group_id,
                        task_id,
                        trajectory_name,
                        num_trajectories,
                        avg_reward,
                        metadata_json,
                    ),
                )
                conn.commit()

    def get_trajectory_groups(self, session_id: str, step: int | None = None) -> list[dict[str, Any]]:
        """Retrieve trajectory groups for a session (without full trajectory data)."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if step is not None:
                    cursor.execute(
                        "SELECT * FROM trajectory_groups WHERE session_id = %s AND step = %s ORDER BY created_at",
                        (session_id, step),
                    )
                else:
                    cursor.execute(
                        "SELECT * FROM trajectory_groups WHERE session_id = %s ORDER BY step, created_at",
                        (session_id,),
                    )
                rows = cursor.fetchall()

                results = []
                for row in rows:
                    d = dict(row)
                    if d.get("metadata") is None:
                        d["metadata"] = []
                    results.append(d)
                return results

    def get_trajectory_group(self, group_id: str, include_trajectories: bool = True) -> dict[str, Any] | None:
        """Retrieve a specific trajectory group by ID with optional full trajectory data."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT * FROM trajectory_groups WHERE id = %s", (group_id,))
                row = cursor.fetchone()
                if not row:
                    return None

                d = dict(row)
                if d.get("metadata") is None:
                    d["metadata"] = []

                if not include_trajectories:
                    return d

                trajectory_name = d.get("trajectory_name", "")
                episode_ids = [m.get("episode_id") for m in d["metadata"] if m.get("episode_id")]

                if not episode_ids:
                    d["data"] = {"trajectories": [], "metadata": d["metadata"]}
                    return d

                cursor.execute(
                    "SELECT id, trajectories FROM episodes WHERE id = ANY(%s)",
                    (episode_ids,),
                )
                episode_rows = cursor.fetchall()

                episode_map = {}
                for ep_row in episode_rows:
                    ep_trajs = ep_row["trajectories"] if ep_row["trajectories"] else []
                    episode_map[ep_row["id"]] = ep_trajs

                trajectories = []
                for meta in d["metadata"]:
                    ep_id = meta.get("episode_id")
                    if ep_id and ep_id in episode_map:
                        ep_trajs = episode_map[ep_id]
                        for traj in ep_trajs:
                            if traj.get("name") == trajectory_name:
                                trajectories.append(traj)
                                break

                d["data"] = {"trajectories": trajectories, "metadata": d["metadata"]}
                return d

    def get_projects(self) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT * FROM projects ORDER BY created_at")
                project_rows = cursor.fetchall()

                cursor.execute(
                    "SELECT id, project_id, experiment, status, created_at, completed_at FROM sessions ORDER BY created_at DESC"
                )
                session_rows = cursor.fetchall()

                sessions_by_project: dict[str, list] = {}
                for row in session_rows:
                    d = dict(row)
                    pid = d.pop("project_id")
                    if pid not in sessions_by_project:
                        sessions_by_project[pid] = []
                    sessions_by_project[pid].append(d)

                results = []
                for proj_row in project_rows:
                    proj = dict(proj_row)
                    results.append({
                        "id": proj["id"],
                        "project": proj["name"],
                        "sessions": sessions_by_project.get(proj["id"], []),
                    })
                return results

    def append_log(self, session_id: str, log_data: dict) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO logs (session_id, timestamp, stream, message) VALUES (%s, %s, %s, %s)",
                    (session_id, log_data["timestamp"], log_data.get("stream", "stdout"), log_data["message"]),
                )
                conn.commit()

    def get_logs(self, session_id: str, stream: str | None = None, limit: int = 1000, offset: int = 0) -> list[dict]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                sql = "SELECT * FROM logs WHERE session_id = %s"
                params: list = [session_id]
                if stream:
                    sql += " AND stream = %s"
                    params.append(stream)
                sql += " ORDER BY id LIMIT %s OFFSET %s"
                params.extend([limit, offset])
                cursor.execute(sql, params)
                rows = cursor.fetchall()
                return [dict(row) for row in rows]

    def get_new_logs(self, session_id: str, last_id: int) -> list[dict]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM logs WHERE session_id = %s AND id > %s ORDER BY id",
                    (session_id, last_id),
                )
                rows = cursor.fetchall()
                return [dict(row) for row in rows]
