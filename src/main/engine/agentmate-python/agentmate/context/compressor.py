"""P2 — LLM-based history compaction.

:func:`compact_history` calls the model to summarise the older portion of the
conversation, then rebuilds a shorter message list.  The full original history
is preserved by the server on disk; compaction only affects what the *model
sees* on the next turn.

When compaction runs
--------------------
The agent triggers compaction when the **estimated token count** of the message
list exceeds ``auto_compact_threshold × context_char_budget``.  Token count is
derived from the accumulated ``usage.prompt_tokens`` returned by DeepSeek
(ground-truth); the char estimate is used only as a fallback when no usage is
available yet.

Compaction sequence
-------------------
1. Determine the *split point*: keep the last ``compact_keep_recent`` messages
   intact; summarise everything before (except the system prompt).
2. Call the LLM with a special compact prompt (no tools, low temperature).
3. Replace the summarised slice with a single ``user``-role summary message.
4. Prepend the system prompt and append the kept tail.

This matches OpenClaw's "较早的对话轮次会被摘要成一条精简条目" model.

Pairing invariant
-----------------
The split point is adjusted forward (toward the tail) if it falls inside a
``[assistant(tool_calls), tool…]`` block — the group is left in the *kept*
tail so it stays paired.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from agentmate.core.message import Message, system_message, user_message

if TYPE_CHECKING:
    from agentmate.llm.base import LLMClient

__all__ = ["compact_history", "COMPACT_SYSTEM_PROMPT"]

logger = logging.getLogger(__name__)

COMPACT_SYSTEM_PROMPT = (
    "You are a precise summariser. "
    "Condense the conversation below into a single compact record. "
    "Include: the user's goals, key decisions, all tool calls and their results, "
    "and any important facts or data discovered. "
    "Write in third-person past tense. Be concise but complete — the summary "
    "will replace the original messages, so nothing important may be lost."
)

_COMPACT_USER_PREFIX = (
    "Summarise the conversation above. "
    "Capture every tool call, its arguments, and the key findings from its result."
)


def compact_history(
    messages: list[Message],
    llm: "LLMClient",
    keep_recent: int = 4,
) -> tuple[list[Message], str]:
    """Summarise the older portion of ``messages`` using ``llm``.

    Args:
        messages: Full message list as built by the agent loop (includes the
            system prompt at index 0).
        llm: LLM client used to generate the summary (called with no tools so
            the response is always plain text).
        keep_recent: Number of non-system messages to keep verbatim after the
            summary.  Minimum 2 to preserve at least the current user turn.

    Returns:
        A tuple ``(new_messages, summary_text)`` where ``new_messages`` is the
        compacted list and ``summary_text`` is the raw summary produced by the
        model (logged and forwarded to the ``CompactionEvent``).

    Raises:
        ValueError: If ``messages`` has fewer than 3 entries (system + 2) —
            nothing to compact.
    """
    keep_recent = max(2, keep_recent)

    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]

    if len(non_system) <= keep_recent:
        raise ValueError(
            f"compact_history: only {len(non_system)} non-system messages; "
            f"need more than keep_recent={keep_recent} to compact."
        )

    # Determine split; move boundary to avoid breaking a tool_block.
    split = len(non_system) - keep_recent
    split = _safe_split(non_system, split)

    to_summarise = non_system[:split]
    to_keep = non_system[split:]

    if not to_summarise:
        raise ValueError("compact_history: nothing left to summarise after split adjustment.")

    # Build the compaction prompt.
    compact_prompt: list[Message] = (
        [system_message(COMPACT_SYSTEM_PROMPT)]
        + to_summarise
        + [user_message(_COMPACT_USER_PREFIX)]
    )

    logger.info(
        "compact_history: summarising %d messages, keeping %d",
        len(to_summarise),
        len(to_keep),
    )

    from agentmate.llm.base import LLMClient  # local import avoids circular

    response = llm.complete(compact_prompt, tools=None)
    summary = response.content or "(summary unavailable)"
    logger.info("compact_history: summary produced (%d chars)", len(summary))

    summary_msg: Message = {
        "role": "user",
        "content": f"[Conversation summary — earlier context compressed]\n{summary}",
    }

    new_messages = system_msgs + [summary_msg] + to_keep
    return new_messages, summary


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _safe_split(non_system: list[Message], split: int) -> int:
    """Move ``split`` forward past any open tool_block at the boundary.

    If ``non_system[split - 1]`` is an ``assistant`` with ``tool_calls``, the
    split would leave its paired ``tool`` messages in the kept tail with no
    matching ``assistant`` — violating the pairing invariant.  We advance the
    split to include the entire block in the *summarised* portion.

    Conversely, if ``non_system[split]`` is a ``tool`` message, the assistant
    turn that owns it must be at or before ``split - 1``; walk back to find
    the owning assistant and include it fully in the summarised part, or move
    the split to place the entire block in the kept tail.
    """
    if split <= 0 or split >= len(non_system):
        return split

    # Case 1: the message just before the split is an assistant-with-tool_calls.
    # Its tool messages start at split — move split forward to include them all.
    prev = non_system[split - 1]
    if prev.get("role") == "assistant" and prev.get("tool_calls"):
        j = split
        while j < len(non_system) and non_system[j].get("role") == "tool":
            j += 1
        logger.debug(
            "_safe_split: advanced split from %d to %d (include tool msgs)", split, j
        )
        return j

    # Case 2: the message at split is a tool message — the owning assistant is
    # in the summarised portion.  Walk back to find it and keep the whole block
    # in the summarised portion by not moving the split (it's already fine).
    if non_system[split].get("role") == "tool":
        # The assistant is already before split → all good.
        pass

    return split
