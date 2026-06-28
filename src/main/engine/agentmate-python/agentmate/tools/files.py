"""Local filesystem tools: durable workspace writes.

``write_file`` lets the agent persist state and deliverables to disk so a
long-horizon run survives context compaction — the agent's progress lives in
files, not only in the message history. Writes are confined to a single
*workspace* directory via the same path-traversal guard the skill loader uses,
so the model cannot write outside the sandbox.

Like the Tavily tools in :mod:`agentmate.tools.builtin`, the public callable
returns an ``Error: ...`` string on expected failures instead of raising, so a
bad path never aborts the agent loop.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from agentmate.tools.registry import ToolRegistry

__all__ = [
    "write_file",
    "register_write_file",
    "WRITE_FILE_SCHEMA",
    "MAX_WRITE_CHARS",
]

logger = logging.getLogger(__name__)

# Generous cap: a 万字 report is ~30-60 KB; this stops a runaway write from
# filling the disk while leaving plenty of headroom for real documents.
MAX_WRITE_CHARS = 2_000_000

WRITE_FILE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "path": {
            "type": "string",
            "description": (
                "Destination path relative to the workspace directory, e.g. "
                "'deep-research/topic/report.md'. Parent folders are created "
                "automatically. Absolute paths and '..' escapes are rejected."
            ),
        },
        "content": {
            "type": "string",
            "description": "The full text to write (overwrites any existing file).",
        },
    },
    "required": ["path", "content"],
}


def _safe_target(workspace_dir: Path, path: str) -> Path:
    """Resolve ``path`` inside ``workspace_dir``; raise ``ValueError`` if it escapes.

    Mirrors :meth:`SkillRegistry.resolve_path`: an absolute path or ``..`` that
    would land outside the workspace root is refused.
    """
    if not path or not path.strip():
        raise ValueError("path must be non-empty")
    base = workspace_dir.resolve()
    target = (base / path).resolve()
    if base != target and base not in target.parents:
        raise ValueError(f"path {path!r} escapes the workspace directory")
    return target


def write_file(path: str, content: str, workspace_dir: Path) -> str:
    """Write ``content`` to ``path`` inside ``workspace_dir`` (overwriting).

    Args:
        path: Destination relative to the workspace root. Parent dirs are made.
        content: Text to write (UTF-8).
        workspace_dir: The sandbox root all writes are confined to.

    Returns:
        A confirmation like ``"Wrote 1234 chars to deep-research/x/report.md
        (absolute path: /abs/workspace/deep-research/x/report.md)"``, or an
        ``Error: ...`` string safe to feed back to the model (this function
        does not raise on expected failures). The absolute path is included so
        a follow-up ``run_script`` step (e.g. converting the report to .docx)
        can be handed a path it can open from any working directory.
    """
    if len(content) > MAX_WRITE_CHARS:
        return (
            f"Error: content too long ({len(content)} chars > limit "
            f"{MAX_WRITE_CHARS}); split it across files."
        )
    try:
        target = _safe_target(workspace_dir, path)
    except ValueError as exc:
        return f"Error: {exc}."
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except OSError as exc:
        logger.warning("write_file failed for %s: %s", path, exc)
        return f"Error: cannot write {path!r} ({exc})."
    rel = target.relative_to(workspace_dir.resolve())
    return f"Wrote {len(content)} chars to {rel} (absolute path: {target})"


def register_write_file(registry: ToolRegistry, workspace_dir: Path | str) -> None:
    """Register :func:`write_file` under the name ``write_file``.

    ``workspace_dir`` is the sandbox root bound into the tool; every write is
    confined to it. The directory is created lazily on the first successful
    write, so registering it costs nothing if the tool is never used.
    """
    root = Path(workspace_dir).expanduser()

    def _write_file(path: str, content: str) -> str:
        return write_file(path, content, workspace_dir=root)

    registry.register(
        name="write_file",
        description=(
            "Write text to a file in the workspace (creating parent folders, "
            "overwriting any existing file). Use to persist research state and "
            "deliverables — briefs, notes, and the final report — so progress "
            "survives even if earlier context is compacted away. Writes are "
            "sandboxed to the workspace directory. The result reports the file's "
            "absolute path; pass that path to a later run_script step (e.g. a "
            "Markdown→.docx converter)."
        ),
        parameters=WRITE_FILE_SCHEMA,
        fn=_write_file,
    )
