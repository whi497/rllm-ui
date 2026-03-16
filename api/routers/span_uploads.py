"""Span uploads router — CSV upload of agent spans, list, inspect, delete."""

import csv
import io
import json
import time
from datetime import datetime, timezone

from auth import CurrentUser
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from models import SpanUploadListResponse, SpanUploadResponse, SpanUploadSessionListResponse, SpanUploadSessionResponse

router = APIRouter(prefix="/api/span-uploads", tags=["span-uploads"])

REQUIRED_COLUMNS = {"session_id", "span_type", "data"}

VALID_SPAN_TYPES = frozenset({
    "trajectory.start", "trajectory.step", "trajectory.end",
    "llm.start", "llm.end",
    "tool.start", "tool.end",
    "agent.start", "agent.end",
    "invocation.start", "invocation.end",
    "event", "session", "session.start", "tool.data",
})

# Span types that are meaningful for downstream tasks (distillation, post-training)
MEANINGFUL_SPAN_TYPES = frozenset({
    "trajectory.start", "trajectory.step", "trajectory.end",
    "llm.start", "llm.end",
    "tool.start", "tool.end", "tool.data",
    "agent.start", "agent.end",
    "invocation.start", "invocation.end",
    "session.start",
})


@router.post("", response_model=SpanUploadResponse)
async def upload_span_csv(request: Request, user: CurrentUser, file: UploadFile = File(...)):
    """Upload a CSV file with agent spans."""
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only .csv files are accepted")

    contents = await file.read()
    try:
        text = contents.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded")

    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise HTTPException(status_code=400, detail="CSV file appears to be empty")

    actual_columns = set(reader.fieldnames)
    missing = REQUIRED_COLUMNS - actual_columns
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"CSV is missing required columns: {', '.join(sorted(missing))}. "
                   f"Required: {', '.join(sorted(REQUIRED_COLUMNS))}",
        )

    rows = list(reader)
    if not rows:
        raise HTTPException(status_code=400, detail="CSV file contains no data rows")

    # ── Validate each row ──────────────────────────────────────────
    errors: list[str] = []
    sessions: dict[str, list[dict]] = {}  # session_id -> list of span dicts

    for i, row in enumerate(rows, start=2):  # row 2 = first data row (after header)
        session_id = (row.get("session_id") or "").strip()
        span_type = (row.get("span_type") or "").strip()
        data_str = (row.get("data") or "").strip()

        if not session_id:
            errors.append(f"Row {i}: empty session_id")
            continue
        if not span_type:
            errors.append(f"Row {i}: empty span_type")
            continue
        if span_type not in VALID_SPAN_TYPES:
            errors.append(f"Row {i}: unknown span_type '{span_type}' "
                          f"(expected one of: {', '.join(sorted(VALID_SPAN_TYPES))})")
            continue

        # Validate data is valid JSON
        try:
            data = json.loads(data_str) if data_str else {}
        except json.JSONDecodeError as e:
            errors.append(f"Row {i}: invalid JSON in data column: {e}")
            continue

        span = {
            "span_type": span_type,
            "data": data,
            "span_id": (row.get("span_id") or "").strip() or None,
            "invocation_id": (row.get("invocation_id") or "").strip() or None,
            "agent_name": (row.get("agent_name") or "").strip() or None,
            "model": (row.get("model") or "").strip() or None,
            "tool_name": (row.get("tool_name") or "").strip() or None,
            "tool_type": (row.get("tool_type") or "").strip() or None,
            "error": (row.get("error") or "").strip() or None,
        }

        # Parse duration
        dur_val = (row.get("duration_ms") or "").strip()
        if dur_val:
            try:
                span["duration_ms"] = float(dur_val)
            except ValueError:
                errors.append(f"Row {i}: invalid number in duration_ms: '{dur_val}'")

        # Parse timestamp columns (accept both epoch floats and ISO 8601 strings)
        for col in ("started_at", "ended_at"):
            val = (row.get(col) or "").strip()
            if val:
                try:
                    span[col] = float(val)
                except ValueError:
                    try:
                        dt = datetime.fromisoformat(val)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        span[col] = dt.timestamp()
                    except ValueError:
                        errors.append(f"Row {i}: invalid timestamp in {col}: '{val}'")
                        continue

        for col in ("input_tokens", "output_tokens", "total_tokens"):
            val = (row.get(col) or "").strip()
            if val:
                try:
                    span[col] = int(val)
                except ValueError:
                    errors.append(f"Row {i}: invalid integer in {col}: '{val}'")
                    continue

        sessions.setdefault(session_id, []).append(span)

    if errors:
        # Show first 10 errors
        detail = f"{len(errors)} validation error(s):\n" + "\n".join(errors[:10])
        if len(errors) > 10:
            detail += f"\n... and {len(errors) - 10} more"
        raise HTTPException(status_code=400, detail=detail)

    # ── Validate session-level quality ─────────────────────────────
    empty_sessions = []
    for sid, spans in sessions.items():
        span_types = {s["span_type"] for s in spans}
        has_meaningful = bool(span_types & MEANINGFUL_SPAN_TYPES)
        if not has_meaningful:
            empty_sessions.append(sid)

    if empty_sessions:
        raise HTTPException(
            status_code=400,
            detail=f"{len(empty_sessions)} session(s) have no meaningful span types "
                   f"(need at least one of: llm.*, tool.*, agent.*, invocation.*, trajectory.*). "
                   f"Sessions: {', '.join(empty_sessions[:5])}"
                   + (f" and {len(empty_sessions) - 5} more" if len(empty_sessions) > 5 else ""),
        )

    # ── Check for duplicate session_ids against existing imports ───
    pg_spans = getattr(request.app.state, "postgres_spans", None)
    if pg_spans:
        existing = pg_spans.check_session_ids_exist(list(sessions.keys()), user_id=user["id"])
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"{len(existing)} session_id(s) already exist in imported data: "
                       f"{', '.join(sorted(existing)[:5])}"
                       + (f" and {len(existing) - 5} more" if len(existing) > 5 else ""),
            )

    # ── Store ──────────────────────────────────────────────────────
    base_name = file.filename.rsplit(".", 1)[0] if "." in file.filename else file.filename
    epoch = int(time.time())
    upload_id = f"{base_name}_{epoch}"

    result = pg_spans.create_span_upload(
        upload_id=upload_id,
        filename=file.filename,
        sessions=sessions,
        user_id=user["id"],
    )
    return result


