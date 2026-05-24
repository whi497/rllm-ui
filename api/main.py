"""rLLM UI API - FastAPI Application.

Main entry point for the API backend.
"""
# Python 3.10 compat: inject datetime.UTC (added in 3.11)
import sys as _sys
if _sys.version_info < (3, 11):
    import datetime as _dt
    _dt.UTC = _dt.timezone.utc

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

from datastore.factory import get_datastore
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import admin, agent, agent_sessions, auth, clusters, episodes, eval_results, eval_uploads, health, jobs, logs, metrics, oauth, sessions, settings, skills, span_uploads, sse, trajectory_groups

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown."""
    # Startup — retry DB connection (private networking tunnel may take a moment)
    app.state.store = get_datastore()
    max_retries = 10
    for attempt in range(1, max_retries + 1):
        try:
            app.state.store.init_db()
            logger.info(f"Database connected (attempt {attempt})")
            break
        except Exception as e:
            if attempt == max_retries:
                logger.error(f"Failed to connect to database after {max_retries} attempts: {e}")
                raise
            logger.warning(f"Database connection attempt {attempt}/{max_retries} failed: {e}. Retrying in 3s...")
            time.sleep(3)

    # Initialize global agent from ANTHROPIC_API_KEY (per-user keys take priority at request time)
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            from agent import ObservabilityAgent

            app.state.agent = ObservabilityAgent(datastore=app.state.store)
            logger.info("Observability Agent initialized successfully")
        except Exception as e:
            logger.warning(f"Failed to initialize Observability Agent: {e}")
            app.state.agent = None
    else:
        logger.info("ANTHROPIC_API_KEY not set, Observability Agent disabled")
        app.state.agent = None

    # Initialize ClickHouse client (optional — only if configured)
    ch_host = os.environ.get("CLICKHOUSE_HOST")
    if ch_host:
        try:
            from datastore.clickhouse_client import ClickHouseClient

            app.state.clickhouse = ClickHouseClient()
            app.state.clickhouse.init_tables()
            logger.info("ClickHouse connected for agent trajectories")
        except Exception as e:
            logger.warning(f"Failed to connect to ClickHouse: {e}")
            app.state.clickhouse = None
    else:
        app.state.clickhouse = None
        logger.info("CLICKHOUSE_HOST not set, agent trajectory features disabled")

    # Initialize PostgreSQL span client (always available if using Postgres)
    db_url = os.environ.get("DATABASE_URL")
    if db_url and db_url.startswith("postgresql"):
        try:
            from datastore.postgres_span_store import PostgresSpanClient

            app.state.postgres_spans = PostgresSpanClient(db_url)
            logger.info("PostgreSQL span client initialized for imported agent traces")
        except Exception as e:
            logger.warning(f"Failed to initialize PostgreSQL span client: {e}")
            app.state.postgres_spans = None
    else:
        app.state.postgres_spans = None
        logger.info("PostgreSQL span client not initialized (no PostgreSQL DATABASE_URL)")

    # Initialize BigQuery client (optional — from env or local_settings file)
    import local_settings as _ls

    bq_project = os.environ.get("BQ_PROJECT") or _ls.get("bq_project")
    if bq_project:
        try:
            from datastore.bigquery_client import BigQueryClient

            bq_dataset = _ls.get("bq_dataset")
            bq_table = _ls.get("bq_table")
            app.state.bigquery = BigQueryClient(project=bq_project, dataset=bq_dataset, table=bq_table)
            logger.info("BigQuery connected for agent trace reading")
        except Exception as e:
            logger.warning(f"Failed to connect to BigQuery: {e}")
            app.state.bigquery = None
    else:
        app.state.bigquery = None
        logger.info("BigQuery not configured (set via Settings page or BQ_PROJECT env)")

    # Initialize job manager
    from jobs import JobManager

    app.state.job_manager = JobManager(app.state.store)
    app.state.job_manager.cleanup_dangling_jobs()

    # Start background crash detection loop
    async def crash_detection_loop():
        while True:
            await asyncio.sleep(60)
            try:
                count = app.state.store.mark_crashed_sessions(timeout_seconds=300)
                if count > 0:
                    logger.info(f"Marked {count} session(s) as crashed")
            except Exception as e:
                logger.warning(f"Crash detection error: {e}")

    crash_task = asyncio.create_task(crash_detection_loop())

    yield

    # Shutdown
    app.state.job_manager.cancel_all()
    crash_task.cancel()
    app.state.store.close()
    if getattr(app.state, "postgres_spans", None):
        app.state.postgres_spans.close()
    if getattr(app.state, "clickhouse", None):
        app.state.clickhouse.close()
    if getattr(app.state, "bigquery", None):
        app.state.bigquery.close()


# Create FastAPI app
app = FastAPI(
    title="rLLM UI API",
    description="Backend API for rLLM training monitoring and visualization",
    version="0.1.0",
    lifespan=lifespan,
)

# Configure CORS — use CORS_ORIGINS env var if set, otherwise fall back to localhost defaults
_default_origins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:5176",
    "http://localhost:5177",
    "http://localhost:5178",
    "http://localhost:3000",
]
_cors_origins = os.environ.get("CORS_ORIGINS")
allow_origins = [o.strip() for o in _cors_origins.split(",") if o.strip()] if _cors_origins else _default_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(oauth.router)
app.include_router(sessions.router)
app.include_router(metrics.router)
app.include_router(sse.router)
app.include_router(episodes.router)
app.include_router(agent.router)
app.include_router(settings.router)
app.include_router(logs.router)
app.include_router(trajectory_groups.router)
app.include_router(eval_results.router)
app.include_router(eval_uploads.router)
app.include_router(span_uploads.router)
app.include_router(skills.router)
app.include_router(agent_sessions.router)
app.include_router(jobs.router)
app.include_router(clusters.router)
app.include_router(admin.router)
