"""Core skill distillation pipeline — SkillRL-inspired two-level contrastive
extraction with per-session compression and cross-session pattern mining.

Level 1 (Haiku): Each session's full trajectory is individually compressed
into a structured digest (~10-20x compression).

Level 2 (Sonnet): All digests are analyzed together, contrastively, to
extract cross-session skills grounded in eval signals.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)

# Budget for per-session digest batching (Haiku)
DIGEST_BATCH_TOKEN_BUDGET = 30_000
DIGEST_CHARS_PER_TOKEN = 3
DIGEST_BATCH_CHAR_BUDGET = DIGEST_BATCH_TOKEN_BUDGET * DIGEST_CHARS_PER_TOKEN


class SkillDistiller:
    """Two-level skill extraction:
    1. Per-session: compress full trajectory → structured digest (Haiku)
    2. Cross-session: contrastive pattern mining on digests (Sonnet)
    """

    def __init__(self, clickhouse: Any, datastore: Any) -> None:
        self.clickhouse = clickhouse
        self.datastore = datastore

    async def run(self, session_ids: list[str], job_id: str | None = None) -> list[str]:
        """Run the full two-level distillation pipeline."""
        from distiller.extractors import (
            REFINEMENT_PROMPT,
            SESSION_DIGEST_PROMPT,
            SKILL_EXTRACTION_PROMPT,
            preprocess_spans,
        )
        from distiller.models import SessionDigestResult, SkillExtractionResult

        pipeline_start = time.time()
        logger.info("=" * 60)
        logger.info("SKILL DISTILLATION PIPELINE (two-level, contrastive)")
        logger.info(f"  Sessions: {len(session_ids)}")
        logger.info("=" * 60)

        def _progress(stage: str, message: str, current: int | None = None, total: int | None = None) -> None:
            if job_id:
                try:
                    progress: dict[str, Any] = {"stage": stage, "message": message}
                    if current is not None:
                        progress["current"] = current
                    if total is not None:
                        progress["total"] = total
                    self.datastore.update_job_status(job_id, "running", progress=progress)
                except Exception:
                    pass

        # ── Stage 1: Load eval labels + partition ─────────────────────
        _progress("eval", "Loading evaluation labels...")
        eval_map = self._load_eval_map(session_ids)
        success_ids, fail_ids, unlabeled_ids = self._partition_sessions(session_ids, eval_map)
        logger.info(f"  Partition: {len(success_ids)} success, {len(fail_ids)} fail, {len(unlabeled_ids)} unlabeled")

        # ── Stage 2: Extract full narratives ──────────────────────────
        _progress("extracting", f"Extracting spans from {len(session_ids)} sessions...")
        stage2_start = time.time()

        narratives: dict[str, str] = {}  # session_id -> full narrative
        for sid in session_ids:
            narrative = self._extract_session_narrative(sid, eval_map.get(sid), preprocess_spans)
            if narrative:
                narratives[sid] = narrative

        logger.info(f"  Extracted {len(narratives)} narratives in {time.time() - stage2_start:.1f}s")
        if not narratives:
            logger.warning("  No span data — aborting")
            return []

        # ── Stage 3: Level 1 — per-session digests via Haiku ─────────
        _progress("digesting", "Compressing sessions via Haiku...")
        stage3_start = time.time()

        digests: dict[str, dict[str, Any]] = {}  # session_id -> digest dict
        batches = self._build_digest_batches(narratives, SESSION_DIGEST_PROMPT)
        logger.info(f"  Digest batches: {len(batches)} (from {len(narratives)} sessions)")

        total_sessions = len(narratives)
        digested_count = 0

        for batch_idx, batch_sids in enumerate(batches):
            _progress(
                "digesting",
                f"Digesting sessions {digested_count + 1}-{min(digested_count + len(batch_sids), total_sessions)}/{total_sessions}...",
                current=digested_count, total=total_sessions,
            )
            batch_digests = await self._digest_batch(
                batch_sids, narratives, eval_map, SESSION_DIGEST_PROMPT, SessionDigestResult
            )
            digests.update(batch_digests)
            digested_count += len(batch_sids)
            logger.info(f"  Batch {batch_idx + 1}/{len(batches)}: digested {len(batch_digests)} sessions")

        logger.info(f"  Total digests: {len(digests)} in {time.time() - stage3_start:.1f}s")

        if not digests:
            logger.warning("  No digests produced — aborting")
            return []

        # ── Stage 4: Level 2 — cross-session contrastive extraction ───
        _progress("extracting_skills", "Extracting skills via Sonnet (contrastive)...", current=total_sessions, total=total_sessions)
        stage4_start = time.time()

        contrastive_text = self._build_contrastive_digest_text(
            digests, success_ids, fail_ids, unlabeled_ids, eval_map
        )
        logger.info(f"  Contrastive text: {len(contrastive_text)} chars (~{len(contrastive_text) // 3} tokens)")

        skills_result = await self._call_llm(
            contrastive_text, SKILL_EXTRACTION_PROMPT, SkillExtractionResult,
            model="claude-sonnet-4-20250514", max_tokens=8192,
        )

        logger.info(f"  Stage 4 completed in {time.time() - stage4_start:.1f}s")

        if not skills_result or not skills_result.skills:
            logger.warning("  No skills extracted — aborting")
            return []

        logger.info(f"  Extracted {len(skills_result.skills)} skills (initial)")
        for i, sk in enumerate(skills_result.skills):
            logger.info(f"    [{i+1}] \"{sk.title}\" (Δ={sk.reward_delta:+.2f}, conf={sk.confidence})")

        # ── Stage 5: Refinement (holdout validation) ──────────────────
        all_labeled = success_ids + fail_ids
        if len(all_labeled) >= 10:
            _progress("refining", "Validating and refining skills...")
            stage5_start = time.time()

            holdout_size = max(2, len(all_labeled) // 5)
            holdout = (success_ids[-holdout_size // 2:] + fail_ids[-holdout_size // 2:])

            gap_digests = [self._format_digest(digests[sid], eval_map.get(sid))
                          for sid in holdout if sid in digests]

            if gap_digests:
                logger.info(f"  Running refinement on {len(gap_digests)} holdout digests")
                refined = await self._run_refinement(
                    skills_result, gap_digests, REFINEMENT_PROMPT, SkillExtractionResult
                )
                if refined and refined.skills:
                    logger.info(f"  Refined: {len(refined.skills)} skills (was {len(skills_result.skills)})")
                    skills_result = refined

            logger.info(f"  Stage 5 completed in {time.time() - stage5_start:.1f}s")

        # ── Stage 6: Persist ──────────────────────────────────────────
        _progress("persisting", "Saving skills...")
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
                logger.info(f"  [{i+1}] Created: \"{skill.title}\"")
            except Exception:
                logger.exception(f"  [{i+1}] FAILED to persist: \"{skill.title}\"")

        elapsed = time.time() - pipeline_start
        logger.info("=" * 60)
        logger.info(f"DISTILLATION COMPLETE: {len(created_ids)} skills in {elapsed:.1f}s")
        logger.info("=" * 60)
        return created_ids

    # ══════════════════════════════════════════════════════════════════
    # Helpers
    # ══════════════════════════════════════════════════════════════════

    def _load_eval_map(self, session_ids: list[str]) -> dict[str, dict[str, Any]]:
        eval_map: dict[str, dict[str, Any]] = {}
        try:
            for u in self.datastore.get_eval_uploads():
                rows = self.datastore.get_eval_upload_rows(u["upload_id"])
                if rows:
                    for r in rows:
                        sid = r.get("session_id", "")
                        if sid in session_ids or not session_ids:
                            eval_map[sid] = r
        except Exception:
            logger.debug("Could not load eval data", exc_info=True)
        return eval_map

    @staticmethod
    def _partition_sessions(
        session_ids: list[str], eval_map: dict[str, dict[str, Any]]
    ) -> tuple[list[str], list[str], list[str]]:
        success, fail, unlabeled = [], [], []
        for sid in session_ids:
            ev = eval_map.get(sid)
            if ev is None:
                unlabeled.append(sid)
            elif ev.get("task_success") is True or str(ev.get("rating", "")).lower() in (
                "good", "excellent", "correct", "pass"
            ):
                success.append(sid)
            elif ev.get("task_success") is False or str(ev.get("rating", "")).lower() in (
                "bad", "poor", "incorrect", "fail", "failed"
            ):
                fail.append(sid)
            else:
                unlabeled.append(sid)
        return success, fail, unlabeled

    def _extract_session_narrative(
        self, session_id: str, eval_data: dict[str, Any] | None, preprocess_fn: Any
    ) -> str | None:
        try:
            trajectories = self.clickhouse.get_trajectories(session_id)
            spans = self.clickhouse.get_spans(session_id)
            if not trajectories and not spans:
                return None
            return preprocess_fn(trajectories, spans, session_id, eval_data=eval_data)
        except Exception:
            logger.debug(f"Failed to extract narrative for {session_id}", exc_info=True)
            return None

    # ── Level 1: Per-session digestion (Haiku) ────────────────────

    def _build_digest_batches(
        self, narratives: dict[str, str], prompt: str
    ) -> list[list[str]]:
        """Group sessions into batches that fit the Haiku token budget.

        Each batch contains session IDs whose narratives, combined, fit
        within the budget. Each session is sent individually to Haiku
        within the batch (sequential calls per batch item).
        Actually, we send one session at a time to preserve full context.
        Batching here just controls progress reporting granularity.
        """
        # Send each session individually — no narrative concatenation.
        # Group into reporting batches of ~10 for progress updates.
        sids = list(narratives.keys())
        batch_size = 10
        return [sids[i:i + batch_size] for i in range(0, len(sids), batch_size)]

    async def _digest_batch(
        self,
        session_ids: list[str],
        narratives: dict[str, str],
        eval_map: dict[str, dict[str, Any]],
        digest_prompt: str,
        result_model: type,
    ) -> dict[str, dict[str, Any]]:
        """Digest each session individually via Haiku. Returns {session_id: digest_dict}."""
        results: dict[str, dict[str, Any]] = {}
        for sid in session_ids:
            narrative = narratives.get(sid, "")
            if not narrative:
                continue
            digest = await self._digest_single_session(sid, narrative, digest_prompt, result_model)
            if digest:
                results[sid] = digest
        return results

    async def _digest_single_session(
        self, session_id: str, narrative: str, prompt: str, result_model: type
    ) -> dict[str, Any] | None:
        """Compress one session's full narrative into a structured digest via Haiku."""
        # Truncate very long narratives for Haiku (200K context but keep cost low)
        max_chars = 100_000
        if len(narrative) > max_chars:
            narrative = narrative[:max_chars] + f"\n\n[... truncated at {max_chars} chars ...]"

        content = prompt + narrative
        result = await self._call_llm(
            "", content, result_model,
            model="claude-haiku-4-5-20251001", max_tokens=2048,
            tool_name="report_digest",
            tool_description="Report the structured digest for this agent session.",
        )
        if result and hasattr(result, "digest"):
            d = result.digest.model_dump()
            d["session_id"] = session_id  # Ensure correct ID
            return d
        return None

    # ── Level 2: Cross-session contrastive text ───────────────────

    def _build_contrastive_digest_text(
        self,
        digests: dict[str, dict[str, Any]],
        success_ids: list[str],
        fail_ids: list[str],
        unlabeled_ids: list[str],
        eval_map: dict[str, dict[str, Any]],
    ) -> str:
        """Build contrastive text from compressed digests (not raw narratives)."""
        parts: list[str] = []

        # Success + unlabeled
        success_digests = [digests[sid] for sid in success_ids + unlabeled_ids if sid in digests]
        fail_digests = [digests[sid] for sid in fail_ids if sid in digests]

        if success_digests:
            parts.append("=" * 60)
            parts.append(f"SUCCESSFUL SESSIONS ({len(success_digests)} digests)")
            parts.append("=" * 60)
            parts.append("")
            for d in success_digests:
                parts.append(self._format_digest(d, eval_map.get(d.get("session_id", ""))))
                parts.append("---")
            parts.append("")

        if fail_digests:
            parts.append("=" * 60)
            parts.append(f"FAILED SESSIONS ({len(fail_digests)} digests)")
            parts.append("=" * 60)
            parts.append("")
            for d in fail_digests:
                parts.append(self._format_digest(d, eval_map.get(d.get("session_id", ""))))
                parts.append("---")

        return "\n".join(parts)

    @staticmethod
    def _format_digest(digest: dict[str, Any], eval_data: dict[str, Any] | None = None) -> str:
        """Format a single digest for inclusion in the contrastive document."""
        lines = [f"### Session: {digest.get('session_id', '?')} [{digest.get('outcome', '?')}]"]

        if eval_data:
            eval_parts = []
            for k in ("rating", "task_success", "trajectory_alignment", "tags"):
                v = eval_data.get(k)
                if v is not None and v != "":
                    eval_parts.append(f"{k}={v}")
            if eval_parts:
                lines.append(f"Eval: {', '.join(eval_parts)}")

        lines.append(f"Strategy: {digest.get('strategy_summary', '')}")

        kd = digest.get("key_decisions", [])
        if kd:
            lines.append("Key decisions:")
            for i, d in enumerate(kd[:5], 1):
                lines.append(f"  {i}. {d}")

        tools = digest.get("tools_used", [])
        if tools:
            lines.append(f"Tools: {' → '.join(tools)}")

        ww = digest.get("what_worked", "")
        if ww:
            lines.append(f"What worked: {ww}")

        wf = digest.get("what_failed", "")
        if wf:
            lines.append(f"What failed: {wf}")

        fp = digest.get("failure_point", "")
        if fp:
            lines.append(f"Failure point: {fp}")

        return "\n".join(lines)

    # ── Refinement ────────────────────────────────────────────────

    async def _run_refinement(
        self, initial_result: Any, gap_digest_texts: list[str],
        refinement_prompt_template: str, result_model: type,
    ) -> Any:
        skill_summaries = []
        for i, sk in enumerate(initial_result.skills):
            skill_summaries.append(
                f"### Skill {i+1}: {sk.title}\n"
                f"Category: {sk.category} | Confidence: {sk.confidence} | "
                f"Reward delta: {sk.reward_delta:+.2f}\n"
                f"{sk.description[:1500]}"
            )

        prompt = refinement_prompt_template.format(
            existing_skills="\n\n".join(skill_summaries),
            gap_sessions="\n\n---\n\n".join(gap_digest_texts[:10]),
        )

        return await self._call_llm(
            "", prompt, result_model,
            model="claude-sonnet-4-20250514", max_tokens=8192,
        )

    # ── Generic LLM caller ────────────────────────────────────────

    async def _call_llm(
        self,
        traces_text: str,
        prompt: str,
        result_model: type,
        model: str = "claude-sonnet-4-20250514",
        max_tokens: int = 8192,
        tool_name: str = "report_skills",
        tool_description: str = "Report the extracted skills and summary.",
    ):
        import anthropic

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            logger.error("ANTHROPIC_API_KEY not set")
            return None

        client = anthropic.AsyncAnthropic(api_key=api_key)

        content = prompt + "\n\n" + traces_text if traces_text else prompt
        if len(content) > 600_000:
            content = content[:600_000] + "\n\n[... truncated ...]"

        logger.info(f"  LLM call: model={model}, ~{len(content)} chars input")

        try:
            message = await client.messages.create(
                model=model,
                max_tokens=max_tokens,
                messages=[{"role": "user", "content": content}],
                tools=[
                    {
                        "name": tool_name,
                        "description": tool_description,
                        "input_schema": result_model.model_json_schema(),
                    }
                ],
                tool_choice={"type": "tool", "name": tool_name},
            )

            logger.info(f"  Response: {message.usage.input_tokens}in/{message.usage.output_tokens}out, stop={message.stop_reason}")

            for block in message.content:
                if block.type == "tool_use" and block.name == tool_name:
                    return result_model.model_validate(block.input)

            logger.warning(f"  No {tool_name} block found")
            return None

        except Exception:
            logger.exception(f"  LLM call failed ({model})")
            return None
