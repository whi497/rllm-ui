"""Trajectory Groups router - handles trajectory group data."""

from auth import CurrentUser
from fastapi import APIRouter, HTTPException, Query, Request
from models import TrajectoryGroupCreate, TrajectoryGroupListResponse, TrajectoryGroupResponse, TrajectoryGroupSearchResponse

router = APIRouter(prefix="/api", tags=["trajectory-groups"])


@router.post("/trajectory-groups", response_model=TrajectoryGroupResponse)
def create_trajectory_group(request: Request, group: TrajectoryGroupCreate, user: CurrentUser):
    """Receive and store trajectory group data."""
    store = request.app.state.store

    session = store.get_session(group.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    group_data = group.model_dump(mode="json")
    store.append_trajectory_group(group.session_id, group_data)

    # Return the stored group by fetching the latest one with matching group_id
    groups = store.get_trajectory_groups(group.session_id, step=group.step)
    matching = [g for g in groups if g.get("group_id") == group.group_id]
    if matching:
        return matching[-1]  # Return most recent

    raise HTTPException(status_code=500, detail="Failed to store trajectory group")


@router.get("/trajectory-groups", response_model=TrajectoryGroupListResponse)
def get_trajectory_groups(
    request: Request,
    user: CurrentUser,
    session_id: str = Query(..., description="Session ID"),
    step: int | None = Query(None, description="Optional step filter"),
):
    """Query trajectory groups by session ID and optionally step."""
    store = request.app.state.store

    session = store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    groups = store.get_trajectory_groups(session_id, step)
    return TrajectoryGroupListResponse(groups=groups, total=len(groups))


@router.get("/trajectory-groups/search", response_model=TrajectoryGroupSearchResponse)
def search_trajectory_groups(
    request: Request,
    user: CurrentUser,
    q: str = Query(..., description="Search query"),
    session_id: str | None = Query(None),
    step: int | None = Query(None),
):
    """Search trajectory groups by content."""
    store = request.app.state.store
    return store.search_trajectory_groups(q, session_id, step=step)


@router.get("/trajectory-groups/{group_id}", response_model=TrajectoryGroupResponse)
def get_trajectory_group(
    request: Request,
    group_id: str,
    user: CurrentUser,
    include_trajectories: bool = Query(True, description="Include full trajectory data from episodes"),
):
    """Get a single trajectory group, optionally with full trajectory data fetched from episodes."""
    store = request.app.state.store
    group = store.get_trajectory_group(group_id, include_trajectories=include_trajectories)
    if group is None:
        raise HTTPException(status_code=404, detail="Trajectory group not found")
    return group
