"""LLM-based session clustering pipeline.

Reads session metadata + tool names + eval labels, sends batches to Haiku
for structured labeling, then groups sessions by task_type into clusters.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)

# Keep batches moderate for label consistency and resilience.
# ~3 chars per token (conservative — structured/technical text tokenizes denser).
BATCH_TOKEN_BUDGET = 15_000
CHARS_PER_TOKEN = 3
BATCH_CHAR_BUDGET = BATCH_TOKEN_BUDGET * CHARS_PER_TOKEN  # ~45K chars

LABELING_PROMPT_BASE = """You are classifying AI agent troubleshooting sessions. Each session represents an agent working on a technical support case.

For each session below, produce a structured label with:
- **task_type**: A short, specific category describing the type of problem (e.g., "VPN Connectivity", "Application Path Policy", "DNS Resolution", "HA Failover", "Bandwidth Optimization"). Be consistent — sessions solving similar problems should get the SAME task_type string.
- **problem_category**: A broader grouping (e.g., "connectivity", "routing", "security", "configuration", "performance")
- **tools_strategy**: How the agent approached the problem based on tools used (e.g., "site-inspect-then-debug", "policy-review-and-trace", "flow-analysis")
- **complexity**: "low", "medium", or "high" based on the number of tools, steps, and problem description
- **one_line_summary**: A single sentence describing what this session is about

IMPORTANT: Use consistent task_type values across sessions. Sessions about the same kind of problem MUST share the same task_type.
"""

TAXONOMY_INSTRUCTION = """
The following task_type categories have ALREADY been assigned to earlier sessions. You MUST reuse these exact strings when a session fits one of them. Only create a new task_type if the session genuinely does not fit any existing category.

