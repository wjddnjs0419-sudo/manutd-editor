"""Shared content ordering and Exploration page-count policy for M9."""
from __future__ import annotations

from typing import Any

EXPLORATION_SLIDE_BOUNDS = {
    "NEWS_UPDATE": (2, 4),
    "ANALYSIS_CONTEXT": (4, 6),
    "MATCH_CONTENT": (3, 5),
}


def ordered_content_slides(raw: object) -> list[dict[str, Any]]:
    """Use saved content index and explicit role, keeping the Hook on page one.

    Legacy briefs without roles keep their first indexed slide as the Hook.
    When roles are present, exactly one HOOK is required. Moving that role to
    the cover preserves the index order of every other slide.
    """
    if isinstance(raw, dict):
        raw = raw.get("slides")
    if not isinstance(raw, list) or any(not isinstance(row, dict) for row in raw):
        raise ValueError("M9_BRIEF_SLIDES_INVALID")
    rows = list(raw)
    if not rows:
        return []

    indexed: list[tuple[int, int, dict[str, Any]]] = []
    used_indices: set[int] = set()
    for position, row in enumerate(rows):
        raw_index = row.get("index", row.get("slide_number", position + 1))
        if isinstance(raw_index, bool):
            raise ValueError("M9_BRIEF_SLIDE_INDEX_INVALID")
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            raise ValueError("M9_BRIEF_SLIDE_INDEX_INVALID") from None
        if index < 1 or index in used_indices:
            raise ValueError("M9_BRIEF_SLIDE_INDEX_INVALID")
        used_indices.add(index)
        indexed.append((index, position, row))

    indexed.sort(key=lambda item: (item[0], item[1]))
    ordered = [row for _, _, row in indexed]
    role_values = [row.get("role") for row in ordered if row.get("role") is not None]
    if role_values:
        if len(role_values) != len(ordered):
            raise ValueError("M9_BRIEF_SLIDE_ROLE_INVALID")
        if any(not isinstance(role, str) or not role.strip() for role in role_values):
            raise ValueError("M9_BRIEF_SLIDE_ROLE_INVALID")
        hooks = [row for row in ordered if str(row.get("role", "")).strip().upper() == "HOOK"]
        if len(hooks) != 1:
            raise ValueError("M9_BRIEF_HOOK_ROLE_INVALID")
        hook = hooks[0]
        ordered = [hook, *(row for row in ordered if row is not hook)]
    return ordered


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
