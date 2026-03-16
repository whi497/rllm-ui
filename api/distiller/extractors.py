"""Span preprocessing and LLM skill extraction logic."""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# ── Span → narrative text ───────────────────────────────────────────


def preprocess_spans(
    trajectories: list[dict[str, Any]],
    spans: list[dict[str, Any]],
    session_id: str,
    eval_data: dict[str, Any] | None = None,
) -> str:
    """Convert raw ClickHouse trajectory + span rows into a rich narrative text
    suitable for LLM-based skill extraction.

    If trajectory spans exist, groups them by trajectory_uid with step-by-step detail.
    Otherwise, builds a chronological narrative from observability spans (agent, LLM,
    tool, invocation, event spans).

    ``eval_data`` is an optional dict with human evaluation labels (rating,
    task_success, trajectory_alignment, ground_truth, tags) that get prepended
    to the narrative so the LLM can use them for contrastive analysis.
    """
    # Group trajectories by uid
    traj_groups: dict[str, list[dict]] = {}
    for t in trajectories:
        uid = t.get("trajectory_uid", "")
        if uid:
            traj_groups.setdefault(uid, []).append(t)

    parts: list[str] = []
    parts.append(f"# Agent Session: {session_id}")

    # ── Inject eval labels ────────────────────────────────────────
    if eval_data:
        parts.append("")
        parts.append("## Human Evaluation Labels")
        rating = eval_data.get("rating", "")
        task_success = eval_data.get("task_success")
        traj_align = eval_data.get("trajectory_alignment", "")
        ground_truth = eval_data.get("ground_truth", "")
        tags = eval_data.get("tags", "")

        if rating:
            parts.append(f"- Rating: {rating}")
        if task_success is not None:
            parts.append(f"- Task Success: {task_success}")
        if traj_align:
            parts.append(f"- Trajectory Alignment: {traj_align}")
        if tags:
            parts.append(f"- Tags: {tags}")
        if ground_truth:
            gt_truncated = ground_truth[:500] + "..." if len(ground_truth) > 500 else ground_truth
            parts.append(f"- Ground Truth: {gt_truncated}")
        parts.append("")

    # ── Inject system prompt + tool schemas if available ───────────
    # (Future: session.start span may contain agent_system_prompt and tool_declarations)
    session_start_spans = [s for s in spans if s.get("span_type") == "session.start"]
    if session_start_spans:
        data = session_start_spans[0].get("data", {})
        system_prompt = data.get("agent_system_prompt", "")
        tool_declarations = data.get("tool_declarations", [])
        if system_prompt:
            parts.append("## Agent System Prompt")
            parts.append(_truncate(system_prompt, 2000))
            parts.append("")
        if tool_declarations:
            parts.append("## Available Tools")
            for tool in tool_declarations[:20]:
                if isinstance(tool, dict):
                    parts.append(f"- {tool.get('name', '?')}: {_truncate(tool.get('description', ''), 200)}")
                else:
                    parts.append(f"- {_truncate(str(tool), 200)}")
            parts.append("")

    # ── Build from observability spans (the common case) ─────────
    if not traj_groups:
        obs_narrative = _preprocess_observability_spans(spans, session_id)
        # obs_narrative already starts with "# Agent Session: ...", replace our header
        # by appending just the body portion
        header_end = obs_narrative.find("\n## ")
        if header_end > 0:
            parts.append(obs_narrative[header_end:])
        else:
            parts.append(obs_narrative)
        return "\n".join(parts)

    # ── Build from trajectory spans ──────────────────────────────
    llm_spans = [s for s in spans if s.get("span_type", "").startswith("llm.")]
    tool_spans = [s for s in spans if s.get("span_type", "").startswith("tool.")]

    parts.append(f"Total trajectories: {len(traj_groups)}")
    parts.append(f"Total LLM calls: {len([s for s in llm_spans if s.get('span_type') == 'llm.end'])}")
    parts.append(f"Total tool calls: {len([s for s in tool_spans if s.get('span_type') == 'tool.end'])}")
    parts.append("")

    # Tool usage stats
    tool_counts: dict[str, int] = {}
    tool_errors: dict[str, int] = {}
    for s in tool_spans:
        if s.get("span_type") == "tool.end":
            name = s.get("tool_name", "unknown")
            tool_counts[name] = tool_counts.get(name, 0) + 1
            if s.get("error"):
                tool_errors[name] = tool_errors.get(name, 0) + 1

    if tool_counts:
        parts.append("## Tool Usage Summary")
        for tool, count in sorted(tool_counts.items(), key=lambda x: -x[1]):
            err = tool_errors.get(tool, 0)
            err_str = f" ({err} errors)" if err else ""
            parts.append(f"- {tool}: {count} calls{err_str}")
        parts.append("")

    # Process each trajectory
    for uid, traj_spans in traj_groups.items():
        traj_spans.sort(key=lambda t: t.get("step_idx") or 0)

        start_span = next((t for t in traj_spans if t.get("span_type") == "trajectory.start"), None)
        end_span = next((t for t in traj_spans if t.get("span_type") == "trajectory.end"), None)
        step_spans = [t for t in traj_spans if t.get("span_type") == "trajectory.step"]

        agent_name = start_span.get("agent_name", "agent") if start_span else "agent"
        task = start_span.get("task", {}) if start_span else {}
        task_str = json.dumps(task, default=str) if isinstance(task, dict) else str(task)
        if len(task_str) > 500:
            task_str = task_str[:500] + "..."

        final_reward = end_span.get("reward") if end_span else None
        num_steps = end_span.get("num_steps") if end_span else len(step_spans)
        outcome = "SUCCESS" if final_reward and final_reward > 0.5 else "FAIL" if final_reward is not None else "UNKNOWN"

        parts.append(f"## Trajectory: {uid[:12]}")
        parts.append(f"Agent: {agent_name} | Outcome: {outcome} | Reward: {final_reward} | Steps: {num_steps}")
        parts.append(f"Task: {task_str}")
        parts.append("")

        for step in step_spans:
            idx = step.get("step_idx", "?")
            input_val = _truncate(step.get("input", ""))
            output_val = _truncate(step.get("output", ""))
            action_val = _truncate(step.get("action", ""))
            reward = step.get("reward", "")
            done = step.get("done")

            parts.append(f"Step {idx}:")
            if input_val:
                parts.append(f"  Input: {input_val}")
            if action_val:
                parts.append(f"  Action: {action_val}")
            if output_val:
                parts.append(f"  Output: {output_val}")
            if reward is not None and reward != "":
                parts.append(f"  Reward: {reward}")
            if done:
                parts.append(f"  Done: {done}")
            parts.append("")

        parts.append("---")
        parts.append("")

    return "\n".join(parts)


