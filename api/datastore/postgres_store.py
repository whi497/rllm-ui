"""PostgreSQL implementation of DataStore."""

import json
import queue
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool

from .base import DataStore, extract_searchable_text


class PostgresStore(DataStore):
    """PostgreSQL-backed data store."""

    def __init__(self, url: str, minconn: int = 2, maxconn: int = 10):
        self.url = url
        self._pool = ThreadedConnectionPool(
            minconn, maxconn, url,
            cursor_factory=RealDictCursor,
            connect_timeout=5,
        )
        self._conn_queue = queue.Queue(maxsize=maxconn)
        for _ in range(maxconn):
            self._conn_queue.put_nowait(True)

    @contextmanager
    def _get_conn(self):
        """Borrow a connection from the pool; wait if all are checked out (FIFO)."""
        try:
            self._conn_queue.get(timeout=5)
        except queue.Empty:
            raise psycopg2.OperationalError("Timed out waiting for a database connection")
        try:
            conn = self._pool.getconn()
            try:
                yield conn
            finally:
                self._pool.putconn(conn)
        finally:
            self._conn_queue.put_nowait(True)

    def close(self):
        """Close all connections in the pool."""
        if self._pool:
            self._pool.closeall()

    def init_db(self):
        """Initialize the database schema."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                # Users table (cloud mode)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS users (
                        id TEXT PRIMARY KEY,
                        email TEXT NOT NULL UNIQUE,
                        password_hash TEXT,
                        name TEXT,
                        api_key TEXT UNIQUE,
                        oauth_provider TEXT,
                        oauth_provider_id TEXT,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(oauth_provider, oauth_provider_id)
                    )
                """)

                # Migration: make password_hash nullable and add OAuth columns for existing DBs
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider_id TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE users ADD CONSTRAINT uq_users_oauth UNIQUE (oauth_provider, oauth_provider_id);
                    EXCEPTION WHEN duplicate_table THEN NULL;
                    WHEN duplicate_object THEN NULL;
                    END $$;
                """)

                # Projects table (with optional owner_id for multi-tenancy)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS projects (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Add owner_id column if it doesn't exist (migration for existing DBs)
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Migration: update existing FK to add ON DELETE CASCADE
                cursor.execute("""
                    DO $$ BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.table_constraints
                            WHERE table_name = 'projects' AND constraint_type = 'FOREIGN KEY'
                            AND constraint_name = 'projects_owner_id_fkey'
                        ) THEN
                            ALTER TABLE projects DROP CONSTRAINT projects_owner_id_fkey;
                            ALTER TABLE projects ADD CONSTRAINT projects_owner_id_fkey
                                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;
                        END IF;
                    END $$;
                """)

                # Unique constraint: project name per owner (NULL owner = local mode)
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE projects ADD CONSTRAINT uq_projects_name_owner UNIQUE (name, owner_id);
                    EXCEPTION WHEN duplicate_table THEN NULL;
                    WHEN duplicate_object THEN NULL;
                    END $$;
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
                        session_type TEXT DEFAULT 'training',
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        completed_at TIMESTAMPTZ,
                        last_heartbeat_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Migration: add session_type column to existing sessions tables
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_type TEXT DEFAULT 'training';
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Migration: add artifacts column to episodes table
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE episodes ADD COLUMN IF NOT EXISTS artifacts JSONB;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Migration: add metadata column to episodes table
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE episodes ADD COLUMN IF NOT EXISTS metadata JSONB;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Metrics table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS metrics (
                        id SERIAL PRIMARY KEY,
                        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                        step INTEGER,
                        data JSONB,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # User settings table (key-value per user, values encrypted at rest)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS user_settings (
                        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        key TEXT NOT NULL,
                        value TEXT NOT NULL,
                        PRIMARY KEY (user_id, key)
                    )
                """)

                # Chat sessions table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS chat_sessions (
                        id TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                        title TEXT NOT NULL DEFAULT 'New chat',
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Chat messages table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS chat_messages (
                        id SERIAL PRIMARY KEY,
                        chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                        role TEXT NOT NULL,
                        content TEXT NOT NULL,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
                    ON chat_messages(chat_session_id)
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
                        signal_averages JSONB,
                        items JSONB,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_eval_results_session_id
                    ON eval_results(session_id)
                """)

                conn.commit()

    def reset(self):
        """Reset the data store by dropping and recreating all tables."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("DROP TABLE IF EXISTS eval_results CASCADE")
                cursor.execute("DROP TABLE IF EXISTS user_settings CASCADE")
                cursor.execute("DROP TABLE IF EXISTS chat_messages CASCADE")
                cursor.execute("DROP TABLE IF EXISTS chat_sessions CASCADE")
                cursor.execute("DROP TABLE IF EXISTS logs CASCADE")
                cursor.execute("DROP TABLE IF EXISTS trajectory_groups CASCADE")
                cursor.execute("DROP TABLE IF EXISTS episodes CASCADE")
                cursor.execute("DROP TABLE IF EXISTS metrics CASCADE")
                cursor.execute("DROP TABLE IF EXISTS sessions CASCADE")
                cursor.execute("DROP TABLE IF EXISTS projects CASCADE")
                cursor.execute("DROP TABLE IF EXISTS users CASCADE")
                conn.commit()
        self.init_db()

    # ── User methods ───────────────────────────────────────────────

    def create_user(self, user_id: str, email: str, password_hash: str, name: str | None, api_key: str) -> dict[str, Any]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO users (id, email, password_hash, name, api_key) VALUES (%s, %s, %s, %s, %s) RETURNING *",
                    (user_id, email, password_hash, name, api_key),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)

    def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT * FROM users WHERE email = %s", (email,))
                row = cursor.fetchone()
                return dict(row) if row else None

    def get_user_by_api_key(self, api_key: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT * FROM users WHERE api_key = %s", (api_key,))
                row = cursor.fetchone()
                return dict(row) if row else None

    def get_user_by_id(self, user_id: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
                row = cursor.fetchone()
                return dict(row) if row else None

    def get_user_by_oauth(self, provider: str, provider_id: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM users WHERE oauth_provider = %s AND oauth_provider_id = %s",
                    (provider, provider_id),
                )
                row = cursor.fetchone()
                return dict(row) if row else None

    def create_oauth_user(self, user_id: str, email: str, name: str | None, api_key: str,
                          oauth_provider: str, oauth_provider_id: str) -> dict[str, Any]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO users (id, email, name, api_key, oauth_provider, oauth_provider_id) "
                    "VALUES (%s, %s, %s, %s, %s, %s) RETURNING *",
                    (user_id, email, name, api_key, oauth_provider, oauth_provider_id),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)

    def link_oauth_to_user(self, user_id: str, oauth_provider: str, oauth_provider_id: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE users SET oauth_provider = %s, oauth_provider_id = %s WHERE id = %s RETURNING *",
                    (oauth_provider, oauth_provider_id, user_id),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None

    def update_user_api_key(self, user_id: str, new_api_key: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE users SET api_key = %s WHERE id = %s RETURNING *",
                    (new_api_key, user_id),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None

    def delete_user(self, user_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
                deleted = cursor.rowcount > 0
                conn.commit()
                return deleted

    # ── User settings methods ─────────────────────────────────────

    def get_user_settings(self, user_id: str) -> dict[str, str]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT key, value FROM user_settings WHERE user_id = %s",
                    (user_id,),
                )
                return {row["key"]: row["value"] for row in cursor.fetchall()}

    def set_user_setting(self, user_id: str, key: str, value: str) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO user_settings (user_id, key, value)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value
                    """,
                    (user_id, key, value),
                )
                conn.commit()

    def delete_user_setting(self, user_id: str, key: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM user_settings WHERE user_id = %s AND key = %s",
                    (user_id, key),
                )
                deleted = cursor.rowcount > 0
                conn.commit()
                return deleted

    # ── Project methods ──────────────────────────────────────────────

    def get_or_create_project(self, name: str, owner_id: str | None = None) -> str:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if owner_id:
                    cursor.execute("SELECT id FROM projects WHERE name = %s AND owner_id = %s", (name, owner_id))
                else:
                    cursor.execute("SELECT id FROM projects WHERE name = %s AND owner_id IS NULL", (name,))
                row = cursor.fetchone()
                if row:
                    return row["id"]
                project_id = str(uuid.uuid4())
                cursor.execute("INSERT INTO projects (id, name, owner_id) VALUES (%s, %s, %s)", (project_id, name, owner_id))
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
                cursor.execute("SELECT id, owner_id FROM projects WHERE id = %s", (project_id,))
                project = cursor.fetchone()
                if not project:
                    return None
                owner_id = project["owner_id"]
                # Check name conflict within same owner scope
                if owner_id:
                    cursor.execute("SELECT id FROM projects WHERE name = %s AND owner_id = %s AND id != %s", (new_name, owner_id, project_id))
                else:
                    cursor.execute("SELECT id FROM projects WHERE name = %s AND owner_id IS NULL AND id != %s", (new_name, project_id))
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

    def create_session(self, project: str, experiment: str, config: dict[str, Any], source_metadata: dict[str, Any], owner_id: str | None = None, session_type: str = "training") -> str:
        """Create a new training session."""
        project_id = self.get_or_create_project(project, owner_id=owner_id)
        session_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO sessions (id, project_id, experiment, config, source_metadata, session_type)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (session_id, project_id, experiment, json.dumps(config), json.dumps(source_metadata), session_type),
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

    def append_episode(self, session_id: str, episode_data: dict[str, Any], search_text: str | None = None):
        """Append an episode to a session."""
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
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO episodes (id, session_id, step, task, is_correct, termination_reason, trajectories, metrics, info, artifacts, metadata, search_text)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (ep_id, session_id, step, task, is_correct, termination_reason, trajectories, metrics, info, artifacts, metadata, search_text),
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

    def get_all_sessions(self, owner_id: str | None = None) -> list[dict[str, Any]]:
        """Retrieve all sessions, optionally filtered by owner."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if owner_id:
                    cursor.execute(
                        "SELECT s.*, p.name AS project FROM sessions s JOIN projects p ON s.project_id = p.id WHERE p.owner_id = %s ORDER BY s.created_at DESC",
                        (owner_id,),
                    )
                else:
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

    def get_projects(self, owner_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if owner_id:
                    cursor.execute("SELECT * FROM projects WHERE owner_id = %s ORDER BY created_at", (owner_id,))
                    project_rows = cursor.fetchall()

                    project_ids = [p["id"] for p in project_rows]
                    if project_ids:
                        cursor.execute(
                            "SELECT id, project_id, experiment, status, created_at, completed_at FROM sessions WHERE project_id = ANY(%s) AND session_type != 'eval' ORDER BY created_at DESC",
                            (project_ids,),
                        )
                    else:
                        cursor.execute("SELECT id, project_id, experiment, status, created_at, completed_at FROM sessions WHERE FALSE")
                else:
                    cursor.execute("SELECT * FROM projects ORDER BY created_at")
                    project_rows = cursor.fetchall()

                    cursor.execute(
                        "SELECT id, project_id, experiment, status, created_at, completed_at FROM sessions WHERE session_type != 'eval' ORDER BY created_at DESC"
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

    # ── Chat session methods ─────────────────────────────────────────

    def create_chat_session(self, session_id: str, title: str = "New chat") -> dict[str, Any]:
        chat_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO chat_sessions (id, session_id, title) VALUES (%s, %s, %s) RETURNING *",
                    (chat_id, session_id, title),
                )
                row = cursor.fetchone()
                conn.commit()
                d = dict(row)
                d["message_count"] = 0
                return d

    def get_chat_sessions(self, session_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT cs.*, COALESCE(mc.cnt, 0) AS message_count
                    FROM chat_sessions cs
                    LEFT JOIN (SELECT chat_session_id, COUNT(*) AS cnt FROM chat_messages GROUP BY chat_session_id) mc
                        ON mc.chat_session_id = cs.id
                    WHERE cs.session_id = %s
                    ORDER BY cs.updated_at DESC
                    """,
                    (session_id,),
                )
                rows = cursor.fetchall()
                return [dict(row) for row in rows]

    def delete_chat_session(self, chat_session_id: str) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id FROM chat_sessions WHERE id = %s", (chat_session_id,))
                if not cursor.fetchone():
                    return False
                cursor.execute("DELETE FROM chat_sessions WHERE id = %s", (chat_session_id,))
                conn.commit()
                return True

    def get_chat_messages(self, chat_session_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM chat_messages WHERE chat_session_id = %s ORDER BY created_at ASC",
                    (chat_session_id,),
                )
                rows = cursor.fetchall()
                return [dict(row) for row in rows]

    def append_chat_message(self, chat_session_id: str, role: str, content: str) -> dict[str, Any]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO chat_messages (chat_session_id, role, content) VALUES (%s, %s, %s) RETURNING *",
                    (chat_session_id, role, content),
                )
                row = cursor.fetchone()
                cursor.execute(
                    "UPDATE chat_sessions SET updated_at = %s WHERE id = %s",
                    (datetime.now(UTC).isoformat(), chat_session_id),
                )
                conn.commit()
                return dict(row)

    # ── Eval result methods ──────────────────────────────────────

    def create_eval_result(self, data: dict[str, Any]) -> dict[str, Any]:
        result_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO eval_results (id, session_id, dataset_name, model, agent, score, total, correct, errors, signal_averages, items)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *""",
                    (result_id, data["session_id"], data["dataset_name"], data["model"], data["agent"],
                     data["score"], data["total"], data["correct"], data["errors"],
                     json.dumps(data.get("signal_averages", {})), json.dumps(data.get("items", []))),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)

    def get_eval_results(self, session_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if session_id:
                    cursor.execute("SELECT * FROM eval_results WHERE session_id = %s ORDER BY created_at DESC", (session_id,))
                else:
                    cursor.execute("SELECT * FROM eval_results ORDER BY created_at DESC")
                return [dict(row) for row in cursor.fetchall()]

    def get_eval_result(self, result_id: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT * FROM eval_results WHERE id = %s", (result_id,))
                row = cursor.fetchone()
                return dict(row) if row else None

    def get_eval_results_by_project(self, project_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """SELECT er.* FROM eval_results er
                    JOIN sessions s ON er.session_id = s.id
                    WHERE s.project_id = %s
                    ORDER BY er.created_at DESC""",
                    (project_id,),
                )
                return [dict(row) for row in cursor.fetchall()]
