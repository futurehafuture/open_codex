"""Agent Skills: progressive-disclosure capability packages.

Three levels, mirroring Claude Code:

* Level 1 — discovery: ``name``/``description`` injected into the system prompt
  via :meth:`SkillRegistry.catalog`.
* Level 2 — instructions: the ``Skill`` tool loads a skill's ``SKILL.md`` body.
* Level 3 — resources/scripts: ``read_file`` / ``run_script`` access bundled
  files inside the skill directory on demand.
"""

from agentmate.skills.loader import SkillParseError, load_skills, parse_skill_file
from agentmate.skills.models import Skill
from agentmate.skills.registry import SkillRegistry
from agentmate.skills.tools import SKILL_RESULT_MAX_CHARS, register_skill_tools

__all__ = [
    "Skill",
    "SkillRegistry",
    "SkillParseError",
    "load_skills",
    "parse_skill_file",
    "register_skill_tools",
    "SKILL_RESULT_MAX_CHARS",
]
