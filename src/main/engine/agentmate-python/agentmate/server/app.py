"""Web server with SSE streaming, session persistence, and history sidebar.

Endpoints:
- ``GET  /``                   Serve the chat UI
- ``POST /api/chat``           Synchronous fallback (original)
- ``POST /api/chat/stream``    SSE streaming with full event trace
- ``GET  /api/sessions``       List all sessions (for sidebar)
- ``GET  /api/sessions/{id}``  Load one session's raw OpenAI message list
- ``DELETE /api/sessions/{id}`` Delete a session
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from agentmate.core.agent import Agent, AgentConfig
from agentmate.core.events import (
    AnswerDeltaEvent,
    CompactionEvent,
    DoneEvent,
    StepEvent,
    ThinkingEvent,
    ToolCallEvent,
    ToolResultEvent,
    UsageEvent,
)
from agentmate.core.message import Message, user_message
from agentmate.llm.openai_client import OpenAIClient
from agentmate.skills.registry import SkillRegistry
from agentmate.skills.tools import register_skill_tools
from agentmate.tools.builtin import register_web_fetch, register_web_search
from agentmate.tools.executor import ToolExecutor
from agentmate.tools.files import register_write_file
from agentmate.tools.registry import ToolRegistry

__all__ = ["create_app", "build_default_agent", "app"]

logger = logging.getLogger(__name__)

_STATIC_DIR = Path(__file__).resolve().parent / "static"
_DATA_DIR = Path.cwd() / ".agentmate_sessions"


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class ChatResponse(BaseModel):
    answer: str
    session_id: str


def _ensure_data_dir() -> Path:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    return _DATA_DIR


def _find_session_file(session_id: str) -> Path | None:
    """Locate a session's file anywhere under the data dir (date subfolders)."""
    if not _DATA_DIR.is_dir():
        return None
    return next(_DATA_DIR.rglob(f"{session_id}.json"), None)


def _session_path(session_id: str) -> Path:
    """Where to write a session: reuse its existing file, else today's folder.

    Sessions are filed under a ``YYYY-MM-DD`` folder of their first save, so the
    sidebar is easy to scan by day. Keeping a session in that one file means
    resuming it later overwrites in place rather than scattering daily copies.
    """
    existing = _find_session_file(session_id)
    if existing is not None:
        return existing
    folder = _ensure_data_dir() / time.strftime("%Y-%m-%d")
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{session_id}.json"


