"""Episodes router - handles episode/trajectory data."""

from auth import CurrentUser
from fastapi import APIRouter, HTTPException, Query, Request
from models import AgentEpisode, AgentStep, Episode, EpisodeResponse, EpisodeSearchResponse, Step

from datastore.base import extract_searchable_text

router = APIRouter(prefix="/api", tags=["episodes"])


@router.post("/episodes", response_model=EpisodeResponse)
async def create_episode(request: Request, user: CurrentUser):
    """Receive and store episode data with trajectories."""
    body = await request.json()
    session_type = body.get("session_type", "training")

    if session_type == "eval":
        episode = Episode(**body)
        step_model = Step
    else:
        episode = AgentEpisode(**body)
        step_model = AgentStep

    store = request.app.state.store

    session = store.get_session(episode.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    episode_data = episode.model_dump(mode="json")
    search_text = extract_searchable_text(episode_data, step_model)
    store.append_episode(episode.session_id, episode_data, search_text=search_text)

    return store.get_episode(episode.episode_id)


@router.post("/episodes/batch")
async def batch_create_episodes(request: Request, user: CurrentUser):
    """Receive a batch of episodes in a single request."""
    body = await request.json()
    session_id = body.get("session_id")
    episodes_data = body.get("episodes", [])

    store = request.app.state.store
    session = store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    for ep_body in episodes_data:
        session_type = ep_body.get("session_type", "training")
        if session_type == "eval":
            episode = Episode(**ep_body)
            step_model = Step
        else:
            episode = AgentEpisode(**ep_body)
            step_model = AgentStep

        episode_data = episode.model_dump(mode="json")
        search_text = extract_searchable_text(episode_data, step_model)
        store.append_episode(episode.session_id, episode_data, search_text=search_text)

    return {"status": "ok", "count": len(episodes_data)}


@router.get("/episodes", response_model=list[EpisodeResponse])
def get_episodes(
    request: Request,
    user: CurrentUser,
    session_id: str = Query(..., description="Filter episodes by session ID"),
    step: int | None = Query(None, description="Optional step filter"),
):
    """Query episodes by session ID, optionally filtered by step."""
    store = request.app.state.store

    session = store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return store.get_episodes(session_id, step=step)


@router.get("/episodes/search", response_model=EpisodeSearchResponse)
def search_episodes(
    request: Request,
    user: CurrentUser,
    q: str = Query(..., description="Search query"),
    session_id: str | None = Query(None, description="Optional session ID to filter results"),
    step: int | None = Query(None, description="Optional step number to filter results"),
):
    """Search episodes by text content.

    Searches through task descriptions, observations, actions, and model responses.
    PostgreSQL backend provides full-text search with stemming and relevance ranking.

    Returns:
        EpisodeSearchResponse with:
        - episodes: List of matching episodes (PostgreSQL includes rank field)
        - matched_terms: Stemmed terms (PostgreSQL) or original query terms (SQLite)
    """
    store = request.app.state.store
    return store.search_episodes(q, session_id, step=step)


@router.get("/episodes/{episode_id}", response_model=EpisodeResponse)
def get_episode(request: Request, episode_id: str, user: CurrentUser):
    """Get a single episode with full trajectory data."""
    store = request.app.state.store
    episode = store.get_episode(episode_id)
    if episode is None:
        raise HTTPException(status_code=404, detail="Episode not found")
    return episode
