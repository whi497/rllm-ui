"""Skills router — CRUD + distillation trigger + markdown export."""

import logging
import re

from auth import CurrentUser
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from models import DistillRequest, SkillResponse, SkillUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/skills", tags=["skills"])


# ── CRUD ────────────────────────────────────────────────────────────


@router.get("", response_model=list[SkillResponse])
def list_skills(
    request: Request,
    user: CurrentUser,
    is_active: bool | None = Query(None),
    category: str | None = Query(None),
    session_id: str | None = Query(None),
):
    store = request.app.state.store
    if session_id:
        return store.get_skills_for_session(session_id, user_id=user["id"])
    return store.get_skills(is_active=is_active, category=category, user_id=user["id"])


@router.get("/{skill_id}", response_model=SkillResponse)
def get_skill(request: Request, skill_id: str, user: CurrentUser):
    store = request.app.state.store
    skill = store.get_skill(skill_id, user_id=user["id"])
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return skill


@router.patch("/{skill_id}", response_model=SkillResponse)
def update_skill(request: Request, skill_id: str, body: SkillUpdate, user: CurrentUser):
    store = request.app.state.store
    result = store.update_skill(skill_id, body.model_dump(exclude_unset=True), user_id=user["id"])
    if result is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return result


@router.delete("", status_code=200)
def delete_all_skills(request: Request, user: CurrentUser):
    """Delete ALL skills. For local testing only."""
    store = request.app.state.store
    count = store.delete_all_skills(user_id=user["id"])
    return {"ok": True, "deleted": count}


@router.delete("/{skill_id}")
def delete_skill(request: Request, skill_id: str, user: CurrentUser):
    store = request.app.state.store
    deleted = store.delete_skill(skill_id, user_id=user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"ok": True}


# ── Export as .md ───────────────────────────────────────────────────


def _format_skill_md(skill: dict) -> str:
    """Render a skill as a markdown file with YAML frontmatter."""
    tags_str = ", ".join(skill.get("tags") or [])
    sources_str = ", ".join(skill.get("source_session_ids") or [])
    lines = [
        "---",
        f'title: "{skill["title"]}"',
        f'category: {skill.get("category", "general")}',
        f'confidence: {skill.get("confidence", 0.0)}',
        f'success_rate: "{skill.get("success_rate", "")}"',
        f'evidence_count: {skill.get("evidence_count", 0)}',
        f"tags: [{tags_str}]",
        f"source_sessions: [{sources_str}]",
        "---",
        "",
        skill.get("description", ""),
    ]
    return "\n".join(lines)


@router.get("/{skill_id}/export")
def export_skill(request: Request, skill_id: str, user: CurrentUser):
    store = request.app.state.store
    skill = store.get_skill(skill_id, user_id=user["id"])
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    md = _format_skill_md(skill)
    safe_title = re.sub(r"[^a-zA-Z0-9_-]", "-", skill["title"].lower()).strip("-")
    filename = f"{safe_title}.md" if safe_title else "skill.md"
    return Response(
        content=md,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Distillation trigger ───────────────────────────────────────────


@router.post("/distill", response_model=list[SkillResponse])
async def trigger_distillation(
    request: Request,
    user: CurrentUser,
    body: DistillRequest | None = None,
):
    """Trigger skill distillation from agent session spans.

    Runs synchronously — waits for LLM extraction to complete and returns the new skills.
    Body is optional — if no session_ids provided, distills from all available sessions.
    Body.source selects the data source: 'clickhouse' (default), 'bigquery', or 'postgres'.
    """
    source = (body.source if body else "clickhouse") or "clickhouse"

    # Resolve span client based on source
    if source == "postgres":
        span_client = getattr(request.app.state, "postgres_spans", None)
        if span_client is None:
            raise HTTPException(status_code=503, detail="PostgreSQL span store not configured")
    elif source == "bigquery":
        span_client = getattr(request.app.state, "bigquery", None)
        if span_client is None:
            raise HTTPException(status_code=503, detail="BigQuery not configured")
    else:
        span_client = getattr(request.app.state, "clickhouse", None)
        if span_client is None:
            raise HTTPException(status_code=503, detail="ClickHouse not configured — required for distillation")

    if getattr(request.app.state, "_distill_running", False):
        raise HTTPException(status_code=409, detail="A distillation is already running")

    # Resolve session IDs: from body or fetch all from the data source
    session_ids: list[str] = []
    if body and body.session_ids:
        session_ids = body.session_ids
        logger.info(f"Distillation requested for {len(session_ids)} specific sessions (source={source}): {session_ids}")
    else:
        logger.info(f"No session_ids in request body — fetching all sessions from {source}")
        try:
            sessions = span_client.get_agent_sessions(user_id=user["id"])
            session_ids = [s["id"] for s in sessions]
            logger.info(f"Found {len(session_ids)} sessions in {source}")
        except Exception:
            logger.exception(f"Failed to fetch agent sessions from {source}")

    if not session_ids:
        raise HTTPException(status_code=404, detail="No agent sessions found to distill from")

    store = request.app.state.store
    request.app.state._distill_running = True

    try:
        from distiller import SkillDistiller

        distiller = SkillDistiller(clickhouse=span_client, datastore=store)
        created_ids = await distiller.run(session_ids)
        logger.info(f"Distillation completed: {len(created_ids)} skills created")

        # Return the newly created skills
        return [store.get_skill(sid, user_id=user["id"]) for sid in created_ids if store.get_skill(sid, user_id=user["id"])]
    except Exception:
        logger.exception("Distillation failed")
        raise HTTPException(status_code=500, detail="Distillation failed — check server logs")
    finally:
        request.app.state._distill_running = False