def _save_session(session_id: str, title: str, messages: list[Message]) -> None:
    """Persist the session as the raw OpenAI message list (first-hand record).

    Called incrementally (once per completed step) as well as on completion, so
    an interrupted run still leaves the work done so far on disk.
    """
    path = _session_path(session_id)
    data = {
        "session_id": session_id,
        "title": title,
        "updated_at": time.time(),
        "messages": messages,
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def _resume_history(messages: list[Message]) -> list[Message]:
    """Prior messages to feed back as ``history`` when continuing a session.

    The agent prepends its own system prompt each run, so a leading system
    message in the saved record is dropped to avoid duplicating it.
    """
    if messages and messages[0].get("role") == "system":
        return messages[1:]
    return messages


def _session_title(messages: list[Message], fallback: str) -> str:
    """Title a session by its first user message."""
    for m in messages:
        if m.get("role") == "user":
            return str(m.get("content", ""))[:60]
    return fallback[:60]


def _load_session(session_id: str) -> dict[str, Any] | None:
    path = _find_session_file(session_id)
    if path is None:
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _list_sessions() -> list[dict[str, Any]]:
    if not _DATA_DIR.is_dir():
        return []
    sessions = []
    for f in sorted(_DATA_DIR.rglob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(f.read_text())
            sessions.append({
                "session_id": data["session_id"],
                "title": data.get("title", "Untitled"),
                "updated_at": data.get("updated_at", 0),
            })
        except (json.JSONDecodeError, KeyError, OSError):
            continue
    return sessions


def build_default_agent() -> Agent:
    """Assemble an agent from the default profile with web + skill tools."""
    config = AgentConfig.from_toml()
    registry = ToolRegistry()
    register_web_search(registry)
    register_web_fetch(registry)
    register_write_file(registry, config.workspace_dir)
    skill_dirs = [Path(d).expanduser() for d in config.skill_dirs]
    skills = SkillRegistry.from_dirs(skill_dirs)
    register_skill_tools(registry, skills)
    executor = ToolExecutor(registry)
    llm = OpenAIClient.from_profile()
    return Agent(llm, registry, executor, config, skills=skills)


def create_app(agent: Agent | None = None) -> FastAPI:
    """Create the FastAPI app. Pass ``agent`` to inject one (e.g. in tests)."""
    app = FastAPI(title="agentmate")
    session_messages: dict[str, list[Message]] = {}
    _agent = agent

    def get_agent() -> Agent:
        nonlocal _agent
        if _agent is None:
            _agent = build_default_agent()
        return _agent

    def _get_messages(session_id: str) -> list[Message]:
        if session_id in session_messages:
            return session_messages[session_id]
        saved = _load_session(session_id)
        messages = saved.get("messages", []) if saved else []
        session_messages[session_id] = messages
        return messages

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_STATIC_DIR / "index.html")

    @app.post("/api/chat")
    def chat(request: ChatRequest) -> JSONResponse:
        session_id = request.session_id or uuid4().hex
        prior = _get_messages(session_id)
        try:
            answer = get_agent().run(request.message, history=_resume_history(prior))
        except Exception as exc:
            logger.exception("Agent run failed")
            return JSONResponse(status_code=502, content={"error": str(exc)})

        # Sync path has no step trace; append the user turn and final answer.
        messages = [
            *prior,
            user_message(request.message),
            {"role": "assistant", "content": answer},
        ]
        session_messages[session_id] = messages
        _save_session(session_id, _session_title(messages, request.message), messages)
        return JSONResponse(
            content=ChatResponse(answer=answer, session_id=session_id).model_dump()
        )

    @app.post("/api/chat/stream")
    async def chat_stream(request: ChatRequest, req: Request) -> EventSourceResponse:
        session_id = request.session_id or uuid4().hex
        history = _resume_history(_get_messages(session_id))
        agent = get_agent()

        async def event_generator():
            yield {"event": "session", "data": json.dumps({"session_id": session_id})}

            # Live SSE events (thinking/tool/usage) drive the real-time UI. The
            # session record is the raw OpenAI message list the agent builds; it
            # is persisted incrementally on each StepEvent (so an interrupted run
            # survives) and authoritatively on the DoneEvent.
            answer_parts: list[str] = []
            latest_messages: list[Message] | None = None

            try:
                for evt in agent.run_stream(request.message, history=list(history)):
                    if await req.is_disconnected():
                        # Client went away mid-run: persist what we have so far.
                        if latest_messages is not None:
                            _save_session(
                                session_id,
                                _session_title(latest_messages, request.message),
                                latest_messages,
                            )
                        break

                    if isinstance(evt, ThinkingEvent):
                        yield {"event": "thinking", "data": json.dumps({"delta": evt.delta}, ensure_ascii=False)}

                    elif isinstance(evt, ToolCallEvent):
                        payload = {"call_id": evt.call_id, "name": evt.name, "arguments": evt.arguments}
                        yield {"event": "tool_call", "data": json.dumps(payload, ensure_ascii=False)}

                    elif isinstance(evt, ToolResultEvent):
                        payload = {"call_id": evt.call_id, "name": evt.name, "result": evt.result}
                        yield {"event": "tool_result", "data": json.dumps(payload, ensure_ascii=False)}

                    elif isinstance(evt, UsageEvent):
                        payload = {
                            "step": evt.step,
                            "prompt_tokens": evt.prompt_tokens,
                            "completion_tokens": evt.completion_tokens,
                            "total_tokens": evt.total_tokens,
                            "cached_tokens": evt.cached_tokens,
                            "reasoning_tokens": evt.reasoning_tokens,
                        }
                        yield {"event": "usage", "data": json.dumps(payload)}

                    elif isinstance(evt, CompactionEvent):
                        payload = {
                            "messages_before": evt.messages_before,
                            "messages_after": evt.messages_after,
                            "summary_chars": evt.summary_chars,
                        }
                        yield {"event": "compaction", "data": json.dumps(payload)}

                    elif isinstance(evt, AnswerDeltaEvent):
                        answer_parts.append(evt.delta)
                        yield {"event": "answer", "data": json.dumps({"delta": evt.delta}, ensure_ascii=False)}

                    elif isinstance(evt, StepEvent):
                        # Incremental checkpoint: overwrite the session record so
                        # progress survives an interrupt before the final answer.
                        latest_messages = list(evt.messages)
                        session_messages[session_id] = latest_messages
                        _save_session(
                            session_id,
                            _session_title(latest_messages, request.message),
                            latest_messages,
                        )
                        yield {"event": "step", "data": json.dumps({"step": evt.step})}

                    elif isinstance(evt, DoneEvent):
                        full_answer = evt.answer or "".join(answer_parts)
                        messages = list(evt.messages)
                        session_messages[session_id] = messages
                        _save_session(
                            session_id, _session_title(messages, request.message), messages
                        )

                        yield {
                            "event": "done",
                            "data": json.dumps({"answer": full_answer, "session_id": session_id}, ensure_ascii=False),
                        }

            except Exception as exc:
                logger.exception("Streaming agent run failed")
                yield {
                    "event": "error",
                    "data": json.dumps({"error": str(exc)}, ensure_ascii=False),
                }

        return EventSourceResponse(event_generator())

    @app.get("/api/sessions")
    def list_sessions() -> JSONResponse:
        return JSONResponse(content=_list_sessions())

    @app.get("/api/sessions/{session_id}")
    def get_session(session_id: str) -> JSONResponse:
        data = _load_session(session_id)
        if data is None:
            return JSONResponse(status_code=404, content={"error": "Session not found"})
        return JSONResponse(content=data)

    @app.delete("/api/sessions/{session_id}")
    def delete_session(session_id: str) -> JSONResponse:
        path = _find_session_file(session_id)
        session_messages.pop(session_id, None)
        if path is not None and path.is_file():
            path.unlink()
        return JSONResponse(content={"ok": True})

    return app


app = create_app()
