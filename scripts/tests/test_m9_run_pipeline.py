from __future__ import annotations

import sys
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_run_pipeline import (
    claim_cloud_preview, command, content_slide_count, fail_unrendered_cloud_preview,
    reviewed_selections_match, require_exploration_owner_draft,
)
from m9_preview_workflow import job_key, pre_send_retry_job_key


class TestM9RunPipeline(unittest.TestCase):
    def test_cloud_job_is_claimed_before_photo_work_and_timeout_is_persisted(self):
        class Remote:
            def __init__(self): self.events=[]
            def ensure_private_bucket(self): self.events.append(("private",))
            def get_preview(self,key): self.events.append(("lookup",key)); return None
            def claim(self,key,brief_id,manifest): self.events.append(("claim",key,brief_id,manifest))
            def transition(self,key,previous,next_status,patch): self.events.append(("transition",key,previous,next_status,patch))
        brief={"id":"72bf1111-ae15-45ca-a812-3c1e2ee37a10","version":2,"content_mode":"NEWS_UPDATE"}
        remote=Remote()
        key=claim_cloud_preview(remote,brief)
        self.assertEqual(key,job_key(brief,{}))
        self.assertEqual(remote.events[0],("private",))
        self.assertEqual(remote.events[1],("lookup",key))
        self.assertEqual(remote.events[2][0:3],("claim",key,brief["id"]))
        self.assertEqual(remote.events[2][3],{"content_mode":"NEWS_UPDATE","brief_version":2,"render_revision":"render-v2","source":"telegram_owner_preview"})
        fail_unrendered_cloud_preview(remote,key,RuntimeError("M9_STAGE_TIMEOUT: m9_collect_media.ts"))
        self.assertEqual(remote.events[-1],("transition",key,"CLAIMED","FAILED",{"error_category":"STAGE_TIMEOUT"}))

    def test_new_renderer_revision_gets_a_distinct_key_after_old_revision_was_sent(self):
        brief={"id":"72bf1111-ae15-45ca-a812-3c1e2ee37a10","version":1,"content_mode":"NEWS_UPDATE"}
        old_key=f"m9:{brief['id']}:v1"

        class Remote:
            def __init__(self): self.claimed=[]
            def ensure_private_bucket(self): pass
            def get_preview(self,key):
                return {"creative_brief_id":brief["id"],"status":"SENT","telegram_message_ids":[701]} if key == old_key else None
            def claim(self,key,brief_id,manifest): self.claimed.append((key,brief_id,manifest))

        remote=Remote()
        key=claim_cloud_preview(remote,brief)
        self.assertEqual(key,job_key(brief,{}))
        self.assertNotEqual(key,old_key)
        self.assertEqual(remote.claimed[0][2]["render_revision"],"render-v2")

    def test_claims_one_reserved_key_only_after_confirmed_pre_send_failure(self):
        brief={"id":"72bf1111-ae15-45ca-a812-3c1e2ee37a10","version":1,"content_mode":"NEWS_UPDATE"}
        original=job_key(brief,{})
        retry=pre_send_retry_job_key(brief)

        class Remote:
            def __init__(self,previews): self.previews=previews; self.claimed=[]
            def ensure_private_bucket(self): pass
            def get_preview(self,key): return self.previews.get(key)
            def claim(self,key,brief_id,manifest): self.claimed.append((key,brief_id,manifest))

        remote=Remote({original:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]}})
        self.assertEqual(claim_cloud_preview(remote,brief),retry)
        self.assertEqual(remote.claimed[0][0],retry)
        self.assertEqual(remote.claimed[0][2]["retry_of"],original)
        self.assertEqual(remote.claimed[0][2]["retry_reason"],"CONFIRMED_PRE_SEND_FAILURE")

        for previous in (
            {"creative_brief_id":brief["id"],"status":"SEND_UNCERTAIN","telegram_message_ids":[]},
            {"creative_brief_id":brief["id"],"status":"SENT","telegram_message_ids":[701]},
            {"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[701]},
        ):
            blocked=Remote({original:previous})
            with self.assertRaisesRegex(ValueError,"M9_JOB_ALREADY_CLAIMED_NO_RETRY"):
                claim_cloud_preview(blocked,brief)
            self.assertEqual(blocked.claimed,[])

        used=Remote({original:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]},retry:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]}})
        retry2=retry.rsplit(":v",1)[0]+":v00"
        self.assertEqual(claim_cloud_preview(used,brief),retry2)
        self.assertEqual(used.claimed[0][0],retry2)
        self.assertEqual(used.claimed[0][2]["retry_attempt"],2)

        used_again=Remote({
            original:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]},
            retry:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]},
            retry2:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]},
        })
        retry3=retry.rsplit(":v",1)[0]+":v000"
        self.assertEqual(claim_cloud_preview(used_again,brief),retry3)
        self.assertEqual(used_again.claimed[0][2]["retry_attempt"],3)

        exhausted=Remote({
            original:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]},
            retry:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]},
            retry2:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]},
            retry3:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]},
        })
        with self.assertRaisesRegex(ValueError,"M9_JOB_RETRY_ALREADY_USED"):
            claim_cloud_preview(exhausted,brief)
        self.assertEqual(exhausted.claimed,[])

        uncertain_retry=Remote({
            original:{"creative_brief_id":brief["id"],"status":"FAILED","telegram_message_ids":[]},
            retry:{"creative_brief_id":brief["id"],"status":"SEND_UNCERTAIN","telegram_message_ids":[]},
        })
        with self.assertRaisesRegex(ValueError,"M9_JOB_ALREADY_CLAIMED_NO_RETRY"):
            claim_cloud_preview(uncertain_retry,brief)
        self.assertEqual(uncertain_retry.claimed,[])

    def test_subprocess_timeout_is_classified_without_exposing_command_output(self):
        with patch("m9_run_pipeline.subprocess.run", side_effect=subprocess.TimeoutExpired("deno", 240)):
            with self.assertRaisesRegex(RuntimeError, "M9_STAGE_TIMEOUT: m9_collect_media.ts"):
                command(["deno", "/workspace/scripts/m9_collect_media.ts", "input.json", "output.json"])

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
