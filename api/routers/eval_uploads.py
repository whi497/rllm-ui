"""Eval uploads router — CSV upload, list, inspect, delete."""

import csv
import io
import time

from auth import CurrentUser
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from models import EvalExplorerRow, EvalExplorerSessionInfo, EvalUploadResponse, EvalUploadRowResponse

router = APIRouter(prefix="/api/eval-uploads", tags=["eval-uploads"])

REQUIRED_COLUMNS = {"session_id", "ground_truth", "rating"}


@router.post("", response_model=EvalUploadResponse)
async def upload_eval_csv(request: Request, user: CurrentUser, file: UploadFile = File(...)):
    """Upload a CSV file with eval results."""
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

    # ── Validate session_ids against all data sources ──────────────
    session_ids = {row.get("session_id", "").strip() for row in rows}
    session_ids.discard("")

    if not session_ids:
        raise HTTPException(status_code=400, detail="All session_id values are empty")

    clickhouse = getattr(request.app.state, "clickhouse", None)
    bigquery = getattr(request.app.state, "bigquery", None)
    pg_spans = getattr(request.app.state, "postgres_spans", None)

    if not clickhouse and not bigquery and not pg_spans:
        raise HTTPException(
            status_code=400,
            detail="No data source configured (ClickHouse, BigQuery, or imported spans). "
                   "Import agent spans or configure a data source before uploading eval results.",
        )

    found: set[str] = set()
    uid = user["id"]
    if clickhouse:
        found |= clickhouse.check_session_ids_exist(list(session_ids), user_id=uid)
    if bigquery:
        found |= bigquery.check_session_ids_exist(list(session_ids), user_id=uid)
    if pg_spans:
        found |= pg_spans.check_session_ids_exist(list(session_ids), user_id=uid)

    not_found = session_ids - found
    if not_found:
        examples = sorted(not_found)[:10]
        raise HTTPException(
            status_code=400,
            detail=f"{len(not_found)} session_id(s) not found in any data source: "
                   f"{', '.join(examples)}"
                   + (f" (and {len(not_found) - 10} more)" if len(not_found) > 10 else ""),
        )

    # Build upload_id: filename (without extension) + epoch timestamp
    base_name = file.filename.rsplit(".", 1)[0] if "." in file.filename else file.filename
    epoch = int(time.time())
    upload_id = f"{base_name}_{epoch}"

    store = request.app.state.store
    result = store.create_eval_upload(
        upload_id=upload_id,
        filename=file.filename,
        rows=[
            {
                "session_id": row.get("session_id", ""),
                "agent_trajectory": "",
                "ground_truth": row.get("ground_truth", ""),
                "rating": row.get("rating", ""),
                "trajectory_alignment": row.get("trajectory_alignment", ""),
                "task_success": row.get("task_success", ""),
                "tags": row.get("tags", ""),
                "reference_trajectory": row.get("reference_trajectory", ""),
                "reference_state": row.get("reference_state", ""),
                "reference_answer": row.get("reference_answer", ""),
            }
            for row in rows
        ],
        user_id=user["id"],
    )
    return result


@router.get("", response_model=list[EvalUploadResponse])
def list_eval_uploads(request: Request, user: CurrentUser):
    """List all past eval uploads."""
    store = request.app.state.store
    return store.get_eval_uploads(user_id=user["id"])


@router.get("/explorer", response_model=list[EvalExplorerRow])
def get_eval_explorer(
    request: Request,
    user: CurrentUser,
    upload_id: str | None = Query(None),
):
    """Get eval rows joined with session metadata from imported spans."""
    store = request.app.state.store
    pg_spans = getattr(request.app.state, "postgres_spans", None)

    # Fetch eval rows (all or filtered by upload)
    if upload_id:
        rows = store.get_eval_upload_rows(upload_id, user_id=user["id"])
        if rows is None:
            raise HTTPException(status_code=404, detail="Upload not found")
    else:
        # Get all rows across all uploads
        all_uploads = store.get_eval_uploads(user_id=user["id"])
        rows = []
        for u in all_uploads:
            upload_rows = store.get_eval_upload_rows(u["upload_id"], user_id=user["id"])
            if upload_rows:
                rows.extend(upload_rows)

    if not rows:
        return []

    # Gather unique session_ids and fetch summaries from postgres spans
    session_ids = list({r["session_id"] for r in rows if r.get("session_id")})
    session_map: dict = {}
    if pg_spans and session_ids:
        session_map = pg_spans.get_session_summaries(session_ids)

    # Build response
    result = []
    for r in rows:
        sid = r.get("session_id", "")
        sess_info = None
        if sid in session_map:
            s = session_map[sid]
            sess_info = EvalExplorerSessionInfo(
                name=s.get("name", ""),
                status=s.get("status", "unknown"),
                agent_name=s.get("agent_name") or None,
                span_count=s.get("span_count", 0),
                llm_calls=s.get("llm_calls", 0),
                tool_calls=s.get("tool_calls", 0),
                created_at=s.get("created_at"),
            )
        result.append(EvalExplorerRow(
            id=r["id"],
            upload_id=r["upload_id"],
            session_id=sid,
            ground_truth=r.get("ground_truth", ""),
            rating=r.get("rating", ""),
            trajectory_alignment=r.get("trajectory_alignment", ""),
            task_success=str(r["task_success"]).lower() if r.get("task_success") is not None else "",
            tags=r.get("tags", ""),
            reference_trajectory=r.get("reference_trajectory", ""),
            reference_state=r.get("reference_state", ""),
            reference_answer=r.get("reference_answer", ""),
            created_at=r["created_at"],
            session=sess_info,
        ))
    return result


@router.get("/{upload_id}/rows", response_model=list[EvalUploadRowResponse])
def get_eval_upload_rows(request: Request, upload_id: str, user: CurrentUser):
    """Get all rows for a specific upload."""
    store = request.app.state.store
    rows = store.get_eval_upload_rows(upload_id, user_id=user["id"])
    if rows is None:
        raise HTTPException(status_code=404, detail="Upload not found")
    for r in rows:
        if r.get("task_success") is not None:
            r["task_success"] = str(r["task_success"]).lower()
        else:
            r["task_success"] = ""
    return rows


@router.delete("/{upload_id}")
def delete_eval_upload(request: Request, upload_id: str, user: CurrentUser):
    """Delete an upload and all its rows."""
    store = request.app.state.store
    deleted = store.delete_eval_upload(upload_id, user_id=user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Upload not found")
    return {"ok": True}
