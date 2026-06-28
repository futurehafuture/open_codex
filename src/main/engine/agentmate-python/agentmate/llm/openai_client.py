"""OpenAI-compatible client implementing the :class:`LLMClient` seam.

Works with OpenAI and any provider exposing an OpenAI-style
``/v1/chat/completions`` endpoint (DeepSeek, Qwen, GLM, vLLM, Ollama) by
pointing ``base_url`` at it. Construct from an explicit :class:`ModelConfig`, or
use :meth:`from_profile` to load one from the TOML config.
"""

from __future__ import annotations

import logging
from collections.abc import Generator
from typing import Any

from openai import OpenAI

from agentmate.config import ModelConfig, resolve_profile
from agentmate.llm.base import LLMResponse, StreamDelta, TokenUsage, ToolCall

__all__ = ["OpenAIClient", "parse_completion"]

logger = logging.getLogger(__name__)


def _coerce_text(content: Any) -> str:
    """Flatten possibly-structured message content to plain text.

    Some OpenAI-compatible providers return a list of content parts rather than
    a string; normalize both to text.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return str(content)


def _parse_usage(raw: Any) -> TokenUsage | None:
    """Extract :class:`TokenUsage` from a provider usage object.

    Returns ``None`` when the provider omits the usage field entirely.
    DeepSeek-specific fields (``prompt_cache_hit_tokens``,
    ``completion_tokens_details.reasoning_tokens``) are captured when present.
    """
    if raw is None:
        return None
    prompt = int(getattr(raw, "prompt_tokens", 0) or 0)
    completion = int(getattr(raw, "completion_tokens", 0) or 0)
    total = int(getattr(raw, "total_tokens", 0) or 0)

    # cached_tokens: prefer prompt_tokens_details.cached_tokens (standard),
    # fall back to DeepSeek's top-level prompt_cache_hit_tokens.
    cached = 0
    ptd = getattr(raw, "prompt_tokens_details", None)
    if ptd is not None:
        cached = int(getattr(ptd, "cached_tokens", 0) or 0)
    if cached == 0:
        cached = int(getattr(raw, "prompt_cache_hit_tokens", 0) or 0)

    # reasoning_tokens: DeepSeek exposes these in completion_tokens_details.
    reasoning = 0
    ctd = getattr(raw, "completion_tokens_details", None)
    if ctd is not None:
        reasoning = int(getattr(ctd, "reasoning_tokens", 0) or 0)

    return TokenUsage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        cached_tokens=cached,
        reasoning_tokens=reasoning,
    )


def parse_completion(completion: Any) -> LLMResponse:
    """Map an OpenAI chat completion into an :class:`LLMResponse`.

    Kept as a pure function (duck-typed input) so the mapping — including
    multiple/parallel tool calls with their real ids — is testable offline.
    """
    message = completion.choices[0].message
    raw_calls = getattr(message, "tool_calls", None) or []
    tool_calls = tuple(
        ToolCall(
            id=call.id,
            name=call.function.name,
            arguments=call.function.arguments or "{}",
        )
        for call in raw_calls
    )
    content = _coerce_text(getattr(message, "content", None))
    reasoning = getattr(message, "reasoning_content", None) or None
    usage = _parse_usage(getattr(completion, "usage", None))
    return LLMResponse(
        content=content or None,
        tool_calls=tool_calls,
        usage=usage,
        reasoning=reasoning,
    )


class OpenAIClient:
    """Synchronous OpenAI-compatible completion client."""

    def __init__(self, config: ModelConfig, client: Any | None = None) -> None:
        self._config = config
        # `client` is an injection seam for tests; defaults to a real OpenAI SDK client.
        self._client = client or OpenAI(
            api_key=config.api_key,
            base_url=config.base_url,
            timeout=config.timeout,
        )
        logger.debug("OpenAIClient ready: %r", config)  # repr redacts the key

    @classmethod
    def from_profile(
        cls,
        name: str | None = None,
        path: str | None = None,
    ) -> OpenAIClient:
        """Build a client from a named TOML profile (or ``default_profile``)."""
        return cls(resolve_profile(name=name, path=path))

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> LLMResponse:
        kwargs: dict[str, Any] = {
            "model": self._config.model,
            "messages": messages,
            "temperature": self._config.temperature,
        }
        if self._config.max_tokens is not None:
            kwargs["max_tokens"] = self._config.max_tokens
        if self._config.reasoning_effort:
            kwargs["reasoning_effort"] = self._config.reasoning_effort
        if self._config.extra_body:
            kwargs["extra_body"] = self._config.extra_body
        # Only offer tools when given; omitting both forces a text-only answer.
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        completion = self._client.chat.completions.create(**kwargs)
        return parse_completion(completion)

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> Generator[StreamDelta, None, LLMResponse]:
        """Stream a single assistant turn, yielding deltas and returning the aggregate."""
        kwargs: dict[str, Any] = {
            "model": self._config.model,
            "messages": messages,
            "temperature": self._config.temperature,
            "stream": True,
            # Request a usage summary in the final SSE chunk (OpenAI-compatible).
            "stream_options": {"include_usage": True},
        }
        if self._config.max_tokens is not None:
            kwargs["max_tokens"] = self._config.max_tokens
        if self._config.reasoning_effort:
            kwargs["reasoning_effort"] = self._config.reasoning_effort
        if self._config.extra_body:
            kwargs["extra_body"] = self._config.extra_body
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        # tool_call index -> {id, name, arguments_chunks}
        tc_accum: dict[int, dict[str, Any]] = {}
        last_usage: Any = None

        for chunk in self._client.chat.completions.create(**kwargs):
            # The final chunk from `include_usage` may have empty choices.
            if chunk.usage is not None:
                last_usage = chunk.usage

            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue

            # Reasoning content (provider-specific; e.g. DeepSeek reasoning_content)
            rc = getattr(delta, "reasoning_content", None)
            if rc:
                reasoning_parts.append(rc)
                yield StreamDelta(reasoning=rc)

            # Regular content
            if delta.content:
                content_parts.append(delta.content)
                yield StreamDelta(content=delta.content)

            # Tool call fragments — accumulate, don't yield as deltas
            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx not in tc_accum:
                        tc_accum[idx] = {
                            "id": tc_delta.id or "",
                            "name": getattr(tc_delta.function, "name", "") or "",
                            "arguments": "",
                        }
                    else:
                        if tc_delta.id:
                            tc_accum[idx]["id"] = tc_delta.id
                        if getattr(tc_delta.function, "name", None):
                            tc_accum[idx]["name"] = tc_delta.function.name
                    if getattr(tc_delta.function, "arguments", None):
                        tc_accum[idx]["arguments"] += tc_delta.function.arguments

        full_content = "".join(content_parts) or None
        full_reasoning = "".join(reasoning_parts) or None
        tool_calls = tuple(
            ToolCall(id=v["id"], name=v["name"], arguments=v["arguments"] or "{}")
            for _, v in sorted(tc_accum.items())
        )
        usage = _parse_usage(last_usage)
        return LLMResponse(
            content=full_content,
            tool_calls=tool_calls,
            usage=usage,
            reasoning=full_reasoning,
        )
