"""Web server: a chat UI over the agent loop."""

from agentmate.server.app import build_default_agent, create_app

__all__ = ["create_app", "build_default_agent"]
