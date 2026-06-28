"""Tool registry: holds callable tools and renders their OpenAI schemas.

This slice takes explicit JSON Schema per tool. Generating schema from type
hints and docstrings (the ``@tool`` decorator promised in the README) is a
later slice that will build on top of :meth:`ToolRegistry.register`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

__all__ = ["ToolFn", "ToolSpec", "ToolRegistry"]

ToolFn = Callable[..., Any]


@dataclass(frozen=True)
class ToolSpec:
    """A registered tool: identity, JSON Schema for its args, and the callable.

    Attributes:
        name: Unique tool name used in model requests.
        description: Human-readable description sent to the model.
        parameters: JSON Schema for the tool's arguments.
        fn: The Python callable that implements the tool.
        max_result_chars: Hard cap on result length (characters). Results that
            exceed this are truncated via :func:`~agentmate.context.budget.truncate_result`.
            ``None`` means no limit (the tool is exempt from budget enforcement).
    """

    name: str
    description: str
    parameters: dict[str, Any]
    fn: ToolFn
    max_result_chars: int | None = None


class ToolRegistry:
    """Name-keyed collection of tools the agent may invoke."""

    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
        fn: ToolFn,
        max_result_chars: int | None = None,
    ) -> None:
        """Register a tool. Raises on duplicate names to fail loud at setup.

        Args:
            name: Unique tool name.
            description: Description sent to the model.
            parameters: JSON Schema for the arguments.
            fn: Python callable that implements the tool.
            max_result_chars: Optional per-tool result size cap. Overrides the
                agent-level ``max_tool_result_chars`` when set. Pass ``None``
                to inherit the agent default (recommended for most tools).
        """
        if name in self._tools:
            raise ValueError(f"Tool already registered: {name}")
        self._tools[name] = ToolSpec(
            name=name,
            description=description,
            parameters=parameters,
            fn=fn,
            max_result_chars=max_result_chars,
        )

    def get(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    def to_openai_tools(self) -> list[dict[str, Any]]:
        """Render all tools as OpenAI function-calling tool schemas."""
        return [
            {
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.parameters,
                },
            }
            for spec in self._tools.values()
        ]
