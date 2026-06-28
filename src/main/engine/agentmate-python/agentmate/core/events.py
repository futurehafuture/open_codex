"""Typed events emitted by the streaming agent loop."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

__all__ = [
    "AgentEvent",
    "ThinkingEvent",
    "AnswerDeltaEvent",
    "ToolCallEvent",
    "ToolResultEvent",
    "UsageEvent",
    "CompactionEvent",
    "StepEvent",
    "DoneEvent",
]


@dataclass(frozen=True)
class AgentEvent:
    """Base class for all agent events."""


@dataclass(frozen=True)
class ThinkingEvent(AgentEvent):
    """Incremental reasoning/thinking text from the model."""

    delta: str = ""


@dataclass(frozen=True)
class AnswerDeltaEvent(AgentEvent):
    """Incremental answer text from the model."""

    delta: str = ""


@dataclass(frozen=True)
class ToolCallEvent(AgentEvent):
    """The model requested a tool invocation."""

    call_id: str = ""
    name: str = ""
    arguments: str = "{}"


@dataclass(frozen=True)
class ToolResultEvent(AgentEvent):
    """Result returned by a tool execution."""

    call_id: str = ""
    name: str = ""
    result: str = ""


@dataclass(frozen=True)
class UsageEvent(AgentEvent):
    """Token usage reported after one LLM call.

    Emitted after every model call so the server can track cumulative cost and
    surface it in the UI or logs.

    Attributes:
        prompt_tokens: Prompt tokens consumed (includes cache hits).
        completion_tokens: Output tokens generated.
        total_tokens: Sum of prompt and completion tokens.
        cached_tokens: Prompt tokens served from the provider cache (= money
            saved vs. a full re-prompt).
        reasoning_tokens: Tokens spent on chain-of-thought reasoning (subset of
            completion_tokens, non-zero only when thinking is enabled).
        step: Which agent loop step (0-based) generated this event.
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int = 0
    reasoning_tokens: int = 0
    step: int = 0


@dataclass(frozen=True)
class CompactionEvent(AgentEvent):
    """Emitted when LLM-based history compaction (P2) runs.

    Attributes:
        messages_before: Number of messages in the list before compaction.
        messages_after: Number of messages after compaction.
        summary_chars: Length of the generated summary text.
    """

    messages_before: int = 0
    messages_after: int = 0
    summary_chars: int = 0


@dataclass(frozen=True)
class StepEvent(AgentEvent):
    """A loop step finished (assistant turn + its tool results appended).

    Carries a snapshot of the conversation built so far so a consumer can
    persist progress incrementally — if the run is interrupted mid-flight, the
    last :class:`StepEvent` snapshot is the most recent durable record (the
    final, authoritative list still arrives on :class:`DoneEvent`).

    Attributes:
        step: Which agent loop step (0-based) just completed.
        messages: Snapshot of the OpenAI-format conversation up to this step.
    """

    step: int = 0
    messages: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class DoneEvent(AgentEvent):
    """The agent loop has finished.

    Attributes:
        answer: The assistant's final text answer.
        messages: The complete OpenAI-format conversation the loop built this
            run (``system`` / ``user`` / ``assistant`` with ``tool_calls`` /
            ``tool``). This is the first-hand SDK record, suitable for
            persistence and for resuming the conversation verbatim.
    """

    answer: str = ""
    messages: list[dict[str, Any]] = field(default_factory=list)