def _preprocess_observability_spans(
    spans: list[dict[str, Any]],
    session_id: str,
) -> str:
    """Build a narrative from observability spans (agent.*, tool.*, llm.*, invocation.*, event).

    Groups spans by invocation_id to reconstruct agent execution flow.
    """
    parts: list[str] = []
    parts.append(f"# Agent Session: {session_id}")
    parts.append("")

    # Categorize spans
    agent_spans = [s for s in spans if s.get("span_type", "").startswith("agent.")]
    tool_spans = [s for s in spans if s.get("span_type", "").startswith("tool.")]
    llm_spans = [s for s in spans if s.get("span_type", "").startswith("llm.")]
    invocation_spans = [s for s in spans if s.get("span_type", "").startswith("invocation.")]
    event_spans = [s for s in spans if s.get("span_type") == "event"]

    # Session-level stats
    llm_end_count = len([s for s in llm_spans if s.get("span_type") == "llm.end"])
    tool_end_count = len([s for s in tool_spans if s.get("span_type") == "tool.end"])
    agent_count = len([s for s in agent_spans if s.get("span_type") == "agent.start"])
    error_count = len([s for s in spans if s.get("error")])

    parts.append(f"## Session Overview")
    parts.append(f"- Agent invocations: {agent_count}")
    parts.append(f"- LLM calls: {llm_end_count}")
    parts.append(f"- Tool calls: {tool_end_count}")
    parts.append(f"- Errors: {error_count}")
    parts.append("")

    # Tool usage summary
    tool_counts: dict[str, int] = {}
    tool_errors: dict[str, int] = {}
    tool_durations: dict[str, list[float]] = {}
    for s in tool_spans:
        if s.get("span_type") == "tool.end":
            name = s.get("tool_name") or "unknown"
            tool_counts[name] = tool_counts.get(name, 0) + 1
            if s.get("error"):
                tool_errors[name] = tool_errors.get(name, 0) + 1
            dur = s.get("duration_ms")
            if dur:
                tool_durations.setdefault(name, []).append(float(dur))

    if tool_counts:
        parts.append("## Tool Usage Summary")
        for tool, count in sorted(tool_counts.items(), key=lambda x: -x[1]):
            err = tool_errors.get(tool, 0)
            durs = tool_durations.get(tool, [])
            avg_dur = f", avg {sum(durs)/len(durs):.0f}ms" if durs else ""
            err_str = f", {err} errors" if err else ""
            parts.append(f"- {tool}: {count} calls{err_str}{avg_dur}")
        parts.append("")

    # LLM usage summary
    models_used: dict[str, int] = {}
    total_input_tokens = 0
    total_output_tokens = 0
    llm_durations: list[float] = []
    for s in llm_spans:
        if s.get("span_type") == "llm.end":
            model = s.get("model", "unknown")
            models_used[model] = models_used.get(model, 0) + 1
            total_input_tokens += s.get("input_tokens") or 0
            total_output_tokens += s.get("output_tokens") or 0
            dur = s.get("duration_ms")
            if dur:
                llm_durations.append(float(dur))

    if models_used:
        parts.append("## LLM Usage Summary")
        for model, count in sorted(models_used.items(), key=lambda x: -x[1]):
            parts.append(f"- {model}: {count} calls")
        parts.append(f"- Total tokens: {total_input_tokens} input, {total_output_tokens} output")
        if llm_durations:
            parts.append(f"- Avg LLM latency: {sum(llm_durations)/len(llm_durations):.0f}ms")
        parts.append("")

    # Group spans by invocation to reconstruct execution flow
    invocation_groups: dict[str, list[dict]] = {}
    for s in spans:
        inv_id = s.get("invocation_id", "")
        if inv_id:
            invocation_groups.setdefault(inv_id, []).append(s)

    # Sort invocations by earliest span timestamp
    sorted_invocations = sorted(
        invocation_groups.items(),
        key=lambda kv: min(str(s.get("created_at", "")) for s in kv[1]),
    )

    parts.append("## Execution Flow (by invocation)")
    parts.append("")

    for inv_idx, (inv_id, inv_spans) in enumerate(sorted_invocations):
        inv_spans.sort(key=lambda s: str(s.get("created_at", "")))
        agent_name = next((s.get("agent_name") for s in inv_spans if s.get("agent_name")), "agent")

        # Find invocation duration
        inv_end = next((s for s in inv_spans if s.get("span_type") == "invocation.end"), None)
        dur_str = f" ({inv_end.get('duration_ms', 0):.0f}ms)" if inv_end and inv_end.get("duration_ms") else ""

        parts.append(f"### Invocation {inv_idx + 1}: {agent_name}{dur_str}")

        # LLM calls in this invocation
        for s in inv_spans:
            if s.get("span_type") == "llm.start":
                data = s.get("data") or {}
                request = data.get("request") or {}
                messages = request.get("messages") or []
                model = request.get("model", "")
                # Extract the last user message as the prompt summary
                user_msgs = [m for m in messages if m.get("role") == "user"]
                if user_msgs:
                    content = user_msgs[-1].get("content", "")
                    if isinstance(content, list):
                        content = " ".join(
                            c.get("text", "") for c in content if isinstance(c, dict)
                        )
                    parts.append(f"  LLM call ({model}): {_truncate(content, 500)}")
                else:
                    parts.append(f"  LLM call ({model})")

            elif s.get("span_type") == "llm.end":
                data = s.get("data") or {}
                response = data.get("response") or {}
                content_blocks = response.get("content") or []
                for block in content_blocks:
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            parts.append(f"  LLM response: {_truncate(block.get('text', ''), 500)}")
                        elif block.get("type") == "tool_use":
                            parts.append(f"  LLM → tool_use: {block.get('name', '?')}({_truncate(block.get('input', {}), 200)})")
                if s.get("error"):
                    parts.append(f"  LLM ERROR: {_truncate(s['error'], 300)}")

            elif s.get("span_type") == "tool.start":
                tool_name = s.get("tool_name") or "unknown"
                data = s.get("data") or {}
                tool_input = data.get("input", "")
                parts.append(f"  Tool call: {tool_name}({_truncate(tool_input, 300)})")

            elif s.get("span_type") == "tool.end":
                tool_name = s.get("tool_name") or "unknown"
                data = s.get("data") or {}
                output = data.get("output", "")
                dur = s.get("duration_ms")
                dur_str = f" [{dur:.0f}ms]" if dur else ""
                if s.get("error"):
                    parts.append(f"  Tool result: {tool_name} ERROR{dur_str}: {_truncate(s['error'], 300)}")
                else:
                    parts.append(f"  Tool result: {tool_name}{dur_str} → {_truncate(output, 300)}")

        # Events in this invocation
        inv_events = [s for s in inv_spans if s.get("span_type") == "event"]
        for ev in inv_events:
            data = ev.get("data") or {}
            event_type = data.get("event_type", data.get("type", "event"))
            parts.append(f"  Event: {event_type}: {_truncate(data, 200)}")

        parts.append("")

    # Events not tied to an invocation
    unlinked_events = [s for s in event_spans if not s.get("invocation_id")]
    if unlinked_events:
        parts.append("## Session Events")
        for ev in unlinked_events:
            data = ev.get("data") or {}
            parts.append(f"- {_truncate(data, 300)}")
        parts.append("")

    return "\n".join(parts)


