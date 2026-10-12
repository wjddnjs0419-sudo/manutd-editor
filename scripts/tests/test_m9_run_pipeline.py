from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_run_pipeline import content_slide_count, reviewed_selections_match, require_exploration_owner_draft


class TestM9RunPipeline(unittest.TestCase):
    def test_content_page_count_accepts_phase_two_bounds(self):
        for count in range(2, 7):
            brief = {"slides_json": {"slides": [{} for _ in range(count)]}}
            self.assertEqual(content_slide_count(brief), count)

    def test_content_page_count_rejects_out_of_bounds(self):
        for count in (1, 7):
            with self.assertRaisesRegex(ValueError, "M9_BRIEF_SLIDE_COUNT_INVALID"):
                content_slide_count({"slides_json": {"slides": [{} for _ in range(count)]}})

    def test_page_review_requires_exactly_one_selected_photo_per_content_slide(self):
        def selections(count: int):
            return {"selections": [
                {"slot": "COVER_NEWS" if page == 1 else "BODY_NEWS",
                 "slide_number": page, "selected": {"candidate": {}}}
                for page in range(1, count + 1)
            ]}

        for count in range(2, 7):
            self.assertTrue(reviewed_selections_match(selections(count), count))
            self.assertFalse(reviewed_selections_match(selections(count) | {"selections": selections(count)["selections"][:-1]}, count))
        invalid = selections(3)
        invalid["selections"][1]["slide_number"] = 4
        self.assertFalse(reviewed_selections_match(invalid, 3))

    def test_owner_delivery_requires_saved_exploration_draft(self):
        require_exploration_owner_draft({"status": "DRAFT", "generation_metadata": {"generation_intent": "EXPLORATION"}})
        require_exploration_owner_draft({"status": "SELECTED", "generation_metadata": {"generation_intent": "EXPLORATION"}})
        for brief in (
            {"status": "READY", "generation_metadata": {"generation_intent": "EXPLORATION"}},
            {"status": "DRAFT", "generation_metadata": {"generation_intent": "STANDARD"}},
            {"status": "DRAFT", "generation_metadata": {}},
        ):
            with self.assertRaisesRegex(ValueError, "M9_DRAFT_EXPLORATION_REQUIRED"):
                require_exploration_owner_draft(brief)


if __name__ == "__main__":
    unittest.main()
