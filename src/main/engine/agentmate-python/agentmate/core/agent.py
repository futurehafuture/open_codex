"""The agent ReAct loop — synchronous and streaming variants.

The synchronous ``run`` method remains for tests and simple callers.
``run_stream`` yields typed :class:`AgentEvent` objects so that an SSE endpoint
can forward each thinking chunk, tool call, tool result, and answer token to
the browser in real time.
"""

from __future__ import annotations

import logging
from collections.abc import Generator
from dataclasses import dataclass

from agentmate.config import load_agent_settings
from agentmate.context import compact_history, estimate_chars, trim_for_query
from agentmate.core.events import (
    AgentEvent,
    AnswerDeltaEvent,
    CompactionEvent,
    DoneEvent,
    StepEvent,
    ThinkingEvent,
    ToolCallEvent,
    ToolResultEvent,
    UsageEvent,
)
from agentmate.core.message import (
    Message,
    assistant_message,
    system_message,
    tool_message,
    user_message,
)
from agentmate.core.sanitize import ToolMarkupFilter, strip_tool_markup
from agentmate.llm.base import LLMClient, LLMResponse, StreamingLLMClient
from agentmate.skills.registry import SkillRegistry
from agentmate.tools.executor import ToolExecutor
from agentmate.tools.registry import ToolRegistry

__all__ = ["AgentConfig", "Agent"]

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful assistant. Use tools only when the user's request clearly "
    "requires them. If the request is ambiguous, very short, or only punctuation, "
    "ask a brief clarification question without using tools."
)


@dataclass(frozen=True)
class AgentConfig:
    """Immutable agent settings.

    Attributes:
        system_prompt: Prepended as the first message of every run.
        max_iterations: Max model<->tool round trips before forcing a final
            text answer.
        max_tool_result_chars: P0 — hard cap (characters) on each tool result
            before it enters the message list.  ``None`` disables the global
            cap (individual tools may still have their own via the registry).
        context_char_budget: P1 — total character budget for the message list
            sent to the LLM.  The trimmer projects the list into this budget
            before every call.  Roughly 4 chars ≈ 1 token; 120 000 chars ≈
            30 000 tokens.  Adjust to match your model's context window.
        trim_keep_recent: P1 — number of recent non-system messages always kept
            verbatim (never trimmed, never removed).
        compact_enabled: P2 — whether LLM-based compaction is allowed.
        auto_compact_threshold: P2 — fraction of ``context_char_budget`` at
            which auto-compaction triggers (0 < threshold ≤ 1).
        compact_keep_recent: P2 — non-system messages kept verbatim after
            compaction (the "tail" the model sees in full).
        skill_dirs: Directories scanned for skills (each immediate sub-folder
            with a ``SKILL.md`` is one skill). Later dirs win on name clashes,
            so project dirs should precede user dirs.
        workspace_dir: Sandbox root the ``write_file`` tool may write into.
            Lets a long run persist state/deliverables to disk; the path is
            confined to this directory.
    """

    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    max_iterations: int = 6
    # P0 — tool result budget
    max_tool_result_chars: int = 8_000
    # P1 — trimmer
    context_char_budget: int = 120_000
    trim_keep_recent: int = 6
    # P2 — compactor
    compact_enabled: bool = True
    auto_compact_threshold: float = 0.85
    compact_keep_recent: int = 4
    # Skills — discovery directories (user-level first, project-level last so it wins)
    skill_dirs: tuple[str, ...] = (
        "~/.config/agentmate/skills",
        "./.agentmate/skills",
    )
    # Workspace — sandbox root for the write_file tool's durable outputs.
    workspace_dir: str = "./workspace"

    @classmethod
    def from_toml(cls, path: str | None = None) -> AgentConfig:
        """Build from the ``[agent]`` table in the config file (else defaults)."""
        s = load_agent_settings(path)
        raw_dirs = s.get("skill_dirs")
        skill_dirs = (
            tuple(str(d) for d in raw_dirs)
            if isinstance(raw_dirs, list)
            else cls.skill_dirs
        )
        return cls(
            system_prompt=str(s.get("system_prompt", DEFAULT_SYSTEM_PROMPT)),
            max_iterations=int(s.get("max_iterations", 6)),
            max_tool_result_chars=int(s.get("max_tool_result_chars", 8_000)),
            context_char_budget=int(s.get("context_char_budget", 120_000)),
            trim_keep_recent=int(s.get("trim_keep_recent", 6)),
            compact_enabled=bool(s.get("compact_enabled", True)),
            auto_compact_threshold=float(s.get("auto_compact_threshold", 0.85)),
            compact_keep_recent=int(s.get("compact_keep_recent", 4)),
            skill_dirs=skill_dirs,
            workspace_dir=str(s.get("workspace_dir", cls.workspace_dir)),
        )


