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
                        api_key_hash TEXT UNIQUE,
                        api_key_hint TEXT,
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

                # Migration: add team and is_superuser columns
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE users ADD COLUMN IF NOT EXISTS team TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superuser BOOLEAN DEFAULT FALSE;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Migration: hash plain-text api_key → api_key_hash + api_key_hint
                cursor.execute("""
                    DO $$ BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'users' AND column_name = 'api_key'
                        ) THEN
                            ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_hash TEXT UNIQUE;
                            ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_hint TEXT;
                            UPDATE users
                                SET api_key_hash = encode(sha256(api_key::bytea), 'hex'),
                                    api_key_hint = right(api_key, 4)
                                WHERE api_key IS NOT NULL AND api_key_hash IS NULL;
                            ALTER TABLE users DROP COLUMN api_key;
                        END IF;
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
                        source_session_ids JSONB DEFAULT '[]',
                        tags JSONB DEFAULT '[]',
                        is_active BOOLEAN DEFAULT FALSE,
                        metadata JSONB,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Migration: add reward_delta column to existing skills tables
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE skills ADD COLUMN IF NOT EXISTS reward_delta REAL DEFAULT 0.0;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Migration: add user_id column to existing skills tables
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE skills ADD COLUMN IF NOT EXISTS user_id TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Span uploads metadata table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS span_uploads (
                        upload_id TEXT PRIMARY KEY,
                        filename TEXT NOT NULL,
                        row_count INTEGER DEFAULT 0,
                        session_count INTEGER DEFAULT 0,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Imported agent sessions (from span CSV uploads)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS imported_agent_sessions (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL DEFAULT '',
                        status TEXT DEFAULT 'completed',
                        metadata JSONB DEFAULT '{}',
                        upload_id TEXT REFERENCES span_uploads(upload_id) ON DELETE CASCADE,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        completed_at TIMESTAMPTZ
                    )
                """)

                # Imported agent spans (from span CSV uploads)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS imported_agent_spans (
                        id TEXT PRIMARY KEY,
                        agent_session_id TEXT NOT NULL REFERENCES imported_agent_sessions(id) ON DELETE CASCADE,
                        span_type TEXT NOT NULL,
                        span_id TEXT DEFAULT '',
                        invocation_id TEXT DEFAULT '',
                        agent_name TEXT DEFAULT '',
                        started_at DOUBLE PRECISION,
                        ended_at DOUBLE PRECISION,
                        duration_ms DOUBLE PRECISION,
                        model TEXT DEFAULT '',
                        input_tokens BIGINT,
                        output_tokens BIGINT,
                        total_tokens BIGINT,
                        tool_name TEXT DEFAULT '',
                        tool_type TEXT DEFAULT '',
                        error TEXT DEFAULT '',
                        data JSONB DEFAULT '{}',
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_imported_sessions_created_at
                    ON imported_agent_sessions(created_at DESC)
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_imported_spans_session
                    ON imported_agent_spans(agent_session_id)
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_imported_spans_type
                    ON imported_agent_spans(agent_session_id, span_type)
                """)

                # Migration: add user_id to imported_agent_sessions and span_uploads
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE imported_agent_sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE span_uploads ADD COLUMN IF NOT EXISTS user_id TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Eval uploads metadata table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS eval_uploads (
                        upload_id TEXT PRIMARY KEY,
                        filename TEXT NOT NULL,
                        row_count INTEGER DEFAULT 0,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                # Eval upload rows table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS eval_upload_rows (
                        id SERIAL PRIMARY KEY,
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
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_eval_upload_rows_upload_id
                    ON eval_upload_rows(upload_id)
                """)

                # Background jobs table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS background_jobs (
                        id TEXT PRIMARY KEY,
                        job_type TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'pending',
                        progress JSONB DEFAULT '{}',
                        result JSONB,
                        error TEXT,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_background_jobs_type
                    ON background_jobs(job_type, created_at DESC)
                """)

                # Session clusters table
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS session_clusters (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        task_type TEXT NOT NULL,
                        description TEXT DEFAULT '',
                        member_count INTEGER DEFAULT 0,
                        metadata JSONB DEFAULT '{}',
                        job_id TEXT,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                """)

                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS session_cluster_members (
                        id TEXT PRIMARY KEY,
                        cluster_id TEXT NOT NULL REFERENCES session_clusters(id) ON DELETE CASCADE,
                        session_id TEXT NOT NULL,
                        labels JSONB NOT NULL DEFAULT '{}',
                        summary TEXT DEFAULT '',
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(cluster_id, session_id)
                    )
                """)
                cursor.execute("""
                    CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster
                    ON session_cluster_members(cluster_id)
                """)

                # Migration: add user_id column to session_clusters
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE session_clusters ADD COLUMN IF NOT EXISTS user_id TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Migration: add user_id column to eval_uploads
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE eval_uploads ADD COLUMN IF NOT EXISTS user_id TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Migration: add user_id column to eval_results
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS user_id TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Migration: add user_id to background_jobs
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS user_id TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                # Migration: add user_id to chat_sessions
                cursor.execute("""
                    DO $$ BEGIN
                        ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
                    EXCEPTION WHEN others THEN NULL;
                    END $$;
                """)

                conn.commit()

    def reset(self):
        """Reset the data store by dropping and recreating all tables."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("DROP TABLE IF EXISTS imported_agent_spans CASCADE")
                cursor.execute("DROP TABLE IF EXISTS imported_agent_sessions CASCADE")
                cursor.execute("DROP TABLE IF EXISTS span_uploads CASCADE")
                cursor.execute("DROP TABLE IF EXISTS eval_upload_rows CASCADE")
                cursor.execute("DROP TABLE IF EXISTS eval_uploads CASCADE")
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

    def create_user(self, user_id: str, email: str, password_hash: str, name: str | None,
                    api_key_hash: str, api_key_hint: str) -> dict[str, Any]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO users (id, email, password_hash, name, api_key_hash, api_key_hint) "
                    "VALUES (%s, %s, %s, %s, %s, %s) RETURNING *",
                    (user_id, email, password_hash, name, api_key_hash, api_key_hint),
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

    def get_user_by_api_key(self, api_key_hash: str) -> dict[str, Any] | None:
        """Look up a user by the SHA-256 hash of their API key."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT * FROM users WHERE api_key_hash = %s", (api_key_hash,))
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

    def create_oauth_user(self, user_id: str, email: str, name: str | None,
                          api_key_hash: str, api_key_hint: str,
                          oauth_provider: str, oauth_provider_id: str) -> dict[str, Any]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO users (id, email, name, api_key_hash, api_key_hint, oauth_provider, oauth_provider_id) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *",
                    (user_id, email, name, api_key_hash, api_key_hint, oauth_provider, oauth_provider_id),
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

    def update_user_api_key(self, user_id: str, api_key_hash: str, api_key_hint: str) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE users SET api_key_hash = %s, api_key_hint = %s WHERE id = %s RETURNING *",
                    (api_key_hash, api_key_hint, user_id),
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

    def get_all_users(self) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT id, email, name, team, is_superuser, oauth_provider, created_at "
                    "FROM users ORDER BY created_at DESC"
                )
                return [dict(row) for row in cursor.fetchall()]

    def update_user_team(self, user_id: str, team: str | None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE users SET team = %s WHERE id = %s RETURNING *",
                    (team, user_id),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row) if row else None

    def set_superuser(self, user_id: str, is_superuser: bool) -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE users SET is_superuser = %s WHERE id = %s",
                    (is_superuser, user_id),
                )
                conn.commit()

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

    def get_episodes(self, session_id: str, step: int | None = None) -> list[dict[str, Any]]:
        """Retrieve episodes for a session, optionally filtered by step."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if step is not None:
                    cursor.execute(
                        "SELECT * FROM episodes WHERE session_id = %s AND step = %s ORDER BY step",
                        (session_id, step),
                    )
                else:
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

    def create_chat_session(self, session_id: str, title: str = "New chat", user_id: str | None = None) -> dict[str, Any]:
        chat_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO chat_sessions (id, session_id, title, user_id) VALUES (%s, %s, %s, %s) RETURNING *",
                    (chat_id, session_id, title, user_id),
                )
                row = cursor.fetchone()
                conn.commit()
                d = dict(row)
                d["message_count"] = 0
                return d

    def get_chat_sessions(self, session_id: str, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute(
                        """
                        SELECT cs.*, COALESCE(mc.cnt, 0) AS message_count
                        FROM chat_sessions cs
                        LEFT JOIN (SELECT chat_session_id, COUNT(*) AS cnt FROM chat_messages GROUP BY chat_session_id) mc
                            ON mc.chat_session_id = cs.id
                        WHERE cs.session_id = %s AND cs.user_id = %s
                        ORDER BY cs.updated_at DESC
                        """,
                        (session_id, user_id),
                    )
                else:
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

    def delete_chat_session(self, chat_session_id: str, user_id: str | None = None) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("SELECT id FROM chat_sessions WHERE id = %s AND user_id = %s", (chat_session_id, user_id))
                else:
                    cursor.execute("SELECT id FROM chat_sessions WHERE id = %s", (chat_session_id,))
                if not cursor.fetchone():
                    return False
                if user_id:
                    cursor.execute("DELETE FROM chat_sessions WHERE id = %s AND user_id = %s", (chat_session_id, user_id))
                else:
                    cursor.execute("DELETE FROM chat_sessions WHERE id = %s", (chat_session_id,))
                conn.commit()
                return True

    def get_chat_messages(self, chat_session_id: str, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                # Verify ownership of parent chat session when user_id is set
                if user_id:
                    cursor.execute("SELECT id FROM chat_sessions WHERE id = %s AND user_id = %s", (chat_session_id, user_id))
                    if not cursor.fetchone():
                        return []
                cursor.execute(
                    "SELECT * FROM chat_messages WHERE chat_session_id = %s ORDER BY created_at ASC",
                    (chat_session_id,),
                )
                rows = cursor.fetchall()
                return [dict(row) for row in rows]

    def append_chat_message(self, chat_session_id: str, role: str, content: str, user_id: str | None = None) -> dict[str, Any]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                # Verify ownership of parent chat session when user_id is set
                if user_id:
                    cursor.execute("SELECT id FROM chat_sessions WHERE id = %s AND user_id = %s", (chat_session_id, user_id))
                    if not cursor.fetchone():
                        raise ValueError("Chat session not found or not owned by user")
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

    def create_eval_result(self, data: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
        result_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO eval_results (id, session_id, dataset_name, model, agent, score, total, correct, errors, signal_averages, items, user_id)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *""",
                    (result_id, data["session_id"], data["dataset_name"], data["model"], data["agent"],
                     data["score"], data["total"], data["correct"], data["errors"],
                     json.dumps(data.get("signal_averages", {})), json.dumps(data.get("items", [])), user_id),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)

    def get_eval_results(self, session_id: str | None = None, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                clauses = []
                params: list[Any] = []
                if session_id:
                    clauses.append("session_id = %s")
                    params.append(session_id)
                if user_id:
                    clauses.append("user_id = %s")
                    params.append(user_id)
                where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
                cursor.execute(f"SELECT * FROM eval_results{where} ORDER BY created_at DESC", params)
                return [dict(row) for row in cursor.fetchall()]

    def get_eval_result(self, result_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("SELECT * FROM eval_results WHERE id = %s AND user_id = %s", (result_id, user_id))
                else:
                    cursor.execute("SELECT * FROM eval_results WHERE id = %s", (result_id,))
                row = cursor.fetchone()
                return dict(row) if row else None

    def get_eval_results_by_project(self, project_id: str, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute(
                        """SELECT er.* FROM eval_results er
                        JOIN sessions s ON er.session_id = s.id
                        JOIN projects p ON s.project_id = p.id
                        WHERE p.id = %s AND p.owner_id = %s
                        ORDER BY er.created_at DESC""",
                        (project_id, user_id),
                    )
                else:
                    cursor.execute(
                        """SELECT er.* FROM eval_results er
                        JOIN sessions s ON er.session_id = s.id
                        WHERE s.project_id = %s
                        ORDER BY er.created_at DESC""",
                        (project_id,),
                    )
                return [dict(row) for row in cursor.fetchall()]

    def delete_all_eval_results(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("DELETE FROM eval_results WHERE user_id = %s", (user_id,))
                else:
                    cursor.execute("DELETE FROM eval_results")
                count = cursor.rowcount
                conn.commit()
                return count

    # ── Skill methods ──────────────────────────────────────────────

    def create_skill(self, data: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
        skill_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO skills (id, title, description, category, confidence, reward_delta,
                       success_rate, evidence_count, source_session_ids, tags, is_active, metadata, user_id)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *""",
                    (skill_id, data["title"], data["description"],
                     data.get("category", "general"), data.get("confidence", 0.0),
                     data.get("reward_delta", 0.0), data.get("success_rate", ""),
                     data.get("evidence_count", 0),
                     json.dumps(data.get("source_session_ids", [])),
                     json.dumps(data.get("tags", [])),
                     data.get("is_active", False),
                     json.dumps(data.get("metadata")),
                     user_id),
                )
                row = cursor.fetchone()
                conn.commit()
                return dict(row)

    def get_skills(self, is_active: bool | None = None, category: str | None = None, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                query = "SELECT * FROM skills WHERE TRUE"
                params: list[Any] = []
                if user_id is not None:
                    query += " AND user_id = %s"
                    params.append(user_id)
                if is_active is not None:
                    query += " AND is_active = %s"
                    params.append(is_active)
                if category:
                    query += " AND category = %s"
                    params.append(category)
                query += " ORDER BY created_at DESC"
                cursor.execute(query, params)
                return [dict(row) for row in cursor.fetchall()]

    def get_skill(self, skill_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                query = "SELECT * FROM skills WHERE id = %s"
                params: list[Any] = [skill_id]
                if user_id is not None:
                    query += " AND user_id = %s"
                    params.append(user_id)
                cursor.execute(query, params)
                row = cursor.fetchone()
                return dict(row) if row else None

    def update_skill(self, skill_id: str, data: dict[str, Any], user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                check_query = "SELECT id FROM skills WHERE id = %s"
                check_params: list[Any] = [skill_id]
                if user_id is not None:
                    check_query += " AND user_id = %s"
                    check_params.append(user_id)
                cursor.execute(check_query, check_params)
                if not cursor.fetchone():
                    return None
                sets = ["updated_at = CURRENT_TIMESTAMP"]
                params: list[Any] = []
                for key in ("title", "description", "category"):
                    if key in data:
                        sets.append(f"{key} = %s")
                        params.append(data[key])
                if "is_active" in data:
                    sets.append("is_active = %s")
                    params.append(data["is_active"])
                if "tags" in data:
                    sets.append("tags = %s")
                    params.append(json.dumps(data["tags"]))
                where = "WHERE id = %s"
                params.append(skill_id)
                if user_id is not None:
                    where += " AND user_id = %s"
                    params.append(user_id)
                cursor.execute(f"UPDATE skills SET {', '.join(sets)} {where}", params)
                conn.commit()
                cursor.execute("SELECT * FROM skills WHERE id = %s", (skill_id,))
                row = cursor.fetchone()
                return dict(row) if row else None

    def delete_skill(self, skill_id: str, user_id: str | None = None) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                query = "DELETE FROM skills WHERE id = %s"
                params: list[Any] = [skill_id]
                if user_id is not None:
                    query += " AND user_id = %s"
                    params.append(user_id)
                query += " RETURNING id"
                cursor.execute(query, params)
                deleted = cursor.fetchone() is not None
                conn.commit()
                return deleted

    def get_skills_for_session(self, session_id: str, user_id: str | None = None) -> list[dict[str, Any]]:
        """Return skills whose source_session_ids contain the given session_id."""
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                query = "SELECT * FROM skills WHERE source_session_ids @> %s::jsonb"
                params: list[Any] = [json.dumps([session_id])]
                if user_id is not None:
                    query += " AND user_id = %s"
                    params.append(user_id)
                query += " ORDER BY reward_delta DESC"
                cursor.execute(query, params)
                return [self._parse_skill_row(dict(row)) for row in cursor.fetchall()]

    def get_skills_for_sessions(self, session_ids: list[str], user_id: str | None = None) -> list[dict[str, Any]]:
        """Return skills whose source_session_ids overlap with any of the given session_ids."""
        if not session_ids:
            return []
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                # Use jsonb ?| operator to check if array contains ANY of the given IDs
                query = "SELECT DISTINCT ON (id) * FROM skills WHERE source_session_ids ?| %s"
                params: list[Any] = [session_ids]
                if user_id is not None:
                    query += " AND user_id = %s"
                    params.append(user_id)
                query += " ORDER BY id, reward_delta DESC"
                cursor.execute(query, params)
                return [self._parse_skill_row(dict(row)) for row in cursor.fetchall()]

    def delete_all_skills(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id is not None:
                    cursor.execute("DELETE FROM skills WHERE user_id = %s", (user_id,))
                else:
                    cursor.execute("DELETE FROM skills")
                count = cursor.rowcount
                conn.commit()
                return count

    # ── Eval upload methods ──────────────────────────────────────────

    def create_eval_upload(self, upload_id: str, filename: str, rows: list[dict[str, Any]], user_id: str | None = None) -> dict[str, Any]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO eval_uploads (upload_id, filename, row_count, user_id) VALUES (%s, %s, %s, %s) RETURNING *",
                    (upload_id, filename, len(rows), user_id),
                )
                upload = dict(cursor.fetchone())
                for row in rows:
                    # Parse task_success as boolean
                    task_success_raw = row.get("task_success", "")
                    task_success_val = None
                    if isinstance(task_success_raw, str) and task_success_raw.strip().lower() in ("true", "1", "yes"):
                        task_success_val = True
                    elif isinstance(task_success_raw, str) and task_success_raw.strip().lower() in ("false", "0", "no"):
                        task_success_val = False

                    cursor.execute(
                        """INSERT INTO eval_upload_rows
                        (upload_id, session_id, agent_trajectory, ground_truth, rating,
                         trajectory_alignment, task_success, tags,
                         reference_trajectory, reference_state, reference_answer)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (upload_id, row["session_id"], row["agent_trajectory"], row["ground_truth"],
                         row.get("rating", ""), row.get("trajectory_alignment", ""), task_success_val,
                         row.get("tags", ""),
                         row.get("reference_trajectory", ""), row.get("reference_state", ""), row.get("reference_answer", "")),
                    )
                conn.commit()
                return upload

    def get_eval_uploads(self, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("SELECT * FROM eval_uploads WHERE user_id = %s ORDER BY created_at DESC", (user_id,))
                else:
                    cursor.execute("SELECT * FROM eval_uploads ORDER BY created_at DESC")
                return [dict(row) for row in cursor.fetchall()]

    def get_eval_upload_rows(self, upload_id: str, user_id: str | None = None) -> list[dict[str, Any]] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("SELECT upload_id FROM eval_uploads WHERE upload_id = %s AND user_id = %s", (upload_id, user_id))
                else:
                    cursor.execute("SELECT upload_id FROM eval_uploads WHERE upload_id = %s", (upload_id,))
                if not cursor.fetchone():
                    return None
                cursor.execute(
                    "SELECT * FROM eval_upload_rows WHERE upload_id = %s ORDER BY id",
                    (upload_id,),
                )
                return [dict(row) for row in cursor.fetchall()]

    def delete_eval_upload(self, upload_id: str, user_id: str | None = None) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("DELETE FROM eval_uploads WHERE upload_id = %s AND user_id = %s RETURNING upload_id", (upload_id, user_id))
                else:
                    cursor.execute("DELETE FROM eval_uploads WHERE upload_id = %s RETURNING upload_id", (upload_id,))
                deleted = cursor.fetchone() is not None
                conn.commit()
                return deleted

    def delete_all_eval_uploads(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("DELETE FROM eval_uploads WHERE user_id = %s", (user_id,))
                else:
                    cursor.execute("DELETE FROM eval_uploads")
                count = cursor.rowcount
                conn.commit()
                return count

    # ── Background jobs ──────────────────────────────────────────────

    def create_job(self, job_type: str, user_id: str | None = None) -> dict[str, Any]:
        job_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO background_jobs (id, job_type, user_id) VALUES (%s, %s, %s) RETURNING *",
                    (job_id, job_type, user_id),
                )
                row = dict(cursor.fetchone())
                conn.commit()
                return self._parse_job_row(row)

    def get_job(self, job_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("SELECT * FROM background_jobs WHERE id = %s AND user_id = %s", (job_id, user_id))
                else:
                    cursor.execute("SELECT * FROM background_jobs WHERE id = %s", (job_id,))
                row = cursor.fetchone()
                return self._parse_job_row(dict(row)) if row else None

    def update_job_status(
        self,
        job_id: str,
        status: str,
        progress: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                sets = ["status = %s", "updated_at = CURRENT_TIMESTAMP"]
                vals: list[Any] = [status]
                if progress is not None:
                    sets.append("progress = %s")
                    vals.append(json.dumps(progress, default=str))
                if result is not None:
                    sets.append("result = %s")
                    vals.append(json.dumps(result, default=str))
                if error is not None:
                    sets.append("error = %s")
                    vals.append(error)
                vals.append(job_id)
                cursor.execute(
                    f"UPDATE background_jobs SET {', '.join(sets)} WHERE id = %s RETURNING *",
                    vals,
                )
                row = cursor.fetchone()
                conn.commit()
                return self._parse_job_row(dict(row)) if row else None

    def list_jobs(self, job_type: str | None = None, limit: int = 20, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                wheres: list[str] = []
                vals: list[Any] = []
                if job_type:
                    wheres.append("job_type = %s")
                    vals.append(job_type)
                if user_id:
                    wheres.append("user_id = %s")
                    vals.append(user_id)
                where_clause = (" WHERE " + " AND ".join(wheres)) if wheres else ""
                vals.append(limit)
                cursor.execute(
                    f"SELECT * FROM background_jobs{where_clause} ORDER BY created_at DESC LIMIT %s",
                    vals,
                )
                return [self._parse_job_row(dict(row)) for row in cursor.fetchall()]

    def delete_job(self, job_id: str, user_id: str | None = None) -> bool:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("DELETE FROM background_jobs WHERE id = %s AND user_id = %s RETURNING id", (job_id, user_id))
                else:
                    cursor.execute("DELETE FROM background_jobs WHERE id = %s RETURNING id", (job_id,))
                deleted = cursor.fetchone() is not None
                conn.commit()
                return deleted

    def delete_all_jobs(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("DELETE FROM background_jobs WHERE user_id = %s", (user_id,))
                else:
                    cursor.execute("DELETE FROM background_jobs")
                count = cursor.rowcount
                conn.commit()
                return count

    def cleanup_dangling_jobs(self) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE background_jobs SET status = 'failed', error = 'Server restarted', "
                    "updated_at = CURRENT_TIMESTAMP WHERE status IN ('pending', 'running')"
                )
                count = cursor.rowcount
                conn.commit()
                return count

    @staticmethod
    def _parse_job_row(d: dict[str, Any]) -> dict[str, Any]:
        for field in ("progress", "result"):
            val = d.get(field)
            if isinstance(val, str):
                try:
                    d[field] = json.loads(val)
                except (json.JSONDecodeError, TypeError):
                    d[field] = {}
            if d.get(field) is None:
                d[field] = {} if field == "progress" else None
        return d

    # ── Session clusters ─────────────────────────────────────────────

    def create_cluster(self, data: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
        cluster_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO session_clusters (id, name, task_type, description, member_count, metadata, job_id, user_id)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *""",
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
                row = dict(cursor.fetchone())
                conn.commit()
                return self._parse_cluster_row(row)

    def get_clusters(self, user_id: str | None = None) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("SELECT * FROM session_clusters WHERE user_id = %s ORDER BY member_count DESC", (user_id,))
                else:
                    cursor.execute("SELECT * FROM session_clusters ORDER BY member_count DESC")
                return [self._parse_cluster_row(dict(row)) for row in cursor.fetchall()]

    def get_cluster(self, cluster_id: str, user_id: str | None = None) -> dict[str, Any] | None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("SELECT * FROM session_clusters WHERE id = %s AND user_id = %s", (cluster_id, user_id))
                else:
                    cursor.execute("SELECT * FROM session_clusters WHERE id = %s", (cluster_id,))
                row = cursor.fetchone()
                return self._parse_cluster_row(dict(row)) if row else None

    def get_cluster_members(self, cluster_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM session_cluster_members WHERE cluster_id = %s ORDER BY created_at",
                    (cluster_id,),
                )
                return [self._parse_cluster_member_row(dict(row)) for row in cursor.fetchall()]

    def add_cluster_member(
        self, cluster_id: str, session_id: str, labels: dict[str, Any], summary: str = ""
    ) -> dict[str, Any]:
        member_id = str(uuid.uuid4())
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO session_cluster_members (id, cluster_id, session_id, labels, summary)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (cluster_id, session_id) DO UPDATE SET labels = EXCLUDED.labels, summary = EXCLUDED.summary
                    RETURNING *""",
                    (member_id, cluster_id, session_id, json.dumps(labels, default=str), summary),
                )
                row = dict(cursor.fetchone())
                # Update member_count
                cursor.execute(
                    "UPDATE session_clusters SET member_count = "
                    "(SELECT count(*) FROM session_cluster_members WHERE cluster_id = %s), "
                    "updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                    (cluster_id, cluster_id),
                )
                conn.commit()
                return self._parse_cluster_member_row(row)

    def update_cluster_metadata(self, cluster_id: str, metadata: dict[str, Any], description: str = "") -> None:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE session_clusters SET metadata = %s, description = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                    (json.dumps(metadata, default=str), description, cluster_id),
                )
                conn.commit()

    def get_clusters_by_job(self, job_id: str) -> list[dict[str, Any]]:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM session_clusters WHERE job_id = %s ORDER BY member_count DESC",
                    (job_id,),
                )
                return [self._parse_cluster_row(dict(row)) for row in cursor.fetchall()]

    def delete_all_clusters(self, user_id: str | None = None) -> int:
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                if user_id:
                    cursor.execute("DELETE FROM session_clusters WHERE user_id = %s", (user_id,))
                else:
                    cursor.execute("DELETE FROM session_clusters")
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
