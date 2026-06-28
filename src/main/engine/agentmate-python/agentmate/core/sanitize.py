"""Strip leaked tool-call markup from assistant content.

Some OpenAI-compatible providers emit a tool call as plain *content* using the
model's native special tokens (e.g. ``<｜｜DSML｜｜tool_calls>…</｜｜DSML｜｜tool_calls>``)
instead of the structured ``tool_calls`` field. Those tokens are an internal
protocol artifact and must never reach the user. This module removes them from
both the final answer and the streamed deltas.
"""

from __future__ import annotations

import re

__all__ = ["strip_tool_markup", "ToolMarkupFilter"]

# A complete leaked block: an opener tag containing ``tool_calls`` through to the
# matching closer. Tolerates arbitrary delimiter junk (fullwidth pipes, "DSML",
# etc.) around the keyword, but not nested angle brackets within a single tag.
_BLOCK_RE = re.compile(
    r"[<＜][^<>]*\btool_calls\b[^<>]*>.*?[<＜][^<>]*/[^<>]*\btool_calls\b[^<>]*>",
    re.DOTALL,
)
# A dangling opener with no closer yet (the rest of a partial stream is the
# leaked call). Everything from the opener onward is suppressed.
_OPEN_RE = re.compile(
    r"[<＜][^<>]*\btool_calls\b[^<>]*>.*\Z",
    re.DOTALL,
)

# Characters that could begin a special-token marker. A trailing run starting
# with one of these (and not yet closed by ``>``) is held back while streaming,
# so a marker split across chunks is never emitted piecemeal.
_MARKER_STARTS = "<＜｜"


def strip_tool_markup(text: str) -> str:
    """Remove leaked tool-call markup blocks from ``text``."""
    if not text:
        return text
    cleaned = _BLOCK_RE.sub("", text)
    cleaned = _OPEN_RE.sub("", cleaned)
    return cleaned


def _safe_len(clean: str) -> int:
    """Length of ``clean`` safe to emit now (holds back an unclosed tag tail).

    Everything up to the last ``>`` is closed and safe. In the trailing run
    after it, the first marker-start char begins a possibly-incomplete special
    token and is held back until the rest of the stream resolves it.
    """
    tail_start = clean.rfind(">") + 1  # 0 when no ``>`` present
    tail = clean[tail_start:]
    offsets = [tail.find(c) for c in _MARKER_STARTS if c in tail]
    if not offsets:
        return len(clean)
    return tail_start + min(offsets)


class ToolMarkupFilter:
    """Streaming-safe stripper: feed raw content chunks, get clean deltas.

    Re-derives the clean text from the full accumulated buffer on every chunk,
    so partial markers spanning chunk boundaries are handled correctly. Call
    :meth:`flush` once the turn ends to release any held-back tail.
    """

    def __init__(self) -> None:
        self._raw: list[str] = []
        self._emitted = 0

    def feed(self, chunk: str) -> str:
        """Accumulate ``chunk`` and return the newly displayable clean text."""
        self._raw.append(chunk)
        clean = strip_tool_markup("".join(self._raw))
        safe = _safe_len(clean)
        if safe <= self._emitted:
            return ""
        delta = clean[self._emitted : safe]
        self._emitted = safe
        return delta

    def flush(self) -> str:
        """Return any clean text held back so far (call at end of turn)."""
        clean = self.text()
        if len(clean) <= self._emitted:
            return ""
        delta = clean[self._emitted :]
        self._emitted = len(clean)
        return delta

    def text(self) -> str:
        """The full clean content accumulated so far."""
        return strip_tool_markup("".join(self._raw))