def _truncate(val: Any, max_len: int = 300) -> str:
    """Truncate a value to max_len characters."""
    if val is None:
        return ""
    s = json.dumps(val, default=str) if isinstance(val, (dict, list)) else str(val)
    return s[:max_len] + "..." if len(s) > max_len else s


# ── LLM extraction prompts ────────────────────────────────────────

SKILL_EXTRACTION_PROMPT = """You are analyzing compressed session digests from AI agent troubleshooting sessions to extract reusable SKILLS.

Each digest below contains:
- **session_id** and **outcome** (success/failure based on human evaluation)
- **strategy_summary**: what the agent did
- **key_decisions**: critical decision points
- **tools_used**: tool call sequence
- **what_worked** and **what_failed**: per-session analysis
- **failure_point**: where/why the agent failed (for failed sessions)
- **eval labels**: human rating, task_success, trajectory_alignment

The digests are organized into SUCCESSFUL and FAILED groups. Your job is to find **cross-session patterns** by contrasting these groups.

For each skill:

**From successful sessions, extract:**
- The PATTERN: what sequence of decisions/tool-calls characterizes success
- The KEY SEQUENCE: numbered step-by-step actions
- Critical decision points where successful agents made the right choice

**From failed sessions, extract:**
- The ANTI-PATTERN: what failing agents did instead
- The FAILURE LESSON: point of failure, flawed reasoning, what should have been done
- General prevention principles

**Ground the analysis in eval data:**
- Use the actual outcome labels to compute reward_delta
- Reference specific session IDs as evidence
- Higher confidence when both success and failure examples exist

For each skill, provide:
- title: concise name (e.g., "Backtrack-and-Constrain Recovery")
- description: full markdown with sections: ## Pattern, ## Key Sequence, ## Anti-pattern, ## Failure Lesson, ## Source Evidence
- category: one of [tool-strategy, error-recovery, prompt-technique, task-decomposition, verification-pattern, resource-optimization]
- confidence: 0.0-1.0 based on evidence strength
- reward_delta: float between -1.0 and 1.0 (from actual success rates)
- success_rate: "X% when applied vs Y% baseline"
- evidence_count: number of sessions supporting this
- source_sessions: session IDs where observed
- tags: relevant labels

Focus on patterns that are:
- CONTRASTIVE: clearly differentiate success from failure
- HIGH-IMPACT: large delta between success and failure rates
- ACTIONABLE: concrete enough to inject into an agent's system prompt
- RECURRING: appear across multiple sessions, not one-offs

Also provide a brief summary of overall findings.

"""

