"""Pydantic models for LLM-based session clustering structured output."""

from __future__ import annotations

from pydantic import BaseModel


class SessionLabel(BaseModel):
    session_id: str
    task_type: str
    problem_category: str
    tools_strategy: str
    complexity: str  # low, medium, high
    one_line_summary: str


class BatchLabelResult(BaseModel):
    labels: list[SessionLabel]
