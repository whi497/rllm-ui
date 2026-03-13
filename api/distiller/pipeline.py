"""Core skill distillation pipeline — extracts skills from agent spans via LLM structured output."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)


class SkillDistiller:
    """Extracts reusable skills from agent execution spans using LLM structured output."""

    def __init__(self, clickhouse: Any, datastore: Any) -> None:
        self.clickhouse = clickhouse
        self.datastore = datastore

    async def run(self, session_ids: list[str]) -> list[str]:
        """Run the full distillation pipeline.

        1. Extract spans from ClickHouse
        2. Preprocess into narrative text
        3. Extract skills via LLM structured output (Anthropic tool_use)
        4. Persist to datastore

        Returns list of created skill IDs.
        """
        from distiller.extractors import SKILL_EXTRACTION_PROMPT, preprocess_spans
        from distiller.models import SkillExtractionResult

        pipeline_start = time.time()
        logger.info("=" * 60)
        logger.info("SKILL DISTILLATION PIPELINE STARTED")
        logger.info(f"  Sessions to process: {len(session_ids)}")
        for i, sid in enumerate(session_ids):
            logger.info(f"    [{i+1}] {sid}")
        logger.info("=" * 60)

        # ── Stage 1: Extract spans from ClickHouse ──────────────────
        stage1_start = time.time()
        logger.info("")
        logger.info("STAGE 1: Extracting spans from ClickHouse")
        logger.info("-" * 40)

        all_narratives: list[str] = []
        total_trajectories = 0
        total_spans = 0

        for sid in session_ids:
            try:
                logger.info(f"  Querying session {sid}...")
                trajectories = self.clickhouse.get_trajectories(sid)
                spans = self.clickhouse.get_spans(sid)
                total_trajectories += len(trajectories)
                total_spans += len(spans)

                logger.info(f"    Trajectory spans: {len(trajectories)}")
                logger.info(f"    Observability spans: {len(spans)}")

                # Log span type breakdown
                span_types: dict[str, int] = {}
                for s in spans:
                    st = s.get("span_type", "unknown")
                    span_types[st] = span_types.get(st, 0) + 1
                for st, count in sorted(span_types.items()):
                    logger.info(f"      {st}: {count}")

                narrative = preprocess_spans(trajectories, spans, sid)
                all_narratives.append(narrative)
                logger.info(f"    Narrative length: {len(narrative)} chars")
            except Exception:
                logger.exception(f"  FAILED to extract spans for session {sid}")

        stage1_elapsed = time.time() - stage1_start
        logger.info("")
        logger.info(f"  Stage 1 complete in {stage1_elapsed:.1f}s")
        logger.info(f"  Total trajectory spans: {total_trajectories}")
        logger.info(f"  Total observability spans: {total_spans}")
        logger.info(f"  Narratives generated: {len(all_narratives)}")

        if not all_narratives:
            logger.warning("  No span data found — aborting distillation")
            return []

        combined_text = "\n\n".join(all_narratives)
        logger.info(f"  Combined narrative: {len(combined_text)} chars")

        # ── Stage 2: LLM skill extraction ───────────────────────────
        stage2_start = time.time()
        logger.info("")
        logger.info("STAGE 2: Extracting skills via LLM (Claude Sonnet)")
        logger.info("-" * 40)
        logger.info(f"  Prompt length: {len(SKILL_EXTRACTION_PROMPT)} chars")
        logger.info(f"  Traces length: {len(combined_text)} chars")

        if len(combined_text) > 180_000:
            logger.info(f"  Truncating traces from {len(combined_text)} to 180,000 chars")

        logger.info("  Calling Anthropic API with tool_use (report_skills)...")

        skills_result = await self._extract_skills_llm(
            combined_text, session_ids, SKILL_EXTRACTION_PROMPT, SkillExtractionResult
        )

        stage2_elapsed = time.time() - stage2_start
        logger.info(f"  LLM call completed in {stage2_elapsed:.1f}s")

        if not skills_result:
            logger.warning("  LLM returned no result — aborting")
            return []

        if not skills_result.skills:
            logger.warning("  LLM returned empty skills list — aborting")
            logger.info(f"  Summary: {skills_result.summary}")
            return []

        logger.info(f"  Extracted {len(skills_result.skills)} skills:")
        for i, skill in enumerate(skills_result.skills):
            logger.info(f"    [{i+1}] \"{skill.title}\" (category={skill.category}, confidence={skill.confidence})")
            logger.info(f"         reward_delta={skill.reward_delta:+.2f}, success_rate={skill.success_rate}, evidence={skill.evidence_count} trajectories")
            logger.info(f"         tags={skill.tags}")
        logger.info(f"  Summary: {skills_result.summary[:300]}")

        # ── Stage 3: Persist to datastore ───────────────────────────
        stage3_start = time.time()
        logger.info("")
        logger.info("STAGE 3: Persisting skills to datastore")
        logger.info("-" * 40)

        created_ids: list[str] = []

        for i, skill in enumerate(skills_result.skills):
            try:
                record = self.datastore.create_skill({
                    "title": skill.title,
                    "description": skill.description,
                    "category": skill.category,
                    "confidence": skill.confidence,
                    "reward_delta": skill.reward_delta,
                    "success_rate": skill.success_rate,
                    "evidence_count": skill.evidence_count,
                    "source_session_ids": skill.source_sessions or session_ids,
                    "tags": skill.tags,
                    "metadata": {"summary": skills_result.summary},
                })
                created_ids.append(record["id"])
                logger.info(f"  [{i+1}] Created: \"{skill.title}\" -> id={record['id']}")
            except Exception:
                logger.exception(f"  [{i+1}] FAILED to persist: \"{skill.title}\"")

        stage3_elapsed = time.time() - stage3_start
        total_elapsed = time.time() - pipeline_start

        logger.info("")
        logger.info("=" * 60)
        logger.info("DISTILLATION COMPLETE")
        logger.info(f"  Skills created: {len(created_ids)}")
        logger.info(f"  Stage 1 (ClickHouse extraction): {stage1_elapsed:.1f}s")
        logger.info(f"  Stage 2 (LLM extraction):        {stage2_elapsed:.1f}s")
        logger.info(f"  Stage 3 (Persistence):            {stage3_elapsed:.1f}s")
        logger.info(f"  Total pipeline time:              {total_elapsed:.1f}s")
        logger.info("=" * 60)

        return created_ids

    async def _extract_skills_llm(
        self,
        traces_text: str,
        session_ids: list[str],
        prompt: str,
        result_model: type,
    ):
        """Use Anthropic API directly for structured skill extraction."""
        import anthropic

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            logger.error("ANTHROPIC_API_KEY not set — cannot extract skills")
            return None

        client = anthropic.AsyncAnthropic(api_key=api_key)

        # Truncate traces if too long (leave room for prompt + output)
        max_chars = 180_000
        if len(traces_text) > max_chars:
            traces_text = traces_text[:max_chars] + "\n\n[... truncated ...]"

        total_input_chars = len(prompt) + len(traces_text)
        logger.info(f"  Total input to LLM: ~{total_input_chars} chars")

        try:
            message = await client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=8192,
                messages=[
                    {
                        "role": "user",
                        "content": prompt + "\n\n" + traces_text,
                    }
                ],
                tools=[
                    {
                        "name": "report_skills",
                        "description": "Report the extracted skills and summary from the agent traces analysis.",
                        "input_schema": result_model.model_json_schema(),
                    }
                ],
                tool_choice={"type": "tool", "name": "report_skills"},
            )

            logger.info(f"  API response: model={message.model}, stop_reason={message.stop_reason}")
            logger.info(f"  Usage: input_tokens={message.usage.input_tokens}, output_tokens={message.usage.output_tokens}")

            # Extract tool use result
            for block in message.content:
                if block.type == "tool_use" and block.name == "report_skills":
                    logger.info("  Successfully parsed report_skills tool_use block")
                    return result_model.model_validate(block.input)

            logger.warning(f"  No report_skills tool_use block found. Content blocks: {[b.type for b in message.content]}")
            return None

        except anthropic.APIError as e:
            logger.error(f"  Anthropic API error: {e.status_code} {e.message}")
            return None
        except Exception:
            logger.exception("  LLM skill extraction failed with unexpected error")
            return None