SESSION_DIGEST_PROMPT = """You are analyzing a single AI agent session trace. Your job is to compress the full trajectory into a structured digest that captures the essential behavioral patterns.

Analyze the complete trace below and produce:
- **outcome**: "success" if the agent achieved its goal, "failure" if not, "unclear" if ambiguous. Use the human evaluation labels if provided.
- **strategy_summary**: 2-3 sentences describing the agent's overall approach
- **key_decisions**: Up to 5 critical decision points (tool selection, error handling, strategy changes)
- **tools_used**: List of tool names in the order they were called
- **failure_point**: If the session failed, describe where and why. Empty string if successful.
- **what_worked**: What the agent did well (even in failed sessions)
- **what_failed**: What the agent did poorly or missed (even in successful sessions)

Be specific and reference actual tool names, error messages, and decision points from the trace.

Here is the session trace:

"""

REFINEMENT_PROMPT = """You are refining an existing set of extracted agent skills based on validation results.

## Current Skills
{existing_skills}

## Validation Results
The skills above were validated against held-out sessions. Here are sessions where the current skills did NOT adequately explain the outcome:

### Gap Sessions (unexplained by current skills)
{gap_sessions}

Your task:
1. **Refine** existing skills if the gap sessions reveal they are incomplete or inaccurate
2. **Create new skills** if the gap sessions reveal patterns not covered by any existing skill
3. **Merge** skills that are too similar into a single, stronger skill
4. **Increase confidence** for skills that are well-supported, decrease for those that aren't

Return the complete updated skill set (refined + new + merged).
"""
