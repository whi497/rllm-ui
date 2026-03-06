"""rLLM UI API - FastAPI Application.

Main entry point for the API backend.
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from dotenv import load_dotenv

load_dotenv()

from datastore.factory import get_datastore
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import agent, auth, episodes, eval_results, health, logs, metrics, oauth, sessions, settings, sse, trajectory_groups

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

    # Initialize global agent (local mode only — cloud mode uses per-user keys)
    from auth import IS_CLOUD

    if IS_CLOUD:
        logger.info("Cloud mode: skipping global agent init (per-user keys only)")
        app.state.agent = None
    elif os.environ.get("ANTHROPIC_API_KEY"):
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
    crash_task.cancel()
    app.state.store.close()


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
