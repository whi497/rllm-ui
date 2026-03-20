import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .base import DataStore, extract_searchable_text


def _convert_timestamp(val: bytes) -> datetime:
    """Parse TIMESTAMP column values from SQLite and attach UTC tzinfo."""
    text = val.decode("utf-8")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


sqlite3.register_converter("TIMESTAMP", _convert_timestamp)


class SQLiteStore(DataStore):
    def __init__(self, db_path: str = "rllm_ui.db"):
        self.db_path = Path(__file__).parent.parent / db_path

    @contextmanager
    def _get_conn(self):
        conn = sqlite3.connect(self.db_path, detect_types=sqlite3.PARSE_DECLTYPES)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
        finally:
            conn.close()

    def init_db(self):
        with self._get_conn() as conn:
            cursor = conn.cursor()

            # Projects table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    owner_id TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(name, owner_id)
                )
            """)

            # Sessions table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    experiment TEXT NOT NULL,
                    config JSON,
                    source_metadata JSON,
                    color TEXT,
                    status TEXT DEFAULT 'running',
                    session_type TEXT DEFAULT 'training',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    completed_at TIMESTAMP,
                    last_heartbeat_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Migration: add session_type column to existing sessions tables
            try:
                cursor.execute("ALTER TABLE sessions ADD COLUMN session_type TEXT DEFAULT 'training'")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Metrics table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS metrics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                    step INTEGER,
                    data JSON,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Episodes table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS episodes (
                    id TEXT PRIMARY KEY,
                    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                    step INTEGER,
                    task JSON,
                    is_correct BOOLEAN,
                    termination_reason TEXT,
                    trajectories JSON,
                    metrics JSON,
                    info JSON,
                    artifacts JSON,
                    metadata JSON,
                    search_text TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Migration: add artifacts column to existing episodes tables
            try:
                cursor.execute("ALTER TABLE episodes ADD COLUMN artifacts JSON")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Migration: add metadata column to existing episodes tables
            try:
                cursor.execute("ALTER TABLE episodes ADD COLUMN metadata JSON")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Logs table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                    timestamp TEXT NOT NULL,
                    stream TEXT NOT NULL DEFAULT 'stdout',
                    message TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
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
                    metadata JSON,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Chat sessions table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    title TEXT NOT NULL DEFAULT 'New chat',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Chat messages table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Eval results table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS eval_results (
                    id TEXT PRIMARY KEY,
                    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                    dataset_name TEXT NOT NULL,
                    model TEXT NOT NULL,
                    agent TEXT NOT NULL,
                    score REAL NOT NULL,
                    total INTEGER NOT NULL,
                    correct INTEGER NOT NULL,
                    errors INTEGER NOT NULL,
                    signal_averages JSON,
                    items JSON,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Skills table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS skills (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    category TEXT DEFAULT 'general',
                    confidence REAL DEFAULT 0.0,
                    reward_delta REAL DEFAULT 0.0,
                    success_rate TEXT DEFAULT '',
                    evidence_count INTEGER DEFAULT 0,
                    source_session_ids JSON DEFAULT '[]',
                    tags JSON DEFAULT '[]',
                    is_active BOOLEAN DEFAULT 0,
                    metadata JSON,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Migration: add reward_delta column to existing skills tables
            try:
                cursor.execute("ALTER TABLE skills ADD COLUMN reward_delta REAL DEFAULT 0.0")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Migration: add user_id column to existing skills tables
            try:
                cursor.execute("ALTER TABLE skills ADD COLUMN user_id TEXT")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Span uploads metadata table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS span_uploads (
                    upload_id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    row_count INTEGER DEFAULT 0,
                    session_count INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Imported agent sessions
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS imported_agent_sessions (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL DEFAULT '',
                    status TEXT DEFAULT 'completed',
                    metadata JSON DEFAULT '{}',
                    upload_id TEXT REFERENCES span_uploads(upload_id) ON DELETE CASCADE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    completed_at TIMESTAMP
                )
            """)

            # Imported agent spans
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS imported_agent_spans (
                    id TEXT PRIMARY KEY,
                    agent_session_id TEXT NOT NULL REFERENCES imported_agent_sessions(id) ON DELETE CASCADE,
                    span_type TEXT NOT NULL,
                    span_id TEXT DEFAULT '',
                    invocation_id TEXT DEFAULT '',
                    agent_name TEXT DEFAULT '',
                    started_at REAL,
                    ended_at REAL,
                    duration_ms REAL,
                    model TEXT DEFAULT '',
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    total_tokens INTEGER,
                    tool_name TEXT DEFAULT '',
                    tool_type TEXT DEFAULT '',
                    error TEXT DEFAULT '',
                    data JSON DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Eval uploads metadata table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS eval_uploads (
                    upload_id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    row_count INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Eval upload rows table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS eval_upload_rows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    upload_id TEXT NOT NULL REFERENCES eval_uploads(upload_id) ON DELETE CASCADE,
                    session_id TEXT,
                    agent_trajectory TEXT,
                    ground_truth TEXT,
                    rating TEXT DEFAULT '',
                    trajectory_alignment TEXT DEFAULT '',
                    task_success BOOLEAN,
                    tags TEXT,
                    reference_trajectory TEXT DEFAULT '',
                    reference_state TEXT DEFAULT '',
                    reference_answer TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Background jobs table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS background_jobs (
                    id TEXT PRIMARY KEY,
                    job_type TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    progress TEXT DEFAULT '{}',
                    result TEXT,
                    error TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Session clusters table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS session_clusters (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    task_type TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    member_count INTEGER DEFAULT 0,
                    metadata TEXT DEFAULT '{}',
                    job_id TEXT,
                    user_id TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS session_cluster_members (
                    id TEXT PRIMARY KEY,
                    cluster_id TEXT NOT NULL REFERENCES session_clusters(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    labels TEXT NOT NULL DEFAULT '{}',
                    summary TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(cluster_id, session_id)
                )
            """)

            # Migration: add user_id column to session_clusters
            try:
                cursor.execute("ALTER TABLE session_clusters ADD COLUMN user_id TEXT")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Migration: add user_id column to eval_uploads
            try:
                cursor.execute("ALTER TABLE eval_uploads ADD COLUMN user_id TEXT")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Migration: add user_id column to eval_results
            try:
                cursor.execute("ALTER TABLE eval_results ADD COLUMN user_id TEXT")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Migration: add user_id to background_jobs
            try:
                cursor.execute("ALTER TABLE background_jobs ADD COLUMN user_id TEXT")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Migration: add user_id to chat_sessions
            try:
                cursor.execute("ALTER TABLE chat_sessions ADD COLUMN user_id TEXT")
            except sqlite3.OperationalError:
                pass  # Column already exists

            conn.commit()

    def reset(self):
        if self.db_path.exists():
            self.db_path.unlink()
        self.init_db()

    # ── User methods (cloud-only — not supported in local/SQLite mode) ──

    def create_user(self, user_id: str, email: str, password_hash: str, name: str | None, api_key: str) -> dict[str, Any]:
        raise NotImplementedError("User management requires cloud mode (PostgreSQL)")

    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        return None

    def get_user_by_api_key(self, api_key: str) -> dict[str, Any] | None:
        return None

    def get_user_by_id(self, user_id: str) -> dict[str, Any] | None:
        return None

    def get_user_by_oauth(self, provider: str, provider_id: str) -> dict[str, Any] | None:
        return None

    def create_oauth_user(self, user_id: str, email: str, name: str | None, api_key: str,
                          oauth_provider: str, oauth_provider_id: str) -> dict[str, Any]:
        raise NotImplementedError("User management requires cloud mode (PostgreSQL)")

    def link_oauth_to_user(self, user_id: str, oauth_provider: str, oauth_provider_id: str) -> dict[str, Any] | None:
        raise NotImplementedError("User management requires cloud mode (PostgreSQL)")

    def update_user_api_key(self, user_id: str, new_api_key: str) -> dict[str, Any] | None:
        return None

    def delete_user(self, user_id: str) -> bool:
        return False

    def get_all_users(self) -> list[dict[str, Any]]:
        return []

    def update_user_team(self, user_id: str, team: str | None) -> dict[str, Any] | None:
        return None

    def set_superuser(self, user_id: str, is_superuser: bool) -> None:
        pass

    # ── User settings methods (cloud-only — not supported in local/SQLite mode) ──

    def get_user_settings(self, user_id: str) -> dict[str, str]:
        raise NotImplementedError("User settings require cloud mode (PostgreSQL)")

    def set_user_setting(self, user_id: str, key: str, value: str) -> None:
        raise NotImplementedError("User settings require cloud mode (PostgreSQL)")

    def delete_user_setting(self, user_id: str, key: str) -> bool:
        raise NotImplementedError("User settings require cloud mode (PostgreSQL)")

    # ── Project methods ──────────────────────────────────────────────

    def get_or_create_project(self, name: str, owner_id: str | None = None) -> str:
        with self._get_conn() as conn:
            if owner_id:
                row = conn.execute("SELECT id FROM projects WHERE name = ? AND owner_id = ?", (name, owner_id)).fetchone()
            else:
                row = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()
            if row:
                return row["id"]
            project_id = str(uuid.uuid4())
            conn.execute("INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)", (project_id, name, owner_id))
            conn.commit()
            return project_id

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if row:
                return dict(row)
        return None

    def rename_project(self, project_id: str, new_name: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            row = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not row:
                return None
            # Check for name conflict
            existing = conn.execute("SELECT id FROM projects WHERE name = ? AND id != ?", (new_name, project_id)).fetchone()
            if existing:
                raise ValueError(f"Project name '{new_name}' already exists")
            conn.execute("UPDATE projects SET name = ? WHERE id = ?", (new_name, project_id))
            conn.commit()
            return dict(conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone())

    def delete_project(self, project_id: str) -> bool:
        with self._get_conn() as conn:
            row = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
            if not row:
                return False
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            conn.commit()
            return True

    def update_session(self, session_id: str, experiment: str | None = None, color: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            row = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return None
            if experiment is not None:
                conn.execute("UPDATE sessions SET experiment = ? WHERE id = ?", (experiment, session_id))
            if color is not None:
                conn.execute("UPDATE sessions SET color = ? WHERE id = ?", (color, session_id))
            conn.commit()
        return self.get_session(session_id)

    def delete_session(self, session_id: str) -> bool:
        with self._get_conn() as conn:
            row = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if not row:
                return False
            conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            conn.commit()
            return True

    # ── Session methods ──────────────────────────────────────────────

    def create_session(self, project: str, experiment: str, config: dict[str, Any], source_metadata: dict[str, Any], owner_id: str | None = None, session_type: str = "training") -> str:
        project_id = self.get_or_create_project(project, owner_id=owner_id)
        session_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            conn.execute(
                "INSERT INTO sessions (id, project_id, experiment, config, source_metadata, session_type) VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, project_id, experiment, json.dumps(config), json.dumps(source_metadata), session_type),
            )
            conn.commit()
        return session_id

    def log_metrics(self, session_id: str, step: int, data: dict[str, Any]) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            cursor = conn.execute("INSERT INTO metrics (session_id, step, data) VALUES (?, ?, ?)", (session_id, step, json.dumps(data)))
            conn.commit()
            metric_id = cursor.lastrowid
            row = conn.execute("SELECT * FROM metrics WHERE id = ?", (metric_id,)).fetchone()
            if row:
                d = dict(row)
                if d["data"]:
                    d["data"] = json.loads(d["data"])
                return d
        return None

    def append_episode(self, session_id: str, episode_data: dict[str, Any], search_text: str | None = None):
        ep_id = episode_data.get("episode_id")
        step = episode_data.get("step")
        task = json.dumps(episode_data.get("task"))
        is_correct = episode_data.get("is_correct")
        termination_reason = episode_data.get("termination_reason")
        trajectories = json.dumps(episode_data.get("trajectories", []))
        metrics = json.dumps(episode_data.get("metrics"))
        info = json.dumps(episode_data.get("info"))
        artifacts = json.dumps(episode_data.get("artifacts"))
        metadata = json.dumps(episode_data.get("metadata"))

        if search_text is None:
            search_text = extract_searchable_text(episode_data)

        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO episodes (id, session_id, step, task, is_correct, termination_reason, trajectories, metrics, info, artifacts, metadata, search_text)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (ep_id, session_id, step, task, is_correct, termination_reason, trajectories, metrics, info, artifacts, metadata, search_text),
            )
            conn.commit()

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT s.*, p.name AS project FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?",
                (session_id,),
            ).fetchone()
            if row:
                d = dict(row)
                if d["config"]:
                    d["config"] = json.loads(d["config"])
                if d["source_metadata"]:
                    d["source_metadata"] = json.loads(d["source_metadata"])
                return d
        return None

    def get_all_sessions(self, owner_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            if owner_id:
                rows = conn.execute(
                    "SELECT s.*, p.name AS project FROM sessions s JOIN projects p ON s.project_id = p.id WHERE p.owner_id = ? ORDER BY s.created_at DESC",
                    (owner_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT s.*, p.name AS project FROM sessions s JOIN projects p ON s.project_id = p.id ORDER BY s.created_at DESC"
                ).fetchall()
            results = []
            for row in rows:
                d = dict(row)
                if d["config"]:
                    d["config"] = json.loads(d["config"])
                try:
                    if d.get("source_metadata"):
                        d["source_metadata"] = json.loads(d["source_metadata"])
                except (json.JSONDecodeError, TypeError):
                    pass
                results.append(d)
            return results

    def complete_session(self, session_id: str, status: str = "completed") -> dict[str, Any] | None:
        from datetime import UTC, datetime

        now = datetime.now(UTC).isoformat()
        with self._get_conn() as conn:
            conn.execute(
                "UPDATE sessions SET completed_at = ?, status = ? WHERE id = ?",
                (now, status, session_id),
            )
            conn.commit()
            return self.get_session(session_id)

    def heartbeat_session(self, session_id: str) -> bool:
        from datetime import UTC, datetime

        now = datetime.now(UTC).isoformat()
        with self._get_conn() as conn:
            cursor = conn.execute(
                "UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?",
                (now, session_id),
            )
            conn.commit()
            return cursor.rowcount > 0

    def mark_crashed_sessions(self, timeout_seconds: int = 300) -> int:
        from datetime import UTC, datetime, timedelta

        now = datetime.now(UTC)
        cutoff = (now - timedelta(seconds=timeout_seconds)).isoformat()
        now_iso = now.isoformat()
        with self._get_conn() as conn:
            cursor = conn.execute(
                "UPDATE sessions SET status = 'crashed', completed_at = ? WHERE status = 'running' AND last_heartbeat_at < ?",
                (now_iso, cutoff),
            )
            conn.commit()
            return cursor.rowcount

    def get_metrics(self, session_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute("SELECT * FROM metrics WHERE session_id = ? ORDER BY step", (session_id,)).fetchall()
            results = []
            for row in rows:
                d = dict(row)
                if d["data"]:
                    d["data"] = json.loads(d["data"])
                results.append(d)
            return results

    def get_new_metrics(self, session_id: str, last_id: int) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute("SELECT * FROM metrics WHERE session_id = ? AND id > ? ORDER BY id", (session_id, last_id)).fetchall()
            results = []
            for row in rows:
                d = dict(row)
                if d["data"]:
                    d["data"] = json.loads(d["data"])
                results.append(d)
            return results

    def _parse_episode_row(self, d: dict[str, Any]) -> dict[str, Any]:
        """Parse JSON columns from an episode row."""
        if d.get("trajectories") and isinstance(d["trajectories"], str):
            d["trajectories"] = json.loads(d["trajectories"])
        else:
            d.setdefault("trajectories", [])
        if d.get("metrics") and isinstance(d["metrics"], str):
            d["metrics"] = json.loads(d["metrics"])
        else:
            d.setdefault("metrics", {})
        if d.get("info") and isinstance(d["info"], str):
            d["info"] = json.loads(d["info"])
        if d.get("artifacts") and isinstance(d["artifacts"], str):
            d["artifacts"] = json.loads(d["artifacts"])
        if d.get("metadata") and isinstance(d["metadata"], str):
            d["metadata"] = json.loads(d["metadata"])
        if d["task"]:
            d["task"] = json.loads(d["task"])
        return d

    def get_episodes(self, session_id: str, step: int | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            if step is not None:
                rows = conn.execute(
                    "SELECT * FROM episodes WHERE session_id = ? AND step = ? ORDER BY step",
                    (session_id, step),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM episodes WHERE session_id = ? ORDER BY step",
                    (session_id,),
                ).fetchall()
            results = []
            for row in rows:
                results.append(self._parse_episode_row(dict(row)))
            return results

    def get_episode(self, episode_id: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            row = conn.execute("SELECT * FROM episodes WHERE id = ?", (episode_id,)).fetchone()
            if row:
                return self._parse_episode_row(dict(row))
        return None

    def search_episodes(self, query: str, session_id: str | None = None, step: int | None = None) -> dict[str, Any]:
        with self._get_conn() as conn:
            sql = "SELECT * FROM episodes WHERE search_text LIKE ?"
            params: list = [f"%{query}%"]

            if session_id:
                sql += " AND session_id = ?"
                params.append(session_id)

            if step is not None:
                sql += " AND step = ?"
                params.append(step)

            sql += " ORDER BY created_at DESC"

            rows = conn.execute(sql, params).fetchall()
            results = []
            for row in rows:
                results.append(self._parse_episode_row(dict(row)))

            matched_terms = query.lower().split()

            return {
                "episodes": results,
                "matched_terms": matched_terms,
            }

    def search_trajectory_groups(self, query: str, session_id: str | None = None,
                                  step: int | None = None) -> dict[str, Any]:
        like_q = f"%{query}%"
        with self._get_conn() as conn:
            sql = """
                SELECT DISTINCT tg.* FROM trajectory_groups tg
                WHERE (
                    tg.task_id LIKE ? OR tg.trajectory_name LIKE ? OR tg.group_id LIKE ?
                    OR EXISTS (
                        SELECT 1 FROM json_each(tg.metadata) AS m
                        JOIN episodes e ON json_extract(m.value, '$.episode_id') = e.id
                        WHERE e.search_text LIKE ?
                    )
                )
            """
            params: list = [like_q, like_q, like_q, like_q]

            if session_id:
                sql += " AND tg.session_id = ?"
                params.append(session_id)

            if step is not None:
                sql += " AND tg.step = ?"
                params.append(step)

            sql += " ORDER BY tg.created_at"

            rows = conn.execute(sql, params).fetchall()
            results = []
            for row in rows:
                d = dict(row)
                if d.get("metadata"):
                    d["metadata"] = json.loads(d["metadata"])
                else:
                    d["metadata"] = []
                results.append(d)

            return {
                "groups": results,
                "matched_terms": query.lower().split(),
            }

    def append_trajectory_group(self, session_id: str, group_data: dict[str, Any]):
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
            conn.execute(
                """
                INSERT INTO trajectory_groups
                (id, session_id, step, group_id, task_id, trajectory_name,
                 num_trajectories, avg_reward, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        with self._get_conn() as conn:
            if step is not None:
                rows = conn.execute(
                    "SELECT * FROM trajectory_groups WHERE session_id = ? AND step = ? ORDER BY created_at",
                    (session_id, step),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM trajectory_groups WHERE session_id = ? ORDER BY step, created_at",
                    (session_id,),
                ).fetchall()

            results = []
            for row in rows:
                d = dict(row)
                if d.get("metadata"):
                    d["metadata"] = json.loads(d["metadata"])
                else:
                    d["metadata"] = []
                results.append(d)
            return results

    def get_trajectory_group(self, group_id: str, include_trajectories: bool = True) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            row = conn.execute("SELECT * FROM trajectory_groups WHERE id = ?", (group_id,)).fetchone()
            if not row:
                return None

            d = dict(row)

            if d.get("metadata"):
                d["metadata"] = json.loads(d["metadata"])
            else:
                d["metadata"] = []

            if not include_trajectories:
                return d

            trajectory_name = d.get("trajectory_name", "")
            episode_ids = [m.get("episode_id") for m in d["metadata"] if m.get("episode_id")]

            if not episode_ids:
                d["data"] = {"trajectories": [], "metadata": d["metadata"]}
                return d

            placeholders = ",".join("?" * len(episode_ids))
            episode_rows = conn.execute(
                f"SELECT id, trajectories FROM episodes WHERE id IN ({placeholders})",
                episode_ids,
            ).fetchall()

            episode_map = {}
            for ep_row in episode_rows:
                trajs = json.loads(ep_row["trajectories"]) if ep_row["trajectories"] else []
                episode_map[ep_row["id"]] = trajs

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

    def get_projects(self, owner_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            # Get projects, filtered by owner if provided
            if owner_id:
                project_rows = conn.execute("SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at", (owner_id,)).fetchall()
            else:
                project_rows = conn.execute("SELECT * FROM projects ORDER BY created_at").fetchall()
            # Get all sessions with project info
            session_rows = conn.execute(
                "SELECT s.id, s.project_id, s.experiment, s.status, s.created_at, s.completed_at FROM sessions s WHERE s.session_type != 'eval' ORDER BY s.created_at DESC"
            ).fetchall()

            # Group sessions by project_id
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
            conn.execute(
                "INSERT INTO logs (session_id, timestamp, stream, message) VALUES (?, ?, ?, ?)",
                (session_id, log_data["timestamp"], log_data.get("stream", "stdout"), log_data["message"]),
            )
            conn.commit()

    def get_logs(self, session_id: str, stream: str | None = None, limit: int = 1000, offset: int = 0) -> list[dict]:
        with self._get_conn() as conn:
            sql = "SELECT * FROM logs WHERE session_id = ?"
            params: list = [session_id]
            if stream:
                sql += " AND stream = ?"
                params.append(stream)
            sql += " ORDER BY id LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            rows = conn.execute(sql, params).fetchall()
            return [dict(row) for row in rows]

    def get_new_logs(self, session_id: str, last_id: int) -> list[dict]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM logs WHERE session_id = ? AND id > ? ORDER BY id",
                (session_id, last_id),
            ).fetchall()
            return [dict(row) for row in rows]

    # ── Chat session methods ─────────────────────────────────────────

    def create_chat_session(self, session_id: str, title: str = "New chat", user_id: str | None = None) -> dict[str, Any]:
        chat_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            conn.execute(
                "INSERT INTO chat_sessions (id, session_id, title, user_id) VALUES (?, ?, ?, ?)",
                (chat_id, session_id, title, user_id),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM chat_sessions WHERE id = ?", (chat_id,)).fetchone()
            d = dict(row)
            d["message_count"] = 0
            return d

    def get_chat_sessions(self, session_id: str, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            if user_id:
                rows = conn.execute(
                    """
                    SELECT cs.*, COALESCE(mc.cnt, 0) AS message_count
                    FROM chat_sessions cs
                    LEFT JOIN (SELECT chat_session_id, COUNT(*) AS cnt FROM chat_messages GROUP BY chat_session_id) mc
                        ON mc.chat_session_id = cs.id
                    WHERE cs.session_id = ? AND cs.user_id = ?
                    ORDER BY cs.updated_at DESC
                    """,
                    (session_id, user_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT cs.*, COALESCE(mc.cnt, 0) AS message_count
                    FROM chat_sessions cs
                    LEFT JOIN (SELECT chat_session_id, COUNT(*) AS cnt FROM chat_messages GROUP BY chat_session_id) mc
                        ON mc.chat_session_id = cs.id
                    WHERE cs.session_id = ?
                    ORDER BY cs.updated_at DESC
                    """,
                    (session_id,),
                ).fetchall()
            return [dict(row) for row in rows]

    def delete_chat_session(self, chat_session_id: str, user_id: str | None = None) -> bool:
        with self._get_conn() as conn:
            if user_id:
                row = conn.execute("SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?", (chat_session_id, user_id)).fetchone()
            else:
                row = conn.execute("SELECT id FROM chat_sessions WHERE id = ?", (chat_session_id,)).fetchone()
            if not row:
                return False
            if user_id:
                conn.execute("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?", (chat_session_id, user_id))
            else:
                conn.execute("DELETE FROM chat_sessions WHERE id = ?", (chat_session_id,))
            conn.commit()
            return True

    def get_chat_messages(self, chat_session_id: str, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            # Verify ownership of parent chat session when user_id is set
            if user_id:
                owner_check = conn.execute("SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?", (chat_session_id, user_id)).fetchone()
                if not owner_check:
                    return []
            rows = conn.execute(
                "SELECT * FROM chat_messages WHERE chat_session_id = ? ORDER BY created_at ASC",
                (chat_session_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def append_chat_message(self, chat_session_id: str, role: str, content: str, user_id: str | None = None) -> dict[str, Any]:
        with self._get_conn() as conn:
            # Verify ownership of parent chat session when user_id is set
            if user_id:
                owner_check = conn.execute("SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?", (chat_session_id, user_id)).fetchone()
                if not owner_check:
                    raise ValueError("Chat session not found or not owned by user")
            cursor = conn.execute(
                "INSERT INTO chat_messages (chat_session_id, role, content) VALUES (?, ?, ?)",
                (chat_session_id, role, content),
            )
            conn.execute(
                "UPDATE chat_sessions SET updated_at = ? WHERE id = ?",
                (datetime.now(timezone.utc).isoformat(), chat_session_id),
            )
            conn.commit()
            msg_id = cursor.lastrowid
            row = conn.execute("SELECT * FROM chat_messages WHERE id = ?", (msg_id,)).fetchone()
            return dict(row)

    # ── Eval result methods ──────────────────────────────────────

    def create_eval_result(self, data: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
        result_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            conn.execute(
                """INSERT INTO eval_results (id, session_id, dataset_name, model, agent, score, total, correct, errors, signal_averages, items, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (result_id, data["session_id"], data["dataset_name"], data["model"], data["agent"],
                 data["score"], data["total"], data["correct"], data["errors"],
                 json.dumps(data.get("signal_averages", {})), json.dumps(data.get("items", [])), user_id),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM eval_results WHERE id = ?", (result_id,)).fetchone()
            d = dict(row)
            if d.get("signal_averages") and isinstance(d["signal_averages"], str):
                d["signal_averages"] = json.loads(d["signal_averages"])
            if d.get("items") and isinstance(d["items"], str):
                d["items"] = json.loads(d["items"])
            return d

    def get_eval_results(self, session_id: str | None = None, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            clauses = []
            params: list[Any] = []
            if session_id:
                clauses.append("session_id = ?")
                params.append(session_id)
            if user_id:
                clauses.append("user_id = ?")
                params.append(user_id)
            where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
            rows = conn.execute(f"SELECT * FROM eval_results{where} ORDER BY created_at DESC", params).fetchall()
            results = []
            for row in rows:
                d = dict(row)
                if d.get("signal_averages") and isinstance(d["signal_averages"], str):
                    d["signal_averages"] = json.loads(d["signal_averages"])
                if d.get("items") and isinstance(d["items"], str):
                    d["items"] = json.loads(d["items"])
                results.append(d)
            return results

    def get_eval_result(self, result_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            if user_id:
                row = conn.execute("SELECT * FROM eval_results WHERE id = ? AND user_id = ?", (result_id, user_id)).fetchone()
            else:
                row = conn.execute("SELECT * FROM eval_results WHERE id = ?", (result_id,)).fetchone()
            if row:
                d = dict(row)
                if d.get("signal_averages") and isinstance(d["signal_averages"], str):
                    d["signal_averages"] = json.loads(d["signal_averages"])
                if d.get("items") and isinstance(d["items"], str):
                    d["items"] = json.loads(d["items"])
                return d
        return None

    def get_eval_results_by_project(self, project_id: str, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            if user_id:
                rows = conn.execute(
                    """SELECT er.* FROM eval_results er
                    JOIN sessions s ON er.session_id = s.id
                    JOIN projects p ON s.project_id = p.id
                    WHERE p.id = ? AND p.owner_id = ?
                    ORDER BY er.created_at DESC""",
                    (project_id, user_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT er.* FROM eval_results er
                    JOIN sessions s ON er.session_id = s.id
                    WHERE s.project_id = ?
                    ORDER BY er.created_at DESC""",
                    (project_id,),
                ).fetchall()
            results = []
            for row in rows:
                d = dict(row)
                if d.get("signal_averages") and isinstance(d["signal_averages"], str):
                    d["signal_averages"] = json.loads(d["signal_averages"])
                if d.get("items") and isinstance(d["items"], str):
                    d["items"] = json.loads(d["items"])
                results.append(d)
            return results

    # ── Skill methods ──────────────────────────────────────────────

    def _parse_skill_row(self, row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        for field in ("source_session_ids", "tags", "metadata"):
            if d.get(field) and isinstance(d[field], str):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass
        d["is_active"] = bool(d.get("is_active"))
        return d

    def create_skill(self, data: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
        skill_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            conn.execute(
                """INSERT INTO skills (id, title, description, category, confidence, reward_delta,
                   success_rate, evidence_count, source_session_ids, tags, is_active, metadata, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (skill_id, data["title"], data["description"],
                 data.get("category", "general"), data.get("confidence", 0.0),
                 data.get("reward_delta", 0.0), data.get("success_rate", ""),
                 data.get("evidence_count", 0),
                 json.dumps(data.get("source_session_ids", [])),
                 json.dumps(data.get("tags", [])),
                 int(data.get("is_active", False)),
                 json.dumps(data.get("metadata")),
                 user_id),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
            return self._parse_skill_row(row)

    def get_skills(self, is_active: bool | None = None, category: str | None = None, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            query = "SELECT * FROM skills WHERE 1=1"
            params: list[Any] = []
            if user_id is not None:
                query += " AND user_id = ?"
                params.append(user_id)
            if is_active is not None:
                query += " AND is_active = ?"
                params.append(int(is_active))
            if category:
                query += " AND category = ?"
                params.append(category)
            query += " ORDER BY created_at DESC"
            rows = conn.execute(query, params).fetchall()
            return [self._parse_skill_row(row) for row in rows]

    def get_skill(self, skill_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            query = "SELECT * FROM skills WHERE id = ?"
            params: list[Any] = [skill_id]
            if user_id is not None:
                query += " AND user_id = ?"
                params.append(user_id)
            row = conn.execute(query, params).fetchone()
            return self._parse_skill_row(row) if row else None

    def update_skill(self, skill_id: str, data: dict[str, Any], user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            check_query = "SELECT * FROM skills WHERE id = ?"
            check_params: list[Any] = [skill_id]
            if user_id is not None:
                check_query += " AND user_id = ?"
                check_params.append(user_id)
            existing = conn.execute(check_query, check_params).fetchone()
            if not existing:
                return None
            sets = ["updated_at = CURRENT_TIMESTAMP"]
            params: list[Any] = []
            for key in ("title", "description", "category"):
                if key in data:
                    sets.append(f"{key} = ?")
                    params.append(data[key])
            if "is_active" in data:
                sets.append("is_active = ?")
                params.append(int(data["is_active"]))
            if "tags" in data:
                sets.append("tags = ?")
                params.append(json.dumps(data["tags"]))
            where = "WHERE id = ?"
            params.append(skill_id)
            if user_id is not None:
                where += " AND user_id = ?"
                params.append(user_id)
            conn.execute(f"UPDATE skills SET {', '.join(sets)} {where}", params)
            conn.commit()
            row = conn.execute("SELECT * FROM skills WHERE id = ?", (skill_id,)).fetchone()
            return self._parse_skill_row(row)

    def delete_skill(self, skill_id: str, user_id: str | None = None) -> bool:
        with self._get_conn() as conn:
            query = "DELETE FROM skills WHERE id = ?"
            params: list[Any] = [skill_id]
            if user_id is not None:
                query += " AND user_id = ?"
                params.append(user_id)
            cursor = conn.execute(query, params)
            conn.commit()
            return cursor.rowcount > 0

    def delete_all_skills(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            if user_id is not None:
                cursor = conn.execute("DELETE FROM skills WHERE user_id = ?", (user_id,))
            else:
                cursor = conn.execute("DELETE FROM skills")
            conn.commit()
            return cursor.rowcount

    def delete_all_eval_results(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            if user_id:
                cursor = conn.execute("DELETE FROM eval_results WHERE user_id = ?", (user_id,))
            else:
                cursor = conn.execute("DELETE FROM eval_results")
            conn.commit()
            return cursor.rowcount

    def delete_all_eval_uploads(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            if user_id:
                cursor = conn.execute("DELETE FROM eval_uploads WHERE user_id = ?", (user_id,))
            else:
                cursor = conn.execute("DELETE FROM eval_uploads")
            conn.commit()
            return cursor.rowcount

    def delete_all_jobs(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            if user_id:
                cursor = conn.execute("DELETE FROM background_jobs WHERE user_id = ?", (user_id,))
            else:
                cursor = conn.execute("DELETE FROM background_jobs")
            conn.commit()
            return cursor.rowcount

    # ── Eval upload methods ──────────────────────────────────────────

    def create_eval_upload(self, upload_id: str, filename: str, rows: list[dict[str, Any]], user_id: str | None = None) -> dict[str, Any]:
        with self._get_conn() as conn:
            conn.execute(
                "INSERT INTO eval_uploads (upload_id, filename, row_count, user_id) VALUES (?, ?, ?, ?)",
                (upload_id, filename, len(rows), user_id),
            )
            for row in rows:
                task_success_raw = row.get("task_success", "")
                task_success_val = None
                if isinstance(task_success_raw, str) and task_success_raw.strip().lower() in ("true", "1", "yes"):
                    task_success_val = True
                elif isinstance(task_success_raw, str) and task_success_raw.strip().lower() in ("false", "0", "no"):
                    task_success_val = False

                conn.execute(
                    """INSERT INTO eval_upload_rows
                    (upload_id, session_id, agent_trajectory, ground_truth, rating,
                     trajectory_alignment, task_success, tags,
                     reference_trajectory, reference_state, reference_answer)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (upload_id, row["session_id"], row["agent_trajectory"], row["ground_truth"],
                     row.get("rating", ""), row.get("trajectory_alignment", ""), task_success_val,
                     row.get("tags", ""),
                     row.get("reference_trajectory", ""), row.get("reference_state", ""), row.get("reference_answer", "")),
                )
            conn.commit()
            result = conn.execute("SELECT * FROM eval_uploads WHERE upload_id = ?", (upload_id,)).fetchone()
            return dict(result)

    def get_eval_uploads(self, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            if user_id:
                rows = conn.execute("SELECT * FROM eval_uploads WHERE user_id = ? ORDER BY created_at DESC", (user_id,)).fetchall()
            else:
                rows = conn.execute("SELECT * FROM eval_uploads ORDER BY created_at DESC").fetchall()
            return [dict(row) for row in rows]

    def get_eval_upload_rows(self, upload_id: str, user_id: str | None = None) -> list[dict[str, Any]] | None:
        with self._get_conn() as conn:
            if user_id:
                exists = conn.execute("SELECT upload_id FROM eval_uploads WHERE upload_id = ? AND user_id = ?", (upload_id, user_id)).fetchone()
            else:
                exists = conn.execute("SELECT upload_id FROM eval_uploads WHERE upload_id = ?", (upload_id,)).fetchone()
            if not exists:
                return None
            rows = conn.execute(
                "SELECT * FROM eval_upload_rows WHERE upload_id = ? ORDER BY id",
                (upload_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def delete_eval_upload(self, upload_id: str, user_id: str | None = None) -> bool:
        with self._get_conn() as conn:
            if user_id:
                exists = conn.execute("SELECT upload_id FROM eval_uploads WHERE upload_id = ? AND user_id = ?", (upload_id, user_id)).fetchone()
            else:
                exists = conn.execute("SELECT upload_id FROM eval_uploads WHERE upload_id = ?", (upload_id,)).fetchone()
            if not exists:
                return False
            conn.execute("DELETE FROM eval_uploads WHERE upload_id = ?", (upload_id,))
            conn.commit()
            return True

    # ── Background jobs ──────────────────────────────────────────────

    def create_job(self, job_type: str, user_id: str | None = None) -> dict[str, Any]:
        import uuid
        job_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            conn.execute(
                "INSERT INTO background_jobs (id, job_type, user_id) VALUES (?, ?, ?)",
                (job_id, job_type, user_id),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM background_jobs WHERE id = ?", (job_id,)).fetchone()
            return self._parse_job_row(dict(row))

    def get_job(self, job_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            if user_id:
                row = conn.execute("SELECT * FROM background_jobs WHERE id = ? AND user_id = ?", (job_id, user_id)).fetchone()
            else:
                row = conn.execute("SELECT * FROM background_jobs WHERE id = ?", (job_id,)).fetchone()
            return self._parse_job_row(dict(row)) if row else None

    def update_job_status(
        self,
        job_id: str,
        status: str,
        progress: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> dict[str, Any] | None:
        import json as _json
        with self._get_conn() as conn:
            sets = ["status = ?", "updated_at = CURRENT_TIMESTAMP"]
            vals: list[Any] = [status]
            if progress is not None:
                sets.append("progress = ?")
                vals.append(_json.dumps(progress, default=str))
            if result is not None:
                sets.append("result = ?")
                vals.append(_json.dumps(result, default=str))
            if error is not None:
                sets.append("error = ?")
                vals.append(error)
            vals.append(job_id)
            conn.execute(f"UPDATE background_jobs SET {', '.join(sets)} WHERE id = ?", vals)
            conn.commit()
            row = conn.execute("SELECT * FROM background_jobs WHERE id = ?", (job_id,)).fetchone()
            return self._parse_job_row(dict(row)) if row else None

    def list_jobs(self, job_type: str | None = None, limit: int = 20, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            wheres: list[str] = []
            vals: list[Any] = []
            if job_type:
                wheres.append("job_type = ?")
                vals.append(job_type)
            if user_id:
                wheres.append("user_id = ?")
                vals.append(user_id)
            where_clause = (" WHERE " + " AND ".join(wheres)) if wheres else ""
            vals.append(limit)
            rows = conn.execute(
                f"SELECT * FROM background_jobs{where_clause} ORDER BY created_at DESC LIMIT ?",
                vals,
            ).fetchall()
            return [self._parse_job_row(dict(r)) for r in rows]

    def delete_job(self, job_id: str, user_id: str | None = None) -> bool:
        with self._get_conn() as conn:
            if user_id:
                row = conn.execute("SELECT id FROM background_jobs WHERE id = ? AND user_id = ?", (job_id, user_id)).fetchone()
            else:
                row = conn.execute("SELECT id FROM background_jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                return False
            if user_id:
                conn.execute("DELETE FROM background_jobs WHERE id = ? AND user_id = ?", (job_id, user_id))
            else:
                conn.execute("DELETE FROM background_jobs WHERE id = ?", (job_id,))
            conn.commit()
            return True

    def cleanup_dangling_jobs(self) -> int:
        with self._get_conn() as conn:
            cursor = conn.execute(
                "UPDATE background_jobs SET status = 'failed', error = 'Server restarted', "
                "updated_at = CURRENT_TIMESTAMP WHERE status IN ('pending', 'running')"
            )
            conn.commit()
            return cursor.rowcount

    @staticmethod
    def _parse_job_row(d: dict[str, Any]) -> dict[str, Any]:
        import json as _json
        for field in ("progress", "result"):
            val = d.get(field)
            if isinstance(val, str):
                try:
                    d[field] = _json.loads(val)
                except (ValueError, TypeError):
                    d[field] = {}
            if d.get(field) is None:
                d[field] = {} if field == "progress" else None
        return d

    # ── Session clusters ─────────────────────────────────────────────

    def create_cluster(self, data: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
        cluster_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            conn.execute(
                """INSERT INTO session_clusters (id, name, task_type, description, member_count, metadata, job_id, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    cluster_id,
                    data["name"],
                    data["task_type"],
                    data.get("description", ""),
                    data.get("member_count", 0),
                    json.dumps(data.get("metadata", {}), default=str),
                    data.get("job_id"),
                    user_id,
                ),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM session_clusters WHERE id = ?", (cluster_id,)).fetchone()
            return self._parse_cluster_row(dict(row))

    def get_clusters(self, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            if user_id:
                rows = conn.execute(
                    "SELECT * FROM session_clusters WHERE user_id = ? ORDER BY member_count DESC",
                    (user_id,),
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM session_clusters ORDER BY member_count DESC").fetchall()
            return [self._parse_cluster_row(dict(row)) for row in rows]

    def get_cluster(self, cluster_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            if user_id:
                row = conn.execute(
                    "SELECT * FROM session_clusters WHERE id = ? AND user_id = ?",
                    (cluster_id, user_id),
                ).fetchone()
            else:
                row = conn.execute("SELECT * FROM session_clusters WHERE id = ?", (cluster_id,)).fetchone()
            return self._parse_cluster_row(dict(row)) if row else None

    def get_cluster_members(self, cluster_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM session_cluster_members WHERE cluster_id = ? ORDER BY created_at",
                (cluster_id,),
            ).fetchall()
            return [self._parse_cluster_member_row(dict(row)) for row in rows]

    def add_cluster_member(
        self, cluster_id: str, session_id: str, labels: dict[str, Any], summary: str = ""
    ) -> dict[str, Any]:
        member_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            conn.execute(
                """INSERT INTO session_cluster_members (id, cluster_id, session_id, labels, summary)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (cluster_id, session_id) DO UPDATE SET labels = excluded.labels, summary = excluded.summary""",
                (member_id, cluster_id, session_id, json.dumps(labels, default=str), summary),
            )
            # Update member_count
            conn.execute(
                "UPDATE session_clusters SET member_count = "
                "(SELECT count(*) FROM session_cluster_members WHERE cluster_id = ?), "
                "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (cluster_id, cluster_id),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM session_cluster_members WHERE cluster_id = ? AND session_id = ?",
                (cluster_id, session_id),
            ).fetchone()
            return self._parse_cluster_member_row(dict(row))

    def update_cluster_metadata(self, cluster_id: str, metadata: dict[str, Any], description: str = "") -> None:
        with self._get_conn() as conn:
            conn.execute(
                "UPDATE session_clusters SET metadata = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (json.dumps(metadata, default=str), description, cluster_id),
            )
            conn.commit()

    def get_clusters_by_job(self, job_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM session_clusters WHERE job_id = ? ORDER BY member_count DESC",
                (job_id,),
            ).fetchall()
            return [self._parse_cluster_row(dict(row)) for row in rows]

    def delete_all_clusters(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            if user_id:
                cursor = conn.execute("DELETE FROM session_clusters WHERE user_id = ?", (user_id,))
            else:
                cursor = conn.execute("DELETE FROM session_clusters")
            count = cursor.rowcount
            conn.commit()
            return count

    @staticmethod
    def _parse_cluster_row(d: dict[str, Any]) -> dict[str, Any]:
        val = d.get("metadata")
        if isinstance(val, str):
            try:
                d["metadata"] = json.loads(val)
            except (json.JSONDecodeError, TypeError):
                d["metadata"] = {}
        d.setdefault("metadata", {})
        return d

    @staticmethod
    def _parse_cluster_member_row(d: dict[str, Any]) -> dict[str, Any]:
        val = d.get("labels")
        if isinstance(val, str):
            try:
                d["labels"] = json.loads(val)
            except (json.JSONDecodeError, TypeError):
                d["labels"] = {}
        d.setdefault("labels", {})
        return d
