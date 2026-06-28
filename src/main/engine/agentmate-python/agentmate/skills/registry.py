"""In-memory skill registry: discovery catalog + body/resource lookup.

This is the Level 1/2/3 hub:

* Level 1 — :meth:`catalog` renders the ``name``/``description`` block injected
  into the system prompt at startup.
* Level 2 — :meth:`body` returns a skill's full ``SKILL.md`` instructions for the
  ``Skill`` tool.
* Level 3 — :meth:`resolve_path` safely maps a skill-relative file reference to
  an absolute path *inside* the skill directory (path-traversal guarded), used
  by the ``read_file`` and ``run_script`` tools.
"""

from __future__ import annotations

from pathlib import Path

from agentmate.skills.loader import load_skills
from agentmate.skills.models import Skill

__all__ = ["SkillRegistry"]


class SkillRegistry:
    """Name-keyed collection of discovered skills."""

    def __init__(self, skills: dict[str, Skill] | None = None) -> None:
        self._skills: dict[str, Skill] = dict(skills or {})

    @classmethod
    def from_dirs(cls, skill_dirs: list[Path]) -> "SkillRegistry":
        """Discover skills under the given directories (later dirs win on name)."""
        return cls(load_skills(skill_dirs))

    def __len__(self) -> int:
        return len(self._skills)

    def get(self, name: str) -> Skill | None:
        return self._skills.get(name)

    def names(self) -> list[str]:
        return sorted(self._skills)

    def body(self, name: str) -> str | None:
        """Return a skill's instruction body, or ``None`` if unknown."""
        skill = self._skills.get(name)
        return skill.body if skill is not None else None

    def catalog(self) -> str:
        """Render the Level 1 discovery block for the system prompt.

        Empty string when no skills are installed, so the caller can append
        unconditionally without leaving a dangling header.
        """
        if not self._skills:
            return ""
        lines = [
            "# Available Skills",
            "",
            "You have skills — packaged instructions for specific tasks. When a "
            "request matches a skill's description, call the `Skill` tool with "
            "its name to load the full instructions before proceeding. Only load "
            "a skill when it is relevant.",
            "",
        ]
        for name in self.names():
            lines.append(f"- **{name}**: {self._skills[name].description}")
        return "\n".join(lines)

    def list_files(self, name: str) -> list[str]:
        """Return skill ``name``'s bundled files as skill-relative paths.

        Sorted, ``__pycache__`` and dotfiles excluded. Raises ``KeyError`` for an
        unknown skill. Used to make "file not found" errors self-correcting by
        showing the model what *is* available.
        """
        skill = self._skills.get(name)
        if skill is None:
            raise KeyError(name)
        base = skill.directory
        return [
            p.relative_to(base).as_posix()
            for p in sorted(base.rglob("*"))
            if p.is_file()
            and "__pycache__" not in p.parts
            and not p.name.startswith(".")
        ]

    def resolve_path(self, name: str, relative: str) -> Path:
        """Resolve ``relative`` against skill ``name``'s directory, safely.

        Raises:
            KeyError: unknown skill name.
            ValueError: the path escapes the skill directory (traversal) or does
                not exist. The not-found message lists the skill's real files so
                a model that guessed a wrong name can self-correct in one step.
        """
        skill = self._skills.get(name)
        if skill is None:
            raise KeyError(name)
        base = skill.directory
        target = (base / relative).resolve()
        if base != target and base not in target.parents:
            raise ValueError(
                f"path {relative!r} escapes skill directory for {name!r}"
            )
        if not target.exists():
            available = ", ".join(self.list_files(name)) or "(no files)"
            raise ValueError(
                f"file not found: {relative!r} in skill {name!r}. "
                f"Available files: {available}"
            )
        return target
