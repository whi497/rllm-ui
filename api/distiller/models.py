"""Pydantic schemas for LLM structured output during skill extraction."""

from pydantic import BaseModel


# ── Per-session digest (Haiku, level 1) ───────────────────────────

class SessionDigest(BaseModel):
    """Compressed summary of a single session, produced by Haiku from full trajectory."""
    session_id: str
    outcome: str  # "success", "failure", or "unclear"
    strategy_summary: str  # 2-3 sentence description of what the agent did
    key_decisions: list[str]  # Critical decision points (max 5)
    tools_used: list[str]  # Tool names in order of usage
    failure_point: str  # Empty if successful; otherwise describes where/why it failed
    what_worked: str  # What the agent did well
    what_failed: str  # What the agent did poorly or missed


class SessionDigestResult(BaseModel):
    digest: SessionDigest


# ── Cross-session skill extraction (Sonnet, level 2) ──────────────

class ExtractedSkill(BaseModel):
    title: str
    description: str  # Markdown: ## Pattern / ## Key Sequence / ## Anti-pattern / ## Failure Lesson / ## Source Evidence
    category: str  # tool-strategy, error-recovery, prompt-technique, task-decomposition, verification-pattern, resource-optimization
    confidence: float  # 0.0-1.0
    reward_delta: float  # e.g. 0.57 means +57% reward improvement vs baseline
    success_rate: str  # e.g. "91% when applied vs 34% baseline"
    evidence_count: int  # Number of sessions supporting this pattern
    source_sessions: list[str]  # Session IDs
    tags: list[str]


class SkillExtractionResult(BaseModel):
    skills: list[ExtractedSkill]
    summary: str  # High-level summary of what was found
