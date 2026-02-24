"""Logs router for capturing and retrieving raw training output."""

from auth import CurrentUser
from fastapi import APIRouter, Request
from models import LogBatchCreate

router = APIRouter(prefix="/api", tags=["logs"])


@router.post("/logs/batch")
async def batch_create_logs(batch: LogBatchCreate, request: Request, user: CurrentUser):
    """Receive a batch of log entries from the training process."""
    store = request.app.state.store
    for log in batch.logs:
        store.append_log(
            batch.session_id,
            {
                "timestamp": log.timestamp,
                "stream": log.stream,
                "message": log.message,
            },
        )
    return {"status": "ok", "count": len(batch.logs)}


@router.get("/sessions/{session_id}/logs")
async def get_logs(session_id: str, request: Request, user: CurrentUser, stream: str | None = None, limit: int = 1000, offset: int = 0):
    """Retrieve logs for a session with optional stream filter."""
    store = request.app.state.store
    logs = store.get_logs(session_id, stream=stream, limit=limit, offset=offset)
    return logs
