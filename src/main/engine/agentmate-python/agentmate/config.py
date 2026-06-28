"""Profile-based model configuration (codex-style TOML).

Switching models means switching a named profile, not editing scattered env
vars. Profiles live in a TOML file resolved from, in order:

1. ``$AGENTMATE_CONFIG``
2. ``./agentmate.toml``           (project-local; gitignored)
3. ``~/.config/agentmate/config.toml``  (user-level)

First existing file wins — there is no merging across locations.

Secrets: a profile names its key via ``api_key_env`` (an env var name) or, only
in a user-level file outside any repo, inline ``api_key``. Inline wins if both
are present. :class:`ModelConfig` redacts the key in ``repr`` so it never lands
in logs.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "ModelConfig",
    "ConfigError",
    "resolve_profile",
    "resolve_tool_key",
    "load_agent_settings",
    "load_config",
]


class ConfigError(Exception):
    """Raised when configuration is missing, malformed, or has no usable key."""


@dataclass(frozen=True)
class ModelConfig:
    """Resolved settings for one model profile.

    ``extra_body`` is passed through to the API verbatim (e.g. provider-specific
    reasoning/thinking flags), so new providers need no code change.
    """

    model: str
    api_key: str
    base_url: str | None = None
    temperature: float = 0.2
    max_tokens: int | None = None
    timeout: float = 30.0
    reasoning_effort: str | None = None
    extra_body: dict[str, Any] = field(default_factory=dict)

    def __repr__(self) -> str:
        # Never expose the key in logs/tracebacks.
        return (
            f"ModelConfig(model={self.model!r}, base_url={self.base_url!r}, "
            f"temperature={self.temperature!r}, max_tokens={self.max_tokens!r}, "
            f"timeout={self.timeout!r}, reasoning_effort={self.reasoning_effort!r}, "
            f"api_key='***')"
        )


def _candidate_paths() -> list[Path]:
    paths: list[Path] = []
    env_path = os.getenv("AGENTMATE_CONFIG")
    if env_path:
        paths.append(Path(env_path))
    paths.append(Path.cwd() / "agentmate.toml")
    paths.append(Path.home() / ".config" / "agentmate" / "config.toml")
    return paths


def _find_config_path(explicit: str | Path | None) -> Path:
    if explicit is not None:
        path = Path(explicit)
        if not path.is_file():
            raise ConfigError(f"Config file not found: {path}")
        return path
    for candidate in _candidate_paths():
        if candidate.is_file():
            return candidate
    searched = ", ".join(str(p) for p in _candidate_paths())
    raise ConfigError(f"No config file found. Looked in: {searched}")


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    """Load and parse the TOML config (first existing location wins)."""
    config_path = _find_config_path(path)
    try:
        with open(config_path, "rb") as fh:  # tomllib requires binary mode
            return tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"Invalid TOML in {config_path}: {exc}") from exc


def _resolve_api_key(profile: dict[str, Any], name: str) -> str:
    inline = profile.get("api_key")
    if isinstance(inline, str) and inline:
        return inline
    env_name = profile.get("api_key_env")
    if isinstance(env_name, str) and env_name:
        value = os.getenv(env_name)
        if not value:
            raise ConfigError(
                f"Profile '{name}': env var '{env_name}' is unset or empty."
            )
        return value
    raise ConfigError(
        f"Profile '{name}': set 'api_key_env' (recommended) or inline 'api_key'."
    )


def load_agent_settings(path: str | Path | None = None) -> dict[str, Any]:
    """Return the ``[agent]`` table (loop-level settings) from the config.

    Tolerant: a missing config file or table yields ``{}`` so callers fall back
    to their defaults.
    """
    try:
        config = load_config(path)
    except ConfigError:
        return {}
    table = config.get("agent")
    return table if isinstance(table, dict) else {}


def resolve_tool_key(
    tool_name: str,
    env_fallback: str | None = None,
    path: str | Path | None = None,
) -> str | None:
    """Resolve a tool's API key from ``[tools.<tool_name>]``, else the environment.

    Order: inline ``api_key`` > ``api_key_env`` (named env var) > ``env_fallback``
    env var. Tolerant by design — a missing config file is not an error; the
    function simply falls back to the environment. Returns ``None`` if nothing is
    found, leaving the caller to decide whether that is fatal.
    """
    table: dict[str, Any] = {}
    try:
        config = load_config(path)
    except ConfigError:
        config = {}
    tools = config.get("tools")
    if isinstance(tools, dict):
        candidate = tools.get(tool_name)
        if isinstance(candidate, dict):
            table = candidate

    inline = table.get("api_key")
    if isinstance(inline, str) and inline:
        return inline
    env_name = table.get("api_key_env")
    if isinstance(env_name, str) and env_name:
        value = os.getenv(env_name)
        if value:
            return value
    if env_fallback:
        return os.getenv(env_fallback)
    return None


def resolve_profile(
    name: str | None = None,
    path: str | Path | None = None,
) -> ModelConfig:
    """Resolve one profile from the config file into a :class:`ModelConfig`.

    Args:
        name: Profile name; falls back to ``default_profile`` in the file.
        path: Explicit config path; otherwise the standard search order is used.
    """
    config = load_config(path)
    profiles = config.get("profiles")
    if not isinstance(profiles, dict) or not profiles:
        raise ConfigError("Config has no [profiles] table.")

    profile_name = name or config.get("default_profile")
    if not isinstance(profile_name, str) or not profile_name:
        raise ConfigError("No profile name given and no 'default_profile' set.")

    profile = profiles.get(profile_name)
    if not isinstance(profile, dict):
        available = ", ".join(profiles.keys())
        raise ConfigError(
            f"Profile '{profile_name}' not found. Available: {available}"
        )

    model = profile.get("model")
    if not isinstance(model, str) or not model:
        raise ConfigError(f"Profile '{profile_name}': 'model' is required.")

    return ModelConfig(
        model=model,
        api_key=_resolve_api_key(profile, profile_name),
        base_url=profile.get("base_url"),
        temperature=float(profile.get("temperature", 0.2)),
        max_tokens=profile.get("max_tokens"),
        timeout=float(profile.get("timeout", 30.0)),
        reasoning_effort=profile.get("reasoning_effort"),
        extra_body=dict(profile.get("extra_body", {})),
    )
