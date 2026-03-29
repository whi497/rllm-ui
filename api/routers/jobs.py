"""Background jobs router — list, inspect, delete."""

from auth import CurrentUser
from fastapi import APIRouter, HTTPException, Query, Request
from models import BackgroundJobResponse

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("", response_model=list[BackgroundJobResponse])
def list_jobs(
    request: Request,
    user: CurrentUser,
    job_type: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
):
    """List recent background jobs, optionally filtered by type."""
    return request.app.state.store.list_jobs(job_type=job_type, limit=limit, user_id=user["id"])


@router.get("/{job_id}", response_model=BackgroundJobResponse)
def get_job(request: Request, job_id: str, user: CurrentUser):
    """Get a single job's status and progress."""
    job = request.app.state.store.get_job(job_id, user_id=user["id"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.delete("/{job_id}")
def delete_job(request: Request, job_id: str, user: CurrentUser):
    """Delete a completed or failed job. Returns 409 if still running."""
    job = request.app.state.store.get_job(job_id, user_id=user["id"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] in ("pending", "running"):
        raise HTTPException(status_code=409, detail="Cannot delete a running job")
    request.app.state.store.delete_job(job_id, user_id=user["id"])
    return {"ok": True}
