"""Builders for OpenAI-format message dicts.

Messages are kept as plain dicts to match the wire format exactly; these
helpers centralize construction so the loop never hand-rolls the structure.
The assistant builder enforces the format's key invariant: an assistant turn
is re-appended *as-is*, carrying its real ``tool_calls`` ids, so the following
``tool`` messages can reference them.
"""

from __future__ import annotations

from typing import Any

from agentmate.llm.base import LLMResponse

__all__ = [
    "Message",
    "system_message",
    "user_message",
    "assistant_message",
    "tool_message",
]

Message = dict[str, Any]


def system_message(content: str) -> Message:
    return {"role": "system", "content": content}


def user_message(content: str) -> Message:
    return {"role": "user", "content": content}


def assistant_message(response: LLMResponse) -> Message:
    """Reconstruct the assistant turn for appending back to the history.

    ``content`` may be ``None`` on a pure tool-call turn (the format allows it).
    The ``tool_calls`` key is included only when present, each entry preserving
    the original id so the matching ``tool`` messages stay valid.

    ``reasoning_content`` is included whenever the model produced reasoning. This
    is required by DeepSeek: an assistant turn that carries ``tool_calls`` must
    echo its ``reasoning_content`` on subsequent requests or the API returns 400.
    On turns without tool calls the field is ignored by the provider, and keeping
    it also lets the thinking be persisted with the session history.
    """
    message: Message = {"role": "assistant", "content": response.content}
    if response.reasoning:
        message["reasoning_content"] = response.reasoning
    if response.has_tool_calls:
        message["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": call.arguments},
            }
            for call in response.tool_calls
        ]
    return message


def tool_message(tool_call_id: str, content: str) -> Message:
    """One tool result, keyed to the call it answers (one per ``tool_call_id``)."""
    return {"role": "tool", "tool_call_id": tool_call_id, "content": content}
