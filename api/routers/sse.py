"""SSE (Server-Sent Events) router for real-time metric streaming."""

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from datetime import date, datetime

from auth import CurrentUser
from datastore.base import DataStore
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api", tags=["sse"])


def _json_default(obj: object) -> str:
    """Handle datetime serialization for json.dumps."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

# Keepalive interval in seconds (prevents reverse proxies from closing idle connections)
_KEEPALIVE_INTERVAL = 15

# Simple in-memory state for tracking last seen IDs
# In production, this could use Redis or similar
_last_seen_metrics: dict[str, int] = {}
_last_seen_logs: dict[str, int] = {}


async def metrics_event_generator(session_id: str, store: DataStore) -> AsyncGenerator[str, None]:
    """Generate SSE events for new metrics."""
    last_id = _last_seen_metrics.get(session_id, 0)
    last_keepalive = time.monotonic()

    while True:
        # Check for new metrics using DataStore
        new_metrics = store.get_new_metrics(session_id, last_id)

        # Send new metrics as SSE events
        for metric in new_metrics:
            last_id = metric["id"]
            _last_seen_metrics[session_id] = last_id

            # Format explicitly or pass through. The router returned id, step, data, created_at.
            # Our store returns exactly these standard columns.
            yield f"data: {json.dumps(metric, default=_json_default)}\n\n"
            last_keepalive = time.monotonic()

        # Send keepalive comment to prevent reverse proxy timeouts
        now = time.monotonic()
        if now - last_keepalive >= _KEEPALIVE_INTERVAL:
            yield ": keepalive\n\n"
            last_keepalive = now

        # Wait before polling again
        await asyncio.sleep(0.5)


@router.get("/sessions/{session_id}/metrics/stream")
async def stream_metrics(request: Request, session_id: str, user: CurrentUser):
    """Stream metrics for a session via SSE."""
    store = request.app.state.store
    return StreamingResponse(
        metrics_event_generator(session_id, store),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


async def logs_event_generator(session_id: str, store: DataStore) -> AsyncGenerator[str, None]:
    """Generate SSE events for new log entries."""
    last_id = _last_seen_logs.get(session_id, 0)
    last_keepalive = time.monotonic()

    while True:
        new_logs = store.get_new_logs(session_id, last_id)

        for log in new_logs:
            last_id = log["id"]
            _last_seen_logs[session_id] = last_id
            yield f"data: {json.dumps(log, default=_json_default)}\n\n"
            last_keepalive = time.monotonic()

        # Send keepalive comment to prevent reverse proxy timeouts
        now = time.monotonic()
        if now - last_keepalive >= _KEEPALIVE_INTERVAL:
            yield ": keepalive\n\n"
            last_keepalive = now

        await asyncio.sleep(0.5)


@router.get("/sessions/{session_id}/logs/stream")
async def stream_logs(request: Request, session_id: str, user: CurrentUser):
    """Stream logs for a session via SSE."""
    store = request.app.state.store
    return StreamingResponse(
        logs_event_generator(session_id, store),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
