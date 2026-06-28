"""LLM client seam: the loop depends only on this Protocol and its types.

The concrete OpenAI-compatible client is a separate slice. Anything that can
return an :class:`LLMResponse` from a message list plugs in here, including a
scripted fake used in tests and, later, a streaming client.
"""

from __future__ import annotations

from collections.abc import Generator
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

__all__ = [
    "TokenUsage",
    "ToolCall",
    "LLMResponse",
    "StreamDelta",
    "LLMClient",
    "StreamingLLMClient",
]


@dataclass(frozen=True)
class TokenUsage:
    """Token consumption for one LLM call.

    Attributes:
        prompt_tokens: Tokens in the prompt (input).
        completion_tokens: Tokens in the completion (output).
        total_tokens: Sum of prompt and completion tokens.
        cached_tokens: Prompt tokens served from the provider cache (subset of
            prompt_tokens). DeepSeek exposes this as
            ``usage.prompt_tokens_details.cached_tokens``.
        reasoning_tokens: Tokens spent on chain-of-thought reasoning (subset of
            completion_tokens). DeepSeek exposes this as
            ``usage.completion_tokens_details.reasoning_tokens``.
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int = 0
    reasoning_tokens: int = 0


@dataclass(frozen=True)
class ToolCall:
    """A single tool invocation requested by the model.

    Attributes:
        id: Provider-assigned call id; must be echoed back on the tool result.
        name: Tool name to invoke.
        arguments: Raw JSON string of arguments, exactly as the model emitted it
            (kept unparsed so the executor owns parsing and error handling).
    """

    id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class LLMResponse:
    """One assistant turn: free-text content, tool calls, or both.

    Attributes:
        content: Assistant text, or ``None`` for a pure tool-call turn.
        tool_calls: Requested tool calls; empty when the model answered directly.
        usage: Token consumption for this call, or ``None`` if the provider did
            not return usage information.
        reasoning: Chain-of-thought text the model produced before the answer
            (provider-specific, e.g. DeepSeek ``reasoning_content``). ``None``
            when the provider returns no reasoning. DeepSeek requires this to be
            echoed back on assistant turns that carry tool calls, or the next
            request 400s; see :func:`agentmate.core.message.assistant_message`.
    """

    content: str | None = None
    tool_calls: tuple[ToolCall, ...] = field(default_factory=tuple)
    usage: TokenUsage | None = None
    reasoning: str | None = None

    @property
    def has_tool_calls(self) -> bool:
        return len(self.tool_calls) > 0


@dataclass(frozen=True)
class StreamDelta:
    """One incremental piece of a streamed assistant turn.

    A chunk carries reasoning text, answer text, or neither (tool-call fragments
    are assembled internally and surfaced only in the final aggregated
    :class:`LLMResponse`, not as deltas).
    """

    reasoning: str | None = None
    content: str | None = None


@runtime_checkable
class LLMClient(Protocol):
    """Synchronous completion seam used by the agent loop."""

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> LLMResponse:
        """Return the next assistant turn given the conversation so far.

        Args:
            messages: OpenAI-format message dicts.
            tools: OpenAI-format tool schemas, or ``None`` to forbid tool use
                (used to force a final text answer).
        """
        ...


@runtime_checkable
class StreamingLLMClient(LLMClient, Protocol):
    """A client that can also stream a turn token-by-token.

    ``stream`` yields :class:`StreamDelta` pieces and *returns* the aggregated
    :class:`LLMResponse` (with assembled tool calls) — capture it with
    ``response = yield from client.stream(...)``.
    """

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> Generator[StreamDelta, None, LLMResponse]:
        ...
