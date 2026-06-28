"""agentmate — a lightweight agent framework."""

from agentmate.config import ConfigError, ModelConfig, resolve_profile
from agentmate.core.agent import Agent, AgentConfig
from agentmate.core.events import (
    AgentEvent,
    AnswerDeltaEvent,
    DoneEvent,
    ThinkingEvent,
    ToolCallEvent,
    ToolResultEvent,
)
from agentmate.llm.base import LLMClient, LLMResponse, StreamDelta, ToolCall
from agentmate.llm.openai_client import OpenAIClient
from agentmate.skills.models import Skill
from agentmate.skills.registry import SkillRegistry
from agentmate.tools.executor import ToolExecutor
from agentmate.tools.registry import ToolRegistry, ToolSpec

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "Agent",
    "AgentConfig",
    "AgentEvent",
    "AnswerDeltaEvent",
    "DoneEvent",
    "ThinkingEvent",
    "ToolCallEvent",
    "ToolResultEvent",
    "LLMClient",
    "LLMResponse",
    "StreamDelta",
    "ToolCall",
    "OpenAIClient",
    "ModelConfig",
    "ConfigError",
    "resolve_profile",
    "ToolRegistry",
    "ToolSpec",
    "ToolExecutor",
    "Skill",
    "SkillRegistry",
]
