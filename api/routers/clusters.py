"""Session clusters router — generate, list, inspect, delete, distill."""

import logging

from auth import CurrentUser
from fastapi import APIRouter, HTTPException, Request
from models import BackgroundJobResponse, ClusterDetailResponse, ClusterMemberResponse, ClusterResponse, SkillResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clusters", tags=["clusters"])


@router.post("/generate", response_model=BackgroundJobResponse)
async def generate_clusters(request: Request, user: CurrentUser):
    """Trigger async session clustering. Returns job ID for polling."""
    span_client = getattr(request.app.state, "postgres_spans", None)
    if span_client is None:
        raise HTTPException(status_code=503, detail="PostgreSQL span store not configured")

    store = request.app.state.store
    job_manager = request.app.state.job_manager

    from clustering.pipeline import SessionClusterer

    clusterer = SessionClusterer(span_client=span_client, store=store, user_id=user["id"])
    job = await job_manager.submit("clustering", clusterer.run, user_id=user["id"])
    return job


@router.get("", response_model=list[ClusterResponse])
def list_clusters(request: Request, user: CurrentUser):
    """List all session clusters."""
    return request.app.state.store.get_clusters(user_id=user["id"])


@router.get("/{cluster_id}", response_model=ClusterDetailResponse)
def get_cluster(request: Request, cluster_id: str, user: CurrentUser):
    """Get a single cluster with its members."""
    store = request.app.state.store
    cluster = store.get_cluster(cluster_id, user_id=user["id"])
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")
    cluster["members"] = store.get_cluster_members(cluster_id)
    return cluster


@router.delete("")
def delete_all_clusters(request: Request, user: CurrentUser):
    """Delete all clusters and their members."""
    count = request.app.state.store.delete_all_clusters(user_id=user["id"])
    return {"ok": True, "deleted": count}


@router.get("/{cluster_id}/skills", response_model=list[SkillResponse])
def get_cluster_skills(request: Request, cluster_id: str, user: CurrentUser):
    """Get all skills distilled from this cluster's sessions."""
    store = request.app.state.store
    cluster = store.get_cluster(cluster_id, user_id=user["id"])
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")
    members = store.get_cluster_members(cluster_id)
    member_sids = [m["session_id"] for m in members]
    return store.get_skills_for_sessions(member_sids)


@router.delete("/{cluster_id}/skills")
def delete_cluster_skills(request: Request, cluster_id: str, user: CurrentUser):
    """Delete all skills distilled from this cluster's sessions."""
    store = request.app.state.store
    cluster = store.get_cluster(cluster_id, user_id=user["id"])
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    members = store.get_cluster_members(cluster_id)
    member_sids = {m["session_id"] for m in members}

    # Find and delete skills whose source_session_ids overlap with this cluster
    all_skills = store.get_skills()
    deleted = 0
    for skill in all_skills:
        skill_sids = set(skill.get("source_session_ids") or [])
        if skill_sids & member_sids:
            store.delete_skill(skill["id"])
            deleted += 1

    logger.info(f"Deleted {deleted} skills for cluster {cluster_id}")
    return {"ok": True, "deleted": deleted}


@router.post("/{cluster_id}/distill", response_model=BackgroundJobResponse)
async def distill_cluster(request: Request, cluster_id: str, user: CurrentUser):
    """Distill skills from a cluster's sessions (token-capped, async)."""
    store = request.app.state.store
    span_client = getattr(request.app.state, "postgres_spans", None)
    if span_client is None:
        raise HTTPException(status_code=503, detail="PostgreSQL span store not configured")

    cluster = store.get_cluster(cluster_id, user_id=user["id"])
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    members = store.get_cluster_members(cluster_id)
    if not members:
        raise HTTPException(status_code=400, detail="Cluster has no members")

    # Token-capped session selection
    session_ids = [m["session_id"] for m in members]
    summaries = span_client.get_session_summaries(session_ids)

    # Estimate tokens: ~150 tokens per span in narrative. Budget: 150K tokens (~120K chars)
    MAX_ESTIMATED_TOKENS = 150_000
    TOKENS_PER_SPAN = 150

    # Sort by eval diversity: interleave success/fail for contrastive learning
    eval_rows = {}
    try:
        all_uploads = store.get_eval_uploads(user_id=user["id"])
        for u in all_uploads:
            rows = store.get_eval_upload_rows(u["upload_id"], user_id=user["id"])
            if rows:
                for r in rows:
                    if r["session_id"] in summaries:
                        eval_rows[r["session_id"]] = r
    except Exception:
        pass

    # Partition into success/fail, interleave
    success_ids = [sid for sid in session_ids if eval_rows.get(sid, {}).get("task_success") is True]
    fail_ids = [sid for sid in session_ids if eval_rows.get(sid, {}).get("task_success") is False]
    other_ids = [sid for sid in session_ids if sid not in success_ids and sid not in fail_ids]

    interleaved: list[str] = []
    si, fi, oi = 0, 0, 0
    while si < len(success_ids) or fi < len(fail_ids) or oi < len(other_ids):
        if si < len(success_ids):
            interleaved.append(success_ids[si]); si += 1
        if fi < len(fail_ids):
            interleaved.append(fail_ids[fi]); fi += 1
        if oi < len(other_ids):
            interleaved.append(other_ids[oi]); oi += 1

    # Select sessions until token budget is reached
    selected: list[str] = []
    estimated_tokens = 0
    for sid in interleaved:
        span_count = summaries.get(sid, {}).get("span_count", 0)
        est = span_count * TOKENS_PER_SPAN
        if estimated_tokens + est > MAX_ESTIMATED_TOKENS and selected:
            break
        selected.append(sid)
        estimated_tokens += est

    logger.info(
        f"Distilling cluster {cluster_id}: {len(selected)}/{len(session_ids)} sessions, "
        f"~{estimated_tokens} estimated tokens"
    )

    from distiller import SkillDistiller

    distiller = SkillDistiller(clickhouse=span_client, datastore=store)

    async def run_distill(job_id: str) -> dict:
        created_ids = await distiller.run(selected, job_id=job_id)
        return {"skills_created": len(created_ids), "sessions_used": len(selected), "skill_ids": created_ids}

    job_manager = request.app.state.job_manager
    job = await job_manager.submit("distillation", run_distill, user_id=user["id"])
    return job
