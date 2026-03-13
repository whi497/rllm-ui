"""Pydantic schemas for LLM structured output during skill extraction."""

from pydantic import BaseModel


class ExtractedSkill(BaseModel):
    title: str
    description: str  # Full markdown with Pattern / Key Sequence / Anti-pattern / Source Evidence
    category: str  # tool-strategy, error-recovery, prompt-technique, task-decomposition, verification-pattern, resource-optimization
    confidence: float  # 0.0-1.0
    reward_delta: float  # e.g. 0.57 means +57% reward improvement vs baseline
    success_rate: str  # e.g. "91% when applied vs 34% baseline"
    evidence_count: int  # Number of trajectories supporting this pattern
    source_sessions: list[str]  # Session IDs
    tags: list[str]


class SkillExtractionResult(BaseModel):
    skills: list[ExtractedSkill]
    summary: str  # High-level summary of what was found
