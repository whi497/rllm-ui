"""Eval results router."""

from auth import CurrentUser
from fastapi import APIRouter, HTTPException, Query, Request
from models import EvalResultCreate, EvalResultResponse

router = APIRouter(prefix="/api/eval-results", tags=["eval-results"])


@router.post("", response_model=EvalResultResponse)
def create_eval_result(request: Request, body: EvalResultCreate, user: CurrentUser):
    """Store an eval result."""
    store = request.app.state.store
    result = store.create_eval_result(body.model_dump(), user_id=user["id"])
    return result


@router.get("", response_model=list[EvalResultResponse])
def list_eval_results(request: Request, user: CurrentUser, session_id: str | None = Query(None)):
    """Get eval results, optionally filtered by session_id."""
    store = request.app.state.store
    return store.get_eval_results(session_id=session_id, user_id=user["id"])


@router.get("/by-project/{project_id}", response_model=list[EvalResultResponse])
def get_eval_results_by_project(request: Request, project_id: str, user: CurrentUser):
    """Get all eval results for sessions in a project (for leaderboard grouping)."""
    store = request.app.state.store
    return store.get_eval_results_by_project(project_id, user_id=user["id"])


@router.get("/{result_id}", response_model=EvalResultResponse)
def get_eval_result(request: Request, result_id: str, user: CurrentUser):
    """Get a single eval result by ID."""
    store = request.app.state.store
    result = store.get_eval_result(result_id, user_id=user["id"])
    if result is None:
        raise HTTPException(status_code=404, detail="Eval result not found")
    return result