Existing categories:
{categories}
"""


def _build_labeling_prompt(existing_task_types: list[str]) -> str:
    """Build the labeling prompt, injecting the running taxonomy if any."""
    prompt = LABELING_PROMPT_BASE
    if existing_task_types:
        bullet_list = "\n".join(f"- {tt}" for tt in sorted(set(existing_task_types)))
        prompt += TAXONOMY_INSTRUCTION.format(categories=bullet_list)
    prompt += "\nHere are the sessions to classify:\n\n"
    return prompt


class SessionClusterer:
    """Clusters sessions by LLM-assigned task_type labels."""

    def __init__(self, span_client: Any, store: Any, user_id: str | None = None) -> None:
        self.span_client = span_client
        self.store = store
        self.user_id = user_id

    async def run(self, job_id: str) -> dict[str, Any]:
        """Full clustering pipeline. Called by JobManager with the job_id for progress reporting."""
        pipeline_start = time.time()
        logger.info("=" * 60)
        logger.info("SESSION CLUSTERING PIPELINE STARTED")
        logger.info("=" * 60)

        # Stage 1: Gather session data
        self.store.update_job_status(job_id, "running", progress={"stage": "gathering", "message": "Fetching sessions..."})
        total = self.span_client.count_agent_sessions()
        sessions = self.span_client.get_agent_sessions(limit=total or 10000)
        session_ids = [s["id"] for s in sessions]
        logger.info(f"Found {len(session_ids)} sessions (total={total})")

        if not session_ids:
            return {"clusters_created": 0, "sessions_labeled": 0}

        # Fetch supporting data
        session_start_data = self.span_client.get_session_start_data(session_ids)
        tool_names = self.span_client.get_session_tool_names(session_ids)
        summaries_map = self.span_client.get_session_summaries(session_ids)
        eval_map = self._get_eval_map(session_ids)

        # Stage 2: Build compact summaries
        self.store.update_job_status(job_id, "running", progress={"stage": "summarizing", "message": "Building session summaries..."})
        session_summaries: list[dict[str, Any]] = []
        for sid in session_ids:
            summary = self._build_summary(sid, session_start_data.get(sid, {}), tool_names.get(sid, []),
                                          summaries_map.get(sid, {}), eval_map.get(sid))
            session_summaries.append({"session_id": sid, "summary_text": summary})

        logger.info(f"Built {len(session_summaries)} session summaries")

        # Stage 3: LLM labeling + progressive cluster creation
        batches = self._build_batches(session_summaries)
        summary_lookup = {s["session_id"]: s["summary_text"] for s in session_summaries}

        # Delete existing clusters for clean re-clustering
        self.store.delete_all_clusters(user_id=self.user_id)

        # Track cluster_id by task_type so batches progressively grow clusters
        cluster_map: dict[str, str] = {}  # task_type -> cluster_id
        taxonomy: list[str] = []  # running list of task_type values for prompt anchoring
        total_labeled = 0

        for batch_idx, batch in enumerate(batches):
            batch_chars = sum(len(s["summary_text"]) for s in batch)
            self.store.update_job_status(
                job_id, "running",
                progress={"stage": "labeling", "current": batch_idx + 1, "total": len(batches),
                          "message": f"Labeling batch {batch_idx + 1}/{len(batches)} ({len(batch)} sessions, ~{batch_chars // CHARS_PER_TOKEN}tok)..."},
            )
            labels = await self._label_batch(batch, taxonomy)
            total_labeled += len(labels)
            logger.info(f"Batch {batch_idx + 1}/{len(batches)}: labeled {len(labels)}/{len(batch)} sessions (~{batch_chars // CHARS_PER_TOKEN} tokens)")

            # Grow the running taxonomy with any new task_types from this batch
            for label in labels:
                tt = label.get("task_type", "unknown")
                if tt not in taxonomy:
                    taxonomy.append(tt)

            # Immediately assign labeled sessions to clusters
            for label in labels:
                task_type = label.get("task_type", "unknown")
                sid = label.get("session_id", "")

                if task_type not in cluster_map:
                    cluster = self.store.create_cluster({
                        "name": task_type,
                        "task_type": task_type,
                        "description": "",
                        "member_count": 0,
                        "metadata": {},
                        "job_id": job_id,
                    }, user_id=self.user_id)
                    cluster_map[task_type] = cluster["id"]

                self.store.add_cluster_member(
                    cluster_id=cluster_map[task_type],
                    session_id=sid,
                    labels={
                        "task_type": label.get("task_type", ""),
                        "problem_category": label.get("problem_category", ""),
                        "tools_strategy": label.get("tools_strategy", ""),
                        "complexity": label.get("complexity", ""),
                    },
                    summary=label.get("one_line_summary", summary_lookup.get(sid, "")[:200]),
                )

        # Final pass: update cluster metadata now that all members are assigned
        self.store.update_job_status(job_id, "running", progress={"stage": "finalizing", "message": "Computing cluster metadata..."})

        for task_type, cluster_id in cluster_map.items():
            members = self.store.get_cluster_members(cluster_id)
            meta: dict[str, Any] = {}

            all_tools_list: list[str] = []
            for m in members:
                all_tools_list.extend(tool_names.get(m["session_id"], []))
            tool_freq: dict[str, int] = {}
            for t in all_tools_list:
                tool_freq[t] = tool_freq.get(t, 0) + 1
            meta["common_tools"] = sorted(tool_freq, key=lambda x: -tool_freq[x])[:5]
            meta["problem_categories"] = list({
                m["labels"].get("problem_category", "") for m in members if m["labels"].get("problem_category")
            })

            success_count = sum(1 for m in members if eval_map.get(m["session_id"], {}).get("task_success") is True)
            fail_count = sum(1 for m in members if eval_map.get(m["session_id"], {}).get("task_success") is False)
            total_eval = success_count + fail_count
            if total_eval > 0:
                meta["success_rate"] = f"{success_count}/{total_eval} ({100 * success_count // total_eval}%)"

            self.store.update_cluster_metadata(cluster_id, meta, f"{len(members)} sessions")

        elapsed = time.time() - pipeline_start
        logger.info(f"Clustering complete: {len(cluster_map)} clusters, {total_labeled} sessions in {elapsed:.1f}s")
        return {"clusters_created": len(cluster_map), "sessions_labeled": total_labeled}

    @staticmethod
    def _build_batches(session_summaries: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
        """Split session summaries into batches that fit within the token budget."""
        prompt_chars = len(LABELING_PROMPT_BASE) + 500  # +500 for taxonomy overhead
        batches: list[list[dict[str, Any]]] = []
        current_batch: list[dict[str, Any]] = []
        current_chars = prompt_chars

        for item in session_summaries:
            item_chars = len(item["summary_text"]) + 2  # +2 for separating newlines
            if current_batch and current_chars + item_chars > BATCH_CHAR_BUDGET:
                batches.append(current_batch)
                current_batch = []
                current_chars = prompt_chars

            current_batch.append(item)
            current_chars += item_chars

        if current_batch:
            batches.append(current_batch)

        return batches

    def _build_summary(
        self,
        session_id: str,
        start_data: dict[str, Any],
        tools: list[str],
        stats: dict[str, Any],
        eval_row: dict[str, Any] | None,
    ) -> str:
        """Build a compact text summary of a session for LLM labeling."""
        parts: list[str] = [f"Session {session_id}:"]

        title = start_data.get("title", "")
        if title:
            parts.append(f'  Title: "{title[:200]}"')

        desc = start_data.get("description") or start_data.get("problem_statement") or ""
        if desc:
            parts.append(f"  Problem: {desc[:300]}")

        for field in ("sme_area", "technology", "priority", "product_problem_area"):
            val = start_data.get(field)
            if val:
                parts.append(f"  {field}: {val}")

        if tools:
            parts.append(f"  Tools: {', '.join(tools[:10])}")

        span_count = stats.get("span_count", 0)
        llm_calls = stats.get("llm_calls", 0)
        tool_calls = stats.get("tool_calls", 0)
        parts.append(f"  Stats: {span_count} spans, {llm_calls} LLM calls, {tool_calls} tool calls")

        if eval_row:
            rating = eval_row.get("rating", "")
            task_success = eval_row.get("task_success")
            tags = eval_row.get("tags", "")
            eval_parts = []
            if rating:
                eval_parts.append(f"rating={rating}")
            if task_success is not None:
                eval_parts.append(f"task_success={task_success}")
            if tags:
                eval_parts.append(f"tags={tags}")
            if eval_parts:
                parts.append(f"  Eval: {', '.join(eval_parts)}")

        return "\n".join(parts)

    def _get_eval_map(self, session_ids: list[str]) -> dict[str, dict[str, Any]]:
        """Load eval data keyed by session_id."""
        eval_map: dict[str, dict[str, Any]] = {}
        try:
            all_uploads = self.store.get_eval_uploads()
            for u in all_uploads:
                rows = self.store.get_eval_upload_rows(u["upload_id"])
                if rows:
                    for r in rows:
                        sid = r.get("session_id", "")
                        if sid in session_ids:
                            eval_map[sid] = r
        except Exception:
            logger.debug("Could not load eval data", exc_info=True)
        return eval_map

    async def _label_batch(self, batch: list[dict[str, Any]], taxonomy: list[str] | None = None) -> list[dict[str, Any]]:
        """Send a batch of session summaries to Haiku for labeling.

        ``taxonomy`` is the running list of task_type values from previous batches.
        It's injected into the prompt so the model reuses existing categories.
        """
        import anthropic

        from clustering.models import BatchLabelResult

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            logger.error("ANTHROPIC_API_KEY not set — cannot label sessions")
            return []

        client = anthropic.AsyncAnthropic(api_key=api_key)

        # Build input text with running taxonomy anchoring
        prompt = _build_labeling_prompt(taxonomy or [])
        summaries_text = "\n\n".join(item["summary_text"] for item in batch)
        input_text = prompt + summaries_text

        try:
            message = await client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=16384,
                messages=[{"role": "user", "content": input_text}],
                tools=[
                    {
                        "name": "report_labels",
                        "description": "Report the classification labels for each session.",
                        "input_schema": BatchLabelResult.model_json_schema(),
                    }
                ],
                tool_choice={"type": "tool", "name": "report_labels"},
            )

            logger.info(f"  Haiku response: tokens={message.usage.input_tokens}in/{message.usage.output_tokens}out, stop={message.stop_reason}")

            if message.stop_reason != "tool_use":
                logger.warning(f"  Unexpected stop_reason={message.stop_reason} (output may have been truncated)")

            for block in message.content:
                if block.type == "tool_use" and block.name == "report_labels":
                    data = block.input
                    if not data or not data.get("labels"):
                        logger.warning("  report_labels returned empty labels (output likely truncated)")
                        return []
                    result = BatchLabelResult.model_validate(data)
                    return [label.model_dump() for label in result.labels]

            logger.warning("No report_labels tool_use block in response")
            return []

        except anthropic.APIError as e:
            logger.error(f"Haiku API error: {e.status_code} {e.message}")
            return []
        except Exception:
            logger.exception("Labeling batch failed")
            return []
