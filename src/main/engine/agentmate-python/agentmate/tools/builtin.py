"""Built-in tools shipped with the framework.

Currently: ``web_search`` and ``web_fetch``, both backed by the Tavily API.
Uses the stdlib HTTP client so the framework gains no extra dependency. The API
key is read from the ``TAVILY_API_KEY`` environment variable at call time.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

from agentmate.config import resolve_tool_key
from agentmate.tools.registry import ToolRegistry

__all__ = [
    "web_search",
    "register_web_search",
    "WEB_SEARCH_SCHEMA",
    "web_fetch",
    "register_web_fetch",
    "WEB_FETCH_SCHEMA",
]

logger = logging.getLogger(__name__)

_TAVILY_URL = "https://api.tavily.com/search"
_TAVILY_EXTRACT_URL = "https://api.tavily.com/extract"
_TAVILY_KEY_ENV = "TAVILY_API_KEY"

WEB_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "The search query."},
        "max_results": {
            "type": "integer",
            "description": "How many results to return (1-10).",
            "default": 5,
        },
    },
    "required": ["query"],
}


def web_search(query: str, max_results: int = 5, api_key: str | None = None) -> str:
    """Search the web via Tavily and return a compact text summary.

    Args:
        query: The search query.
        max_results: Number of results to return.
        api_key: Tavily key; falls back to the ``TAVILY_API_KEY`` env var.

    Returns:
        A human-readable summary, or an ``Error: ...`` string safe to feed back
        to the model (this function does not raise on network/key failures).
    """
    key = api_key or os.getenv(_TAVILY_KEY_ENV)
    if not key:
        return "Error: no Tavily API key (set [tools.tavily] in config or TAVILY_API_KEY)."

    payload = json.dumps(
        {
            "query": query,
            "max_results": max(1, min(max_results, 10)),
            "search_depth": "basic",
            "include_answer": True,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        _TAVILY_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data: Any = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        logger.warning("Tavily HTTP %s", exc.code)
        return f"Error: Tavily returned HTTP {exc.code}."
    except urllib.error.URLError as exc:
        logger.warning("Tavily unreachable: %s", exc.reason)
        return f"Error: could not reach Tavily ({exc.reason})."
    except json.JSONDecodeError as exc:
        return f"Error: Tavily returned invalid JSON ({exc})."

    return _format_results(data)


def _format_results(data: Any) -> str:
    if not isinstance(data, dict):
        return "No results."
    lines: list[str] = []
    answer = data.get("answer")
    if isinstance(answer, str) and answer:
        lines.append(f"Answer: {answer}")
    results = data.get("results")
    if isinstance(results, list):
        for index, item in enumerate(results, start=1):
            if not isinstance(item, dict):
                continue
            title = item.get("title", "")
            url = item.get("url", "")
            content = item.get("content", "")
            lines.append(f"{index}. {title}\n   {url}\n   {content}")
    return "\n".join(lines) if lines else "No results."


def register_web_search(
    registry: ToolRegistry,
    api_key: str | None = None,
    config_path: str | None = None,
) -> None:
    """Register :func:`web_search` under the name ``web_search``.

    The Tavily key is resolved once, in order: explicit ``api_key`` arg >
    ``[tools.tavily]`` in the config file > ``TAVILY_API_KEY`` env var. The
    resolved key is bound into the registered tool; if none resolves now, the
    tool still falls back to the env var at call time.
    """
    resolved = api_key or resolve_tool_key("tavily", _TAVILY_KEY_ENV, config_path)

    def _web_search(query: str, max_results: int = 5) -> str:
        return web_search(query, max_results, api_key=resolved)

    registry.register(
        name="web_search",
        description="Search the web for current, up-to-date information using Tavily.",
        parameters=WEB_SEARCH_SCHEMA,
        fn=_web_search,
    )


WEB_FETCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "url": {
            "type": "string",
            "description": "The URL of the web page to fetch and extract.",
        },
    },
    "required": ["url"],
}


def web_fetch(url: str, api_key: str | None = None) -> str:
    """Fetch a web page via Tavily's extract API and return its text content.

    Args:
        url: The page URL to fetch.
        api_key: Tavily key; falls back to the ``TAVILY_API_KEY`` env var.

    Returns:
        The extracted page text, or an ``Error: ...`` string safe to feed back
        to the model (this function does not raise on network/key failures).
    """
    key = api_key or os.getenv(_TAVILY_KEY_ENV)
    if not key:
        return "Error: no Tavily API key (set [tools.tavily] in config or TAVILY_API_KEY)."

    payload = json.dumps({"urls": [url]}).encode("utf-8")
    request = urllib.request.Request(
        _TAVILY_EXTRACT_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data: Any = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        logger.warning("Tavily extract HTTP %s", exc.code)
        return f"Error: Tavily returned HTTP {exc.code}."
    except urllib.error.URLError as exc:
        logger.warning("Tavily unreachable: %s", exc.reason)
        return f"Error: could not reach Tavily ({exc.reason})."
    except json.JSONDecodeError as exc:
        return f"Error: Tavily returned invalid JSON ({exc})."

    return _format_extract(data, url)


def _format_extract(data: Any, url: str) -> str:
    if not isinstance(data, dict):
        return "No content."
    results = data.get("results")
    if isinstance(results, list):
        for item in results:
            if not isinstance(item, dict):
                continue
            content = item.get("raw_content") or item.get("content")
            if isinstance(content, str) and content:
                page_url = item.get("url", url)
                return f"{page_url}\n\n{content}"
    failed = data.get("failed_results")
    if isinstance(failed, list) and failed:
        return f"Error: Tavily could not extract content from {url}."
    return "No content."


def register_web_fetch(
    registry: ToolRegistry,
    api_key: str | None = None,
    config_path: str | None = None,
) -> None:
    """Register :func:`web_fetch` under the name ``web_fetch``.

    The Tavily key is resolved once, in order: explicit ``api_key`` arg >
    ``[tools.tavily]`` in the config file > ``TAVILY_API_KEY`` env var. The
    resolved key is bound into the registered tool; if none resolves now, the
    tool still falls back to the env var at call time.
    """
    resolved = api_key or resolve_tool_key("tavily", _TAVILY_KEY_ENV, config_path)

    def _web_fetch(url: str) -> str:
        return web_fetch(url, api_key=resolved)

    registry.register(
        name="web_fetch",
        description="Fetch a web page by URL and return its extracted text content using Tavily.",
        parameters=WEB_FETCH_SCHEMA,
        fn=_web_fetch,
    )
