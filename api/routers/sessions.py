"""Sessions router."""

from auth import CurrentUser
from fastapi import APIRouter, HTTPException, Query, Request
from models import ProjectRename, ProjectResponse, SessionCreate, SessionFinish, SessionUpdate, SessionResponse

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=SessionResponse)
def create_session(request: Request, session: SessionCreate, user: CurrentUser):
    """Create a new training session."""
    store = request.app.state.store
    owner_id = user["id"] if user else None
    session_id = store.create_session(
        project=session.project, experiment=session.experiment,
        config=session.config, source_metadata=session.source_metadata,
        owner_id=owner_id, session_type=session.session_type,
    )
    return store.get_session(session_id)


@router.get("", response_model=list[SessionResponse])
def list_sessions(request: Request, user: CurrentUser, type: str | None = Query(None)):
    """List all sessions, optionally filtered by session_type."""
    store = request.app.state.store
    owner_id = user["id"] if user else None
    sessions = store.get_all_sessions(owner_id=owner_id)
    if type:
        sessions = [s for s in sessions if s.get("session_type", "training") == type]
    return sessions


@router.get("/projects", response_model=list[ProjectResponse])
def list_projects(request: Request, user: CurrentUser):
    """List all projects with their sessions."""
    store = request.app.state.store
    owner_id = user["id"] if user else None
    return store.get_projects(owner_id=owner_id)


@router.patch("/projects/{project_id}")
def rename_project(request: Request, project_id: str, body: ProjectRename, user: CurrentUser):
    """Rename a project."""
    store = request.app.state.store
    if not body.new_name or not body.new_name.strip():
        raise HTTPException(status_code=400, detail="Project name cannot be empty")
    try:
        result = store.rename_project(project_id, body.new_name.strip())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return result


@router.delete("/projects/{project_id}")
def delete_project(request: Request, project_id: str, user: CurrentUser):
    """Delete a project and all its sessions."""
    store = request.app.state.store
    deleted = store.delete_project(project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}


@router.patch("/{session_id}")
def update_session(request: Request, session_id: str, body: SessionUpdate, user: CurrentUser):
    """Update a session's experiment name and/or color."""
    store = request.app.state.store
    experiment = None
    if body.new_experiment_name is not None:
        if not body.new_experiment_name.strip():
            raise HTTPException(status_code=400, detail="Experiment name cannot be empty")
        experiment = body.new_experiment_name.strip()
    if experiment is None and body.color is None:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = store.update_session(session_id, experiment=experiment, color=body.color)
    if result is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return result


@router.delete("/{session_id}")
def delete_session(request: Request, session_id: str, user: CurrentUser):
    """Delete a session and all its children."""
    store = request.app.state.store
    deleted = store.delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


@router.get("/{session_id}", response_model=SessionResponse)
def get_session(request: Request, session_id: str, user: CurrentUser):
    """Get a specific session by ID."""
    store = request.app.state.store
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.post("/{session_id}/complete", response_model=SessionResponse)
def complete_session(request: Request, session_id: str, user: CurrentUser, body: SessionFinish | None = None):
    """Mark a session as completed or failed."""
    store = request.app.state.store
    status = body.status if body else "completed"
    if status not in ("completed", "failed"):
        status = "completed"
    session = store.complete_session(session_id, status=status)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.post("/{session_id}/heartbeat")
def heartbeat_session(request: Request, session_id: str, user: CurrentUser):
    """Update the heartbeat timestamp for a session."""
    store = request.app.state.store
    found = store.heartbeat_session(session_id)
    if not found:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}
