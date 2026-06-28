"""Tool executor: turns a model-requested call into a result string.

Contract (locked by design): :meth:`ToolExecutor.execute` NEVER raises. Every
failure mode — unknown tool, unparseable JSON arguments, an exception inside
the tool — becomes a string fed back to the model so it can recover on the next
turn. The agent loop therefore needs no try/except around tool execution.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agentmate.context.budget import truncate_result
from agentmate.tools.registry import ToolRegistry

__all__ = ["ToolExecutor"]

logger = logging.getLogger(__name__)


class ToolExecutor:
    def __init__(
        self,
        registry: ToolRegistry,
        default_max_result_chars: int | None = None,
    ) -> None:
        """Create a ToolExecutor.

        Args:
            registry: Tool registry to look up specs and callables.
            default_max_result_chars: Agent-level result size cap applied when
                a tool's own ``max_result_chars`` is ``None``. ``None`` here
                means no global cap (individual tools may still have their own).
        """
        self._registry = registry
        self._default_max_result_chars = default_max_result_chars

    def execute(self, name: str, arguments: str) -> str:
        """Run tool ``name`` with raw JSON ``arguments``; return a result string.

        Args:
            name: Tool name as requested by the model.
            arguments: Raw JSON string of arguments from the model.

        Returns:
            The tool result stringified, or an ``Error: ...`` message that is
            safe to hand back to the model.
        """
        spec = self._registry.get(name)
        if spec is None:
            logger.warning("Unknown tool requested: %s", name)
            return f"Error: unknown tool '{name}'."

        try:
            parsed: Any = json.loads(arguments) if arguments else {}
        except json.JSONDecodeError as exc:
            logger.warning("Bad JSON arguments for tool %s: %s", name, exc)
            return f"Error: arguments are not valid JSON ({exc})."

        if not isinstance(parsed, dict):
            return "Error: arguments must be a JSON object."

        try:
            result = spec.fn(**parsed)
        except TypeError as exc:
            logger.warning("Bad arguments for tool %s: %s", name, exc)
            return f"Error: invalid arguments for '{name}' ({exc})."
        except Exception as exc:  # tool body failed; surface, don't crash the loop
            logger.exception("Tool %s raised", name)
            return f"Error: tool '{name}' failed ({exc})."

        return self._apply_budget(spec.name, self._stringify(result), spec.max_result_chars)

    def _apply_budget(
        self, tool_name: str, result: str, tool_max: int | None
    ) -> str:
        """Apply the most specific non-None char cap, or return result as-is."""
        cap = tool_max if tool_max is not None else self._default_max_result_chars
        if cap is None or len(result) <= cap:
            return result
        logger.debug(
            "Tool '%s' result truncated: %d → %d chars", tool_name, len(result), cap
        )
        return truncate_result(result, cap)

    @staticmethod
    def _stringify(result: Any) -> str:
        if isinstance(result, str):
            return result
        try:
            return json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(result)
