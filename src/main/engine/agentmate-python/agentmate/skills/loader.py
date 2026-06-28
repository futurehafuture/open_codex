"""Discover skills on disk and parse their ``SKILL.md`` files.

Discovery mirrors Claude Code: each skill is a sub-directory containing a
``SKILL.md`` whose frontmatter declares ``name`` and ``description``. The
frontmatter is a small ``key: value`` block delimited by ``---`` lines; we parse
it by hand to avoid a YAML dependency, since the spec only uses single-line
scalar values.

Parsing is tolerant: a malformed or invalid skill is logged and skipped rather
than aborting discovery, so one bad folder never breaks the whole catalog.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from agentmate.skills.models import Skill

__all__ = ["load_skills", "parse_skill_file", "SkillParseError"]

logger = logging.getLogger(__name__)

_NAME_RE = re.compile(r"^[a-z0-9-]{1,64}$")
_MAX_DESCRIPTION_CHARS = 1024
_RESERVED_WORDS = ("anthropic", "claude")


class SkillParseError(ValueError):
    """Raised when a ``SKILL.md`` is missing required/valid frontmatter."""


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split ``---`` frontmatter from the body. Returns (fields, body).

    Only single-line ``key: value`` pairs are recognised (matching the SKILL.md
    convention). Surrounding quotes on the value are stripped.
    """
    if not text.startswith("---"):
        raise SkillParseError("missing '---' frontmatter block")
    # Split on the first two '---' fences.
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise SkillParseError("frontmatter block is not closed with '---'")
    _, raw_front, body = parts

    fields: dict[str, str] = {}
    for line in raw_front.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        fields[key.strip().lower()] = value.strip().strip("'\"")
    return fields, body.strip()


def _validate(name: str, description: str) -> None:
    if not _NAME_RE.match(name):
        raise SkillParseError(
            f"invalid name {name!r}: must be 1-64 chars of [a-z0-9-]"
        )
    if any(word in name for word in _RESERVED_WORDS):
        raise SkillParseError(f"name {name!r} contains a reserved word")
    if not description:
        raise SkillParseError("description must be non-empty")
    if len(description) > _MAX_DESCRIPTION_CHARS:
        raise SkillParseError(
            f"description too long: {len(description)} > {_MAX_DESCRIPTION_CHARS}"
        )


def parse_skill_file(skill_md: Path) -> Skill:
    """Parse one ``SKILL.md`` into a :class:`Skill`. Raises on invalid frontmatter."""
    text = skill_md.read_text(encoding="utf-8")
    fields, body = _parse_frontmatter(text)
    name = fields.get("name", "").strip()
    description = fields.get("description", "").strip()
    _validate(name, description)
    return Skill(
        name=name,
        description=description,
        body=body,
        directory=skill_md.parent.resolve(),
    )


def load_skills(skill_dirs: list[Path]) -> dict[str, Skill]:
    """Discover skills under each directory; return a ``name -> Skill`` map.

    Each immediate sub-directory containing a ``SKILL.md`` is one skill. Later
    directories win on name collisions (project dirs should precede user dirs in
    the caller's ordering if project should override — see the registry).
    """
    skills: dict[str, Skill] = {}
    for root in skill_dirs:
        if not root.is_dir():
            continue
        for skill_md in sorted(root.glob("*/SKILL.md")):
            try:
                skill = parse_skill_file(skill_md)
            except (SkillParseError, OSError) as exc:
                logger.warning("Skipping skill at %s: %s", skill_md, exc)
                continue
            if skill.name in skills:
                logger.warning(
                    "Duplicate skill name %r; %s overrides earlier definition",
                    skill.name,
                    skill_md,
                )
            skills[skill.name] = skill
    return skills