@router.get("", response_model=SpanUploadListResponse)
def list_span_uploads(
    request: Request,
    user: CurrentUser,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """List past span uploads with pagination."""
    pg_spans = getattr(request.app.state, "postgres_spans", None)
    if not pg_spans:
        return SpanUploadListResponse(uploads=[], total=0)
    uploads = pg_spans.get_span_uploads(limit=limit, offset=offset, user_id=user["id"])
    total = pg_spans.count_span_uploads(user_id=user["id"])
    return SpanUploadListResponse(uploads=uploads, total=total)


@router.get("/{upload_id}/sessions", response_model=SpanUploadSessionListResponse)
def get_span_upload_sessions(
    request: Request,
    upload_id: str,
    user: CurrentUser,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """Get sessions for a specific upload with pagination."""
    pg_spans = getattr(request.app.state, "postgres_spans", None)
    if not pg_spans:
        raise HTTPException(status_code=404, detail="Upload not found")
    sessions = pg_spans.get_span_upload_sessions(upload_id, limit=limit, offset=offset, user_id=user["id"])
    if sessions is None:
        raise HTTPException(status_code=404, detail="Upload not found")
    total = pg_spans.count_span_upload_sessions(upload_id)  # count is scoped by upload which is already owned
    return SpanUploadSessionListResponse(sessions=sessions, total=total)


@router.delete("/{upload_id}")
def delete_span_upload(request: Request, upload_id: str, user: CurrentUser):
    """Delete an upload and all its sessions/spans."""
    pg_spans = getattr(request.app.state, "postgres_spans", None)
    if not pg_spans:
        raise HTTPException(status_code=404, detail="Upload not found")
    deleted = pg_spans.delete_span_upload(upload_id, user_id=user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Upload not found")
    return {"ok": True}
