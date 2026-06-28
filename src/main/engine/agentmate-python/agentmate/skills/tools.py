"""Skill-aware tools registered into the agent's :class:`ToolRegistry`.

* ``Skill(name)``               — Level 2: load a skill's instruction body.
* ``read_file(skill, path)``    — Level 3: read a bundled resource/sub-file.
* ``run_script(skill, script)`` — Level 3: run a bundled script and return only
  its output (the script code never enters context).

Security model for ``run_script`` (decided up front): only files that already
live inside the loaded skill's directory may run; the interpreter is chosen by
extension; arguments are passed as an argv list with ``shell=False`` so there is
no shell to inject into; the working directory is pinned to the skill folder;
output is time- and size-bounded.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path

from agentmate.skills.registry import SkillRegistry
from agentmate.tools.registry import ToolRegistry

__all__ = ["register_skill_tools", "SKILL_RESULT_MAX_CHARS"]

logger = logging.getLogger(__name__)

# Skill bodies/resources routinely exceed the default 8k tool-result cap, so
# these tools opt into a much larger explicit budget (still bounded so a giant
# file cannot blow the context window).
SKILL_RESULT_MAX_CHARS = 100_000

_SCRIPT_TIMEOUT_SECONDS = 30
_INTERPRETERS: dict[str, list[str]] = {
    ".py": [sys.executable],
    ".sh": ["bash"],
}


def register_skill_tools(
    tool_registry: ToolRegistry,
    skills: SkillRegistry,
    script_timeout: int = _SCRIPT_TIMEOUT_SECONDS,
) -> None:
    """Register the ``Skill``/``read_file``/``run_script`` tools.

    No-op-friendly: register even when no skills are installed so the model gets
    a clear "unknown skill" message rather than a missing-tool error.
    """

    def _skill(name: str) -> str:
        body = skills.body(name)
        if body is None:
            return f"Error: unknown skill '{name}'. Known: {', '.join(skills.names()) or 'none'}."
        return body

    tool_registry.register(
        name="Skill",
        description=(
            "Load the full instructions for an available skill by name. Call "
            "this when the user's request matches a skill listed under "
            "'Available Skills' before doing the task."
        ),
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The skill name to load."}
            },
            "required": ["name"],
        },
        fn=_skill,
        max_result_chars=SKILL_RESULT_MAX_CHARS,
    )

    def _read_file(skill: str, path: str) -> str:
        try:
            target = skills.resolve_path(skill, path)
        except KeyError:
            return f"Error: unknown skill '{skill}'."
        except ValueError as exc:
            return f"Error: {exc}."
        try:
            return target.read_text(encoding="utf-8")
        except OSError as exc:
            return f"Error: cannot read {path!r} ({exc})."

    tool_registry.register(
        name="read_file",
        description=(
            "Read a file bundled inside a skill (e.g. REFERENCE.md or a "
            "resource). Only files inside the skill's own directory are allowed."
        ),
        parameters={
            "type": "object",
            "properties": {
                "skill": {"type": "string", "description": "Skill name that owns the file."},
                "path": {"type": "string", "description": "Path relative to the skill directory."},
            },
            "required": ["skill", "path"],
        },
        fn=_read_file,
        max_result_chars=SKILL_RESULT_MAX_CHARS,
    )

    def _run_script(skill: str, script: str, args: list[str] | None = None) -> str:
        try:
            target = skills.resolve_path(skill, script)
        except KeyError:
            return f"Error: unknown skill '{skill}'."
        except ValueError as exc:
            return f"Error: {exc}."
        interp = _INTERPRETERS.get(target.suffix)
        if interp is None:
            return (
                f"Error: unsupported script type {target.suffix!r}; "
                f"supported: {', '.join(sorted(_INTERPRETERS))}."
            )
        argv = [*interp, str(target), *(_string_args(args))]
        return _run(argv, cwd=target.parent, timeout=script_timeout)

    tool_registry.register(
        name="run_script",
        description=(
            "Run a script bundled inside a skill and return its output. Only "
            "scripts inside the skill's own directory can run (.py or .sh)."
        ),
        parameters={
            "type": "object",
            "properties": {
                "skill": {"type": "string", "description": "Skill name that owns the script."},
                "script": {"type": "string", "description": "Script path relative to the skill directory."},
                "args": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional command-line arguments.",
                },
            },
            "required": ["skill", "script"],
        },
        fn=_run_script,
        max_result_chars=SKILL_RESULT_MAX_CHARS,
    )


def _string_args(args: list[str] | None) -> list[str]:
    if not args:
        return []
    return [str(a) for a in args]


def _run(argv: list[str], cwd: Path, timeout: int) -> str:
    """Execute ``argv`` with no shell; return combined stdout/stderr + exit code."""
    try:
        proc = subprocess.run(  # noqa: S603 — argv list, shell=False, no user shell string
            argv,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return f"Error: script timed out after {timeout}s."
    except OSError as exc:
        return f"Error: failed to run script ({exc})."
    out = proc.stdout or ""
    err = proc.stderr or ""
    tail = f"\n[stderr]\n{err}" if err.strip() else ""
    return f"[exit {proc.returncode}]\n{out}{tail}".rstrip()
