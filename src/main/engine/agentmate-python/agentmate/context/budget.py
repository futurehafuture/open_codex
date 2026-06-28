"""P0 — Tool-result budget enforcement.

Every tool result passes through :func:`truncate_result` before being appended
to the message list. Oversized results are soft-truncated: the head and tail are
preserved so the model sees both the beginning and end of the output, with a
clear marker in between showing how many characters were dropped.

Design notes
------------
* Pure function — no dependency on Agent or any mutable state.
* The default split (``head_chars`` 2 000, ``tail_chars`` 1 000) keeps the
  answer snippet (which Tavily puts at the top) and the last result (often most
  relevant) while removing the bulky middle.
* Tools that must return their full output (e.g. a structured JSON blob that
  the agent parses) can be registered with ``max_result_chars=None`` to opt out.
"""

from __future__ import annotations

__all__ = ["truncate_result"]

_DEFAULT_HEAD = 2_000
_DEFAULT_TAIL = 1_000
_MARKER_TEMPLATE = "\n...[截断 {omitted} 字符，原始长度 {total} 字符]...\n"


def truncate_result(
    text: str,
    max_chars: int,
    head_chars: int = _DEFAULT_HEAD,
    tail_chars: int = _DEFAULT_TAIL,
) -> str:
    """Truncate ``text`` to ``max_chars``, keeping head and tail intact.

    If ``len(text) <= max_chars`` the original string is returned unchanged.
    Otherwise the middle is replaced with a human-readable marker indicating how
    many characters were omitted and the original total length.

    Args:
        text: The tool result string to truncate.
        max_chars: Maximum allowed length after truncation.
        head_chars: Characters to keep from the start.
        tail_chars: Characters to keep from the end.

    Returns:
        The (possibly truncated) result string.

    Examples:
        >>> result = "A" * 10_000
        >>> out = truncate_result(result, max_chars=4_000)
        >>> len(out) < 10_000
        True
        >>> "截断" in out
        True
    """
    if len(text) <= max_chars:
        return text

    # Clamp head/tail so they don't overlap or exceed max_chars together.
    head = min(head_chars, max_chars)
    tail = min(tail_chars, max(0, max_chars - head))

    omitted = len(text) - head - tail
    marker = _MARKER_TEMPLATE.format(omitted=omitted, total=len(text))
    return text[:head] + marker + (text[-tail:] if tail > 0 else "")
