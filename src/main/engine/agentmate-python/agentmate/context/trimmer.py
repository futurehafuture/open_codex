"""P1 — Read-time history projection (trimming).

:func:`trim_for_query` builds a *projected* message list that fits within a
character budget before passing it to the LLM.  The original ``messages`` list
in the agent loop is **never mutated** — this is a pure function that returns a
new list.

Invariant (critical)
--------------------
OpenAI-compatible APIs require that every ``tool`` message references a
``tool_call_id`` that exists in an ``assistant`` turn with ``tool_calls``.  Any
trim operation that removes an assistant turn **must** also remove its paired
tool messages, and vice versa.  This module identifies such groups atomically
and only ever removes or truncates them as a unit.

Algorithm
---------
1. Partition messages into typed *groups*:
   - ``system``       — the system prompt; never touched.
   - ``conv_turn``    — ``[user, assistant]`` pair without tool calls.
   - ``tool_block``   — ``[assistant(tool_calls), tool…]`` block; atomic.
   - ``standalone``   — any other message (rare edge-case; kept as-is).

2. Always protect the system group and the last ``keep_recent`` non-system
   messages (flattened).

3. For *eligible* (older, non-protected) groups, apply two passes:
   - **Soft pass**: truncate ``content`` of tool messages using
     :func:`~agentmate.context.budget.truncate_result`.
   - **Hard pass**: if still over budget, drop entire ``tool_block`` groups,
     replacing each with a single compact placeholder user-message.
   - **Conv pass**: if still over budget, drop oldest ``conv_turn`` pairs.

4. Re-assemble and return: system + eligible (shaped) + protected.

Character estimation
--------------------
A cheap heuristic — sum of ``len(json.dumps(msg))`` — avoids a tiktoken
dependency and is accurate enough for budget gating.  DeepSeek's ``usage``
field gives ground truth post-call for calibration.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from agentmate.context.budget import truncate_result
from agentmate.core.message import Message

__all__ = ["trim_for_query", "estimate_chars"]

logger = logging.getLogger(__name__)

# Soft-truncation limit applied to tool results during the trim pass.
# Tighter than the P0 per-tool budget: P0 guards individual calls; P1 re-trims
# when the *accumulated* history is still too large.
_TRIM_TOOL_MAX = 800


# ---------------------------------------------------------------------------
# Group data structures
# ---------------------------------------------------------------------------


@dataclass
class _Group:
    """One atomic unit of the message history."""

    kind: str  # "system" | "conv_turn" | "tool_block" | "standalone"
    messages: list[Message] = field(default_factory=list)

    def char_count(self) -> int:
        return sum(estimate_chars(m) for m in self.messages)


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def estimate_chars(msg: Message) -> int:
    """Cheap character-count estimate for one message dict.

    Uses ``json.dumps`` so structured content (lists, dicts) is counted
    accurately.  Returns 0 for non-dict values.
    """
    try:
        return len(json.dumps(msg, ensure_ascii=False))
    except (TypeError, ValueError):
        return len(str(msg))


def trim_for_query(
    messages: list[Message],
    char_budget: int,
    keep_recent: int = 6,
    soft_tool_max: int = _TRIM_TOOL_MAX,
) -> list[Message]:
    """Return a projected message list that fits within *char_budget*.

    This is a **read-only** projection — the input list is never modified.

    Args:
        messages: Full message list as built by the agent loop.
        char_budget: Maximum total character count (estimated) for the returned
            list.  Use ``agent_config.context_char_budget`` as the source.
        keep_recent: Number of non-system messages at the tail that are always
            kept intact (no truncation, no removal).
        soft_tool_max: Character cap applied to tool message content during the
            soft pass.  Defaults to 800 chars — tighter than the P0 per-tool
            cap because P1 re-shapes already-capped results.

    Returns:
        A new list of :data:`~agentmate.core.message.Message` dicts, possibly
        shorter or with truncated tool result content.
    """
    total = sum(estimate_chars(m) for m in messages)
    if total <= char_budget:
        return list(messages)  # fast path — no trimming needed

    logger.debug(
        "trim_for_query: %d chars > budget %d; trimming %d messages",
        total,
        char_budget,
        len(messages),
    )

    # --- 1. Separate system from the rest -----------------------------------
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]

    # --- 2. Protect the tail ------------------------------------------------
    if len(non_system) <= keep_recent:
        # Nothing eligible — can't trim further; return as-is.
        return list(messages)

    protected = non_system[-keep_recent:]
    eligible_msgs = non_system[:-keep_recent]

    # --- 3. Group eligible messages -----------------------------------------
    groups = _build_groups(eligible_msgs)

    # Pre-compute fixed cost (system + protected) to know the available budget.
    fixed_chars = sum(estimate_chars(m) for m in system_msgs + protected)
    available = max(0, char_budget - fixed_chars)

    # --- 4. Soft pass: truncate tool content --------------------------------
    groups = _soft_trim_tool_blocks(groups, soft_tool_max)

    eligible_flat = _flatten(groups)
    if sum(estimate_chars(m) for m in eligible_flat) <= available:
        return system_msgs + eligible_flat + protected

    # --- 5. Hard pass: drop oldest tool_blocks ------------------------------
    groups = _hard_drop_tool_blocks(groups, available)

    eligible_flat = _flatten(groups)
    if sum(estimate_chars(m) for m in eligible_flat) <= available:
        return system_msgs + eligible_flat + protected

    # --- 6. Conv pass: drop oldest conv_turn pairs --------------------------
    groups = _drop_conv_turns(groups, available)

    eligible_flat = _flatten(groups)
    logger.debug(
        "trim_for_query: after all passes, eligible=%d chars, budget=%d",
        sum(estimate_chars(m) for m in eligible_flat),
        available,
    )
    return system_msgs + eligible_flat + protected


# ---------------------------------------------------------------------------
# Grouping
# ---------------------------------------------------------------------------


def _build_groups(messages: list[Message]) -> list[_Group]:
    """Partition ``messages`` into typed groups.

    Scan linearly, recognising:
    - A ``user`` followed by an ``assistant`` (no tool_calls) → ``conv_turn``.
    - An ``assistant`` with ``tool_calls`` followed by one or more ``tool``
      messages → ``tool_block`` (atomic).
    - Anything else → ``standalone``.
    """
    groups: list[_Group] = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        role = msg.get("role")

        if role == "user":
            # Peek: is the next message a plain assistant turn?
            if (
                i + 1 < len(messages)
                and messages[i + 1].get("role") == "assistant"
                and not messages[i + 1].get("tool_calls")
            ):
                groups.append(_Group("conv_turn", [msg, messages[i + 1]]))
                i += 2
            else:
                groups.append(_Group("standalone", [msg]))
                i += 1

        elif role == "assistant" and msg.get("tool_calls"):
            # Collect all immediately-following tool messages.
            tool_msgs: list[Message] = []
            j = i + 1
            while j < len(messages) and messages[j].get("role") == "tool":
                tool_msgs.append(messages[j])
                j += 1
            groups.append(_Group("tool_block", [msg] + tool_msgs))
            i = j

        else:
            groups.append(_Group("standalone", [msg]))
            i += 1

    return groups


def _flatten(groups: list[_Group]) -> list[Message]:
    result: list[Message] = []
    for g in groups:
        result.extend(g.messages)
    return result


# ---------------------------------------------------------------------------
# Trim passes
# ---------------------------------------------------------------------------


def _soft_trim_tool_blocks(
    groups: list[_Group], tool_max: int
) -> list[_Group]:
    """Truncate the ``content`` of tool messages within each tool_block."""
    out: list[_Group] = []
    for g in groups:
        if g.kind != "tool_block":
            out.append(g)
            continue
        # Re-build messages: keep the assistant turn as-is; truncate tool results.
        new_msgs: list[Message] = []
        for msg in g.messages:
            if msg.get("role") == "tool":
                content = msg.get("content") or ""
                if len(content) > tool_max:
                    msg = {**msg, "content": truncate_result(content, tool_max)}
            new_msgs.append(msg)
        out.append(_Group("tool_block", new_msgs))
    return out


def _hard_drop_tool_blocks(
    groups: list[_Group], available: int
) -> list[_Group]:
    """Replace oldest tool_blocks with a compact placeholder until within budget.

    The placeholder is a ``user``-role message so the format remains valid.
    Dropping the assistant+tool pair completely is also valid; the placeholder
    gives the model a breadcrumb.
    """
    out = list(groups)
    for i, g in enumerate(out):
        if g.kind != "tool_block":
            continue
        current = sum(g_.char_count() for g_ in out)
        if current <= available:
            break
        # Build a one-line summary from the assistant turn's tool_calls.
        asst = g.messages[0]
        calls = asst.get("tool_calls") or []
        names = ", ".join(
            c.get("function", {}).get("name", "?") for c in calls
        )
        placeholder: Message = {
            "role": "user",
            "content": f"[Earlier context omitted — tool call(s): {names}]",
        }
        out[i] = _Group("standalone", [placeholder])
        logger.debug("Hard-dropped tool_block for tools: %s", names)
    return out


def _drop_conv_turns(groups: list[_Group], available: int) -> list[_Group]:
    """Drop oldest conv_turn pairs until within budget."""
    out = list(groups)
    for i, g in enumerate(out):
        if g.kind != "conv_turn":
            continue
        current = sum(g_.char_count() for g_ in out)
        if current <= available:
            break
        out[i] = _Group("standalone", [])  # empty group — filtered out below
        logger.debug("Dropped conv_turn pair from history.")
    # Remove empty groups.
    return [g for g in out if g.messages]
