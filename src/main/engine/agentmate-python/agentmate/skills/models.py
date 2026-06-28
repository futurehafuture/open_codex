"""The immutable Skill value object.

A skill is a directory containing a ``SKILL.md`` file. ``SKILL.md`` has YAML-ish
frontmatter (``name`` + ``description``) followed by a markdown body of
instructions. Bundled sub-files (``REFERENCE.md``, scripts, resources) live
alongside it and are loaded on demand (Level 3), never eagerly.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

__all__ = ["Skill"]


@dataclass(frozen=True)
class Skill:
    """One discovered skill.

    Attributes:
        name: Unique skill id (lowercase letters, digits, hyphens; <= 64 chars).
        description: What the skill does *and* when to use it (<= 1024 chars).
            This is the only part injected into the system prompt at startup
            (Level 1 — discovery).
        body: The full ``SKILL.md`` markdown body (everything after the
            frontmatter). Loaded into context only when the model invokes the
            skill via the ``Skill`` tool (Level 2 — instructions).
        directory: Absolute path to the skill's folder. Level 3 sub-files and
            scripts are resolved relative to this and must stay inside it.
    """

    name: str
    description: str
    body: str
    directory: Path
