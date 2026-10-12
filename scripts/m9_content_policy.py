"""Small shared Exploration page-count policy for the M9 worker and renderer."""
from __future__ import annotations

EXPLORATION_SLIDE_BOUNDS = {
    "NEWS_UPDATE": (2, 4),
    "ANALYSIS_CONTEXT": (4, 6),
    "MATCH_CONTENT": (3, 5),
}


def validate_exploration_slide_count(
    brief_status: object,
    generation_intent: object,
    content_mode: object,
    slide_count: int,
) -> None:
    """Apply new bounds only to Exploration review drafts, never READY briefs."""
    if brief_status not in ("DRAFT", "SELECTED") or generation_intent != "EXPLORATION":
        return
    bounds = EXPLORATION_SLIDE_BOUNDS.get(str(content_mode))
    if bounds is None:
        raise ValueError("M9_EXPLORATION_CONTENT_MODE_INVALID")
    if not bounds[0] <= slide_count <= bounds[1]:
        raise ValueError("M9_EXPLORATION_SLIDE_COUNT_INVALID")
