"""Context management: budget enforcement, trimming, and compaction.

Three layers of context control, applied in order:

- **P0 Budget** (:mod:`~agentmate.context.budget`): per-tool result character
  cap.  Applied immediately when a tool returns, before the result enters the
  message list.
- **P1 Trimmer** (:mod:`~agentmate.context.trimmer`): read-time projection that
  fits the full message list into a character budget.  Called before every LLM
  request; never mutates the stored history.
- **P2 Compactor** (:mod:`~agentmate.context.compressor`): LLM-generated
  summary of older turns.  Triggered when the context pressure exceeds a
  configurable threshold after P0 and P1 have already run.
"""

from agentmate.context.budget import truncate_result
from agentmate.context.compressor import compact_history
from agentmate.context.trimmer import estimate_chars, trim_for_query

__all__ = [
    "truncate_result",
    "trim_for_query",
    "estimate_chars",
    "compact_history",
]