class Agent:
    """Drives the reason-act loop over an :class:`LLMClient` and tools."""

    def __init__(
        self,
        llm: LLMClient,
        registry: ToolRegistry,
        executor: ToolExecutor,
        config: AgentConfig | None = None,
        skills: SkillRegistry | None = None,
    ) -> None:
        self._llm = llm
        self._registry = registry
        self._executor = executor
        self._config = config or AgentConfig()
        self._skills = skills
        # Propagate P0 budget to executor at construction time.
        self._executor._default_max_result_chars = self._config.max_tool_result_chars

    def _system_message(self) -> Message:
        """Build the initial system message, appending the skill catalog (L1).

        The catalog is only added to the very first message of a run — it is
        discovery metadata, not per-turn content.
        """
        prompt = self._config.system_prompt
        catalog = self._skills.catalog() if self._skills is not None else ""
        if catalog:
            prompt = f"{prompt}\n\n{catalog}"
        return system_message(prompt)

    def run(self, user_input: str, history: list[Message] | None = None) -> str:
        """Run the loop for one user turn and return the assistant's text answer.

        Args:
            user_input: The new user message.
            history: Prior user/assistant turns for multi-turn chat. The system
                prompt is prepended here, so ``history`` must not include it.
        """
        messages: list[Message] = [self._system_message()]
        if history:
            messages.extend(history)
        messages.append(user_message(user_input))
        tools = self._registry.to_openai_tools() or None

        for step in range(self._config.max_iterations):
            # P2 — auto-compact before calling the LLM when pressure is high.
            messages = self._maybe_compact(messages)
            # P1 — build a read-time projected view that fits the char budget.
            messages_for_query = trim_for_query(
                messages,
                self._config.context_char_budget,
                self._config.trim_keep_recent,
            )
            response = self._llm.complete(messages_for_query, tools)
            messages.append(assistant_message(response))

            if not response.has_tool_calls:
                return strip_tool_markup(response.content or "")

            logger.debug("Step %d: executing %d tool call(s)", step, len(response.tool_calls))
            # One tool message per tool_call_id, all appended before the next call.
            for call in response.tool_calls:
                # P0 is applied inside executor.execute() via _apply_budget().
                result = self._executor.execute(call.name, call.arguments)
                messages.append(tool_message(call.id, result))

        return self._force_final_answer(messages)

    # ------------------------------------------------------------------
    # Context management helpers
    # ------------------------------------------------------------------

    def _should_compact(self, messages: list[Message]) -> bool:
        """Return True when context pressure exceeds the auto-compact threshold."""
        if not self._config.compact_enabled:
            return False
        total = sum(estimate_chars(m) for m in messages)
        threshold = int(self._config.context_char_budget * self._config.auto_compact_threshold)
        return total >= threshold

    def _maybe_compact(self, messages: list[Message]) -> list[Message]:
        """Run P2 compaction synchronously if the threshold is exceeded."""
        if not self._should_compact(messages):
            return messages
        logger.info("Auto-compaction triggered (sync)")
        try:
            new_messages, _ = compact_history(
                messages, self._llm, self._config.compact_keep_recent
            )
            return new_messages
        except ValueError as exc:
            logger.warning("compact_history skipped: %s", exc)
            return messages

    def _maybe_compact_stream(
        self, messages: list[Message]
    ) -> tuple[list[Message], CompactionEvent | None]:
        """Run P2 compaction and return the new list plus an event to emit."""
        if not self._should_compact(messages):
            return messages, None
        logger.info("Auto-compaction triggered (stream)")
        before = len(messages)
        try:
            new_messages, summary = compact_history(
                messages, self._llm, self._config.compact_keep_recent
            )
            evt = CompactionEvent(
                messages_before=before,
                messages_after=len(new_messages),
                summary_chars=len(summary),
            )
            return new_messages, evt
        except ValueError as exc:
            logger.warning("compact_history skipped: %s", exc)
            return messages, None

    def _force_final_answer(self, messages: list[Message]) -> str:
        """Step budget exhausted: ask once more with tools removed to force text."""
        logger.info("Max iterations reached; forcing a final answer without tools.")
        response = self._llm.complete(messages, None)
        messages.append(assistant_message(response))
        return strip_tool_markup(response.content or "") or "Stopped: reached the maximum number of steps."

    # ------------------------------------------------------------------
    # Streaming variant
    # ------------------------------------------------------------------

    def run_stream(
        self,
        user_input: str,
        history: list[Message] | None = None,
    ) -> Generator[AgentEvent, None, None]:
        """Run the ReAct loop, yielding events for each incremental piece.

        Requires the underlying LLM to implement :class:`StreamingLLMClient`.
        Falls back to the synchronous path wrapped in events otherwise.
        """
        if not isinstance(self._llm, StreamingLLMClient):
            answer = self.run(user_input, history=history)
            fallback_messages: list[Message] = [self._system_message()]
            if history:
                fallback_messages.extend(history)
            fallback_messages.append(user_message(user_input))
            fallback_messages.append({"role": "assistant", "content": answer})
            yield AnswerDeltaEvent(delta=answer)
            yield DoneEvent(answer=answer, messages=fallback_messages)
            return

        messages: list[Message] = [self._system_message()]
        if history:
            messages.extend(history)
        messages.append(user_message(user_input))
        tools = self._registry.to_openai_tools() or None

        full_answer_parts: list[str] = []

        for step in range(self._config.max_iterations):
            # P2 — auto-compact before the LLM call when context pressure is high.
            messages, compaction_evt = self._maybe_compact_stream(messages)
            if compaction_evt is not None:
                yield compaction_evt

            # P1 — read-time projection into the char budget.
            messages_for_query = trim_for_query(
                messages,
                self._config.context_char_budget,
                self._config.trim_keep_recent,
            )

            gen = self._llm.stream(messages_for_query, tools)
            response: LLMResponse | None = None
            # Strip leaked tool-call markup (e.g. providers that emit a tool call
            # as plain content) from the streamed answer. Fresh per step.
            content_filter = ToolMarkupFilter()
            try:
                while True:
                    delta = next(gen)
                    if delta.reasoning:
                        yield ThinkingEvent(delta=delta.reasoning)
                    if delta.content:
                        clean = content_filter.feed(delta.content)
                        if clean:
                            yield AnswerDeltaEvent(delta=clean)
                            full_answer_parts.append(clean)
            except StopIteration as exc:
                response = exc.value

            if response is None:
                break

            tail = content_filter.flush()
            if tail:
                yield AnswerDeltaEvent(delta=tail)
                full_answer_parts.append(tail)

            # Emit usage stats so the server can log / display them.
            if response.usage is not None:
                u = response.usage
                yield UsageEvent(
                    prompt_tokens=u.prompt_tokens,
                    completion_tokens=u.completion_tokens,
                    total_tokens=u.total_tokens,
                    cached_tokens=u.cached_tokens,
                    reasoning_tokens=u.reasoning_tokens,
                    step=step,
                )

            messages.append(assistant_message(response))

            if not response.has_tool_calls:
                answer = content_filter.text() or ""
                yield DoneEvent(answer=answer, messages=list(messages))
                return

            # Reset answer parts — content before tool calls was thinking, not final
            full_answer_parts.clear()

            logger.debug("Step %d: executing %d tool call(s)", step, len(response.tool_calls))
            for call in response.tool_calls:
                yield ToolCallEvent(call_id=call.id, name=call.name, arguments=call.arguments)
                # P0 applied inside executor.
                result = self._executor.execute(call.name, call.arguments)
                messages.append(tool_message(call.id, result))
                yield ToolResultEvent(call_id=call.id, name=call.name, result=result)

            # Step boundary: emit a snapshot so a consumer can persist progress
            # incrementally and survive an interrupted run.
            yield StepEvent(step=step, messages=list(messages))

        # Budget exhausted — force final answer (non-streaming for simplicity)
        answer = self._force_final_answer(messages)
        yield AnswerDeltaEvent(delta=answer)
        yield DoneEvent(answer=answer, messages=list(messages))
