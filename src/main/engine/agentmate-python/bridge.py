"""JSONL stdio bridge: Electron main process ↔ agentmate Agent.

Protocol (one JSON object per line, stdin/stdout):

Input (stdin):
  {"type":"start","session_id":"...","config":{"model":"...","base_url":"...","api_key":"...","workspace_dir":"..."},"prompt":"..."}
  {"type":"cancel","session_id":"..."}

Output (stdout):
  {"type":"thinking","item_id":"...","delta":"..."}
  {"type":"answer_delta","item_id":"...","delta":"..."}
  {"type":"tool_call","item_id":"...","call_id":"...","name":"...","arguments":"..."}
  {"type":"tool_result","item_id":"...","call_id":"...","name":"...","result":"..."}
  {"type":"usage","prompt_tokens":100,"completion_tokens":50,...}
  {"type":"done","answer":"...","messages":[...]}
  {"type":"error","message":"..."}

All Python logging goes to stderr (never stdout), so the JS adapter can safely
read one JSON object per line from stdout without interference.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import traceback
from typing import Any

# Add the agentmate package to the import path (sibling directory).
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

from agentmate import Agent, OpenAIClient, ToolRegistry, ToolExecutor
from agentmate.config import ModelConfig
from agentmate.tools.builtin import register_web_fetch, register_web_search
from agentmate.tools.files import register_write_file
from agentmate.core.agent import AgentConfig

# ── helpers ──────────────────────────────────────────────────────────────


def _write(obj: dict[str, Any]) -> None:
    """Write one JSON line to stdout and flush immediately."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    """Log diagnostic info to stderr (never stdout)."""
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


def _build_agent(cfg: dict[str, Any]) -> Agent:
    """Construct an Agent instance from the config dict sent by Electron."""
    model = cfg.get("model") or os.environ.get("AGENTMATE_MODEL", "gpt-4o")
    base_url = cfg.get("base_url") or os.environ.get("AGENTMATE_BASE_URL", "")
    api_key = cfg.get("api_key") or os.environ.get("AGENTMATE_API_KEY") or os.environ.get("OPENAI_API_KEY", "")
    workspace_dir = cfg.get("workspace_dir") or os.path.join(os.getcwd(), "workspace")

    model_config = ModelConfig(
        model=model,
        base_url=base_url or None,
        api_key=api_key or None,
        temperature=0.2,
        timeout=120,
    )
    _log(f"model={model} base_url={base_url} workspace={workspace_dir}")

    registry = ToolRegistry()
    register_web_search(registry)
    register_web_fetch(registry)
    register_write_file(registry, workspace_dir)
    executor = ToolExecutor(registry)

    llm = OpenAIClient(model_config)

    agent_config = AgentConfig(
        system_prompt=cfg.get("system_prompt") or (
            "You are a helpful coding assistant. Use tools only when the user's "
            "request clearly requires current external information, file access, "
            "or code changes. If the request is ambiguous, very short, or only "
            "punctuation, ask a brief clarification question without using tools. "
            "Always respond in the user's language."
        ),
        max_iterations=cfg.get("max_iterations", 12),
        max_tool_result_chars=cfg.get("max_tool_result_chars", 8000),
        context_char_budget=cfg.get("context_char_budget", 120000),
        workspace_dir=workspace_dir,
    )

    return Agent(llm, registry, executor, agent_config)


def _resume_history(messages: list[Any]) -> list[Any]:
    """Prior messages to feed back as ``history`` when continuing a turn.

    Mirrors agentmate.server.app._resume_history: the agent prepends its own
    system prompt each run, so a leading system message in the stored record is
    dropped to avoid duplicating it.
    """
    if messages and messages[0].get("role") == "system":
        return messages[1:]
    return messages


# ── main loop ────────────────────────────────────────────────────────────

_agent: Agent | None = None
_cancelled: bool = False
# Monotonic turn counter. Item ids are scoped per turn so a new turn never
# overwrites the previous turn's answer/reasoning/tool blocks (the renderer and
# the store both key items by id).
_turn: int = 0
# Conversation record for multi-turn memory. We store the FULL message list the
# agent builds (system included), exactly like agentmate's own server
# (server/app.py): updated from StepEvent/DoneEvent.messages, and fed back via
# run_stream(history=_resume_history(...)). This makes our multi-turn identical
# to the framework's native multi-turn. Reset when the agent is (re)built.
_session_messages: list[Any] = []


def _handle_sigterm(signum: int, frame: Any) -> None:
    global _cancelled
    _cancelled = True
    _log("received SIGTERM, cancelling")


signal.signal(signal.SIGTERM, _handle_sigterm)


def main() -> None:
    global _agent, _cancelled, _session_messages
    _log("bridge started, waiting for input on stdin")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            _log(f"invalid JSON on stdin: {exc}")
            continue

        msg_type = msg.get("type", "")

        if msg_type == "start":
            _cancelled = False
            session_id = msg.get("session_id", "main")
            cfg = msg.get("config", {})
            prompt = msg.get("prompt", "")

            # Build (or rebuild) the agent only when config is supplied, or when
            # none exists yet. `startSession` always sends a `config` dict;
            # `sendPrompt` deliberately OMITS `config` so the running agent (and
            # its credentials) is reused across turns. Do not add `config` to the
            # per-turn prompt message or this reuse — and the credentials — break.
            if cfg or _agent is None:
                try:
                    _agent = _build_agent(cfg)
                except Exception as exc:
                    _write({"type": "error", "session_id": session_id, "message": f"Agent init failed: {exc}"})
                    continue
                # Initialise the conversation record from the provided history
                # (when resuming) or start fresh.
                _session_messages = list(msg.get("history", []))
                _write({"type": "thread_started", "session_id": session_id})

            # Only run a turn when there is an actual prompt. Opening or resuming
            # a session must never auto-generate a reply.
            if (prompt or "").strip():
                try:
                    _run_stream(session_id, prompt)
                except Exception as exc:
                    if not _cancelled:
                        _write({"type": "error", "session_id": session_id, "message": str(exc)})
                        traceback.print_exc(file=sys.stderr)

        elif msg_type == "cancel":
            _cancelled = True
            _log(f"cancel requested for session {msg.get('session_id')}")

        elif msg_type == "shutdown":
            _log("shutdown requested")
            break

    _log("bridge exiting")


def _run_stream(session_id: str, prompt: str) -> None:
    global _cancelled, _turn, _session_messages

    _turn += 1
    turn = _turn
    item_ids: dict[str, str] = {}  # call_id → item_id
    next_id = _next_id_counter()
    # Monotonic sequence so the renderer/store can restore chronological order
    # regardless of when each "completed" event is flushed to stdout / persisted.
    _seq = 0
    def _seq_next() -> int:
        nonlocal _seq
        _seq += 1
        return _seq

    # Per-step state — reset on each step boundary so every agent iteration
    # (think → tools → think → tools → … → final answer) produces its own
    # reasoning block.  Reasoning is flushed as *completed* at the first tool
    # call of a step (not at StepEvent) so the persistence order matches the
    # chronological order — reasoning before tool results.
    cur_step = 0
    reasoning_parts: list[str] = []
    reasoning_flushed: bool = False  # true once this step's reasoning was emitted as completed
    # The agent discards answer content that precedes tool calls (it's
    # "thinking out loud"), so we only emit AnswerDelta events for the
    # final answer.  We still accumulate per-step so we can discard at
    # step boundaries.
    answer_parts: list[str] = []

    reasoning_iid = f"reasoning-{session_id}-{turn}-{cur_step}"
    msg_iid = f"msg-{session_id}-{turn}"
    final_answer = ""
    done_seen = False

    # Feed prior turns back as history (system stripped) — the framework's
    # native multi-turn contract, identical to agentmate.server.app.
    history = _resume_history(_session_messages)

    for event in _agent.run_stream(prompt, history=history):
        if _cancelled:
            _write({"type": "turn_failed", "session_id": session_id, "message": "Cancelled"})
            return

        kind = type(event).__name__

        if kind == "ThinkingEvent":
            reasoning_parts.append(event.delta)
            _write({"type": "item", "session_id": session_id, "phase": "updated",
                    "item": {"id": reasoning_iid, "type": "reasoning",
                             "text": "".join(reasoning_parts), "status": "in_progress"}})

        elif kind == "AnswerDeltaEvent":
            # Buffer silently — intermediate-step deltas are "thinking out loud"
            # that the agent discards when tool calls follow.  Only the final
            # step's answer (the one before DoneEvent) is emitted, and we flush
            # it all at once at DoneEvent to keep the DOM insertion order right.
            answer_parts.append(event.delta)

        elif kind == "ToolCallEvent":
            # The reasoning for this step is finished — flush it as completed
            # *before* the tool call so the persistence (and history replay)
            # matches the chronological order: reasoning → tool → reasoning → …
            if reasoning_parts and not reasoning_flushed:
                _write({"type": "item", "session_id": session_id, "phase": "completed",
                        "item": {"id": reasoning_iid, "type": "reasoning",
                                 "text": "".join(reasoning_parts), "status": "completed",
                                 "_seq": _seq_next()}})
                reasoning_flushed = True
                # Advance to a fresh reasoning id for the *next* thinking burst
                # so the renderer creates a new block after this tool call.
                cur_step += 1
                reasoning_parts = []
                reasoning_iid = f"reasoning-{session_id}-{turn}-{cur_step}"

            item_id = f"tool-{session_id}-{turn}-{next(next_id)}"
            item_ids[event.call_id] = item_id
            _write({"type": "item", "session_id": session_id, "phase": "started",
                    "item": {"id": item_id, "type": "mcp_tool_call",
                             "command": event.name, "text": event.arguments,
                             "status": "in_progress"}})

        elif kind == "ToolResultEvent":
            item_id = item_ids.get(event.call_id, f"tool-{session_id}-{turn}-{next(next_id)}")
            _write({"type": "item", "session_id": session_id, "phase": "completed",
                    "item": {"id": item_id, "type": "mcp_tool_call",
                             "command": event.name, "text": event.result,
                             "status": "completed", "_seq": _seq_next()}})

        elif kind == "UsageEvent":
            _write({"type": "item", "session_id": session_id, "phase": "completed",
                    "item": {"id": f"usage-{session_id}-{turn}-{event.step}",
                             "type": "agent_message", "text": "",
                             "status": "completed", "_seq": _seq_next()},
                    "usage": {"prompt_tokens": event.prompt_tokens,
                              "completion_tokens": event.completion_tokens,
                              "total_tokens": event.total_tokens}})

        elif kind == "DoneEvent":
            done_seen = True
            final_answer = event.answer or "".join(answer_parts)
            # Authoritative conversation record for the next turn's history.
            _session_messages = list(event.messages)
            _write({"type": "turn_completed", "session_id": session_id,
                    "answer": final_answer, "messages": event.messages})

        elif kind == "CompactionEvent":
            _log(f"history compacted: {event.summary_chars} chars summary")

        elif kind == "StepEvent":
            # Flush reasoning if it wasn't already flushed (safety net: should
            # normally have been flushed at the first ToolCallEvent).
            if reasoning_parts and not reasoning_flushed:
                _write({"type": "item", "session_id": session_id, "phase": "completed",
                        "item": {"id": reasoning_iid, "type": "reasoning",
                                 "text": "".join(reasoning_parts), "status": "completed",
                                 "_seq": _seq_next()}})
            # Discard intermediate answer text — the agent cleared its own
            # accumulator (full_answer_parts) because this step ended with
            # tool calls, not the final answer.
            answer_parts = []
            # Incremental checkpoint: keep the record current so a turn that
            # is interrupted before DoneEvent still carries its progress.
            _session_messages = list(event.messages)
            # Start a fresh reasoning item if not already advanced at ToolCallEvent.
            if reasoning_flushed:
                reasoning_flushed = False
            else:
                cur_step += 1
            reasoning_parts = []
            reasoning_iid = f"reasoning-{session_id}-{turn}-{cur_step}"

    # Final flush — emit reasoning then the full answer in their terminal state
    # so the replayed conversation keeps the complete text in natural order.
    answer_text = "".join(answer_parts) or final_answer
    if reasoning_parts:
        _write({"type": "item", "session_id": session_id, "phase": "completed",
                "item": {"id": reasoning_iid, "type": "reasoning",
                         "text": "".join(reasoning_parts), "status": "completed",
                         "_seq": _seq_next()}})
    _write({"type": "item", "session_id": session_id, "phase": "completed",
            "item": {"id": msg_iid, "type": "agent_message",
                     "text": answer_text, "status": "completed",
                     "_seq": _seq_next()}})
    if not done_seen:
        _write({"type": "turn_completed", "session_id": session_id, "answer": answer_text})


def _next_id_counter():
    n = 1
    while True:
        yield n
        n += 1


if __name__ == "__main__":
    main()
