"""M9 pipeline contract tests. All transports mocked; NEVER contacts Telegram/Supabase."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_preview_workflow import (
    brief_slides, checked_media, prepared_render_job, split_hook, job_key, pre_send_retry_job_key, run_preview,
    SupabaseGateway, RemoteError, TelegramGateway, telegram_text_chunks, validate_preview_status, preview_caption,
    safe_failure_category,
)

def find_font() -> Path | None:
    for path in [
        os.getenv("M9_TEST_FONT"),
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    ]:
        if path and Path(path).is_file():
            return Path(path)
    return None

BRIEF_ID = "72bf1111-ae15-45ca-a812-3c1e2ee37a10"

def make_brief() -> dict:
    return {
        "id": BRIEF_ID,
        "candidate_id": "72bf1111-ae15-45ca-a812-3c1e2ee37a11",
        "version": 1,
        "generated_at": "2026-10-11T10:00:00Z",
        "slides_json": {"slides": [
            {"slide_number": 1, "headline": "2줄 훅 테스트", "body": ""},
            {"slide_number": 2, "headline": "경기 결과 정리", "body": "전반전이 종료됐다.\n후반전도 종료됐다.", "highlight": "기록을 확인했다"},
        ]},
        "hooks_json": [{"id": "hook_1", "text": "맨유 경기 종료\n결과는 무승부"}],
        "caption_draft": "맨유 경기 최종 결과",
        "content_mode": "NEWS_UPDATE",
        "evidence_snapshot": {
            "story": {"id": "2c2c2c2c-cccc-4ccc-8ccc-cccccccccccc"},
            "exploration_articles": [{"publisher_name": "TEAMtalk", "canonical_url": "https://www.teamtalk.com/manchester-united/news/1"}],
        },
    }


class FakeGateway:
    def __init__(self):
        self.claimed: set[str] = set()
        self.briefs: dict[str, str] = {}
        self.changes: list[tuple[str, str]] = []
        self.patches: list[dict] = []
        self.uploaded: list[tuple[str, bytes]] = []
        self.signed: list[str] = []
        self.state: dict[str, str] = {}
        self.fail_sign = False
        self.fail_verify = False
        self.fail_upload = False
        self.verified: list[str] = []

    def ensure_private_bucket(self):
        self.private_bucket_checked = True

    def get_preview(self, key):
        return {"id": "a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "status": self.state.get(key, "CLAIMED"),
                "creative_brief_id": self.briefs.get(key)}

    def claim(self, key, brief_id, media):
        if key in self.claimed:
            raise ValueError("M9_JOB_ALREADY_CLAIMED_NO_RETRY")
        self.claimed.add(key)
        self.briefs[key] = brief_id
        self.state[key] = "CLAIMED"

    def transition(self, key, previous, next_status, patch=None):
        if self.state[key] != previous:
            raise RuntimeError("M9_STATE_TRANSITION_CONFLICT")
        self.state[key] = next_status
        self.changes.append((previous, next_status))
        self.patches.append(patch or {})

    def upload_png(self, path, data):
        if self.fail_upload:
            raise ValueError("M9_STORAGE_UPLOAD_FAILED")
        assert data.startswith(b"\x89PNG\r\n\x1a\n")
        assert path.startswith("previews/") and path.endswith(".png")
        self.uploaded.append((path, data))

    def verify_uploaded_png(self, path, data):
        import hashlib
        self.verified.append(path)
        if self.fail_verify:
            raise ValueError("M9_STORAGE_SHA256_MISMATCH")
        return hashlib.sha256(data).hexdigest()

    def signed_url(self, path):
        self.signed.append(path)
        if self.fail_sign:
            raise ValueError("M9_SIGN_RESPONSE_INVALID")
        return "https://storage.example.org/storage/v1" + path


class FakeTelegram:
    def __init__(self, *, uncertain=False):
        self.calls: list[tuple[str, list[tuple[str, bytes]]]] = []
        self.text_calls: list[tuple[str, str]] = []
        self.uncertain = uncertain

    def send_album(self, chat_id, urls, caption):
        raise AssertionError("PNG originals should be delivered as documents")

    def send_png_documents(self, chat_id, documents):
        self.calls.append((chat_id, documents))
        if self.uncertain:
            raise RuntimeError("M9_TELEGRAM_AMBIGUOUS_RESPONSE")
        return list(range(701, 701 + len(documents)))

    def send_text(self, chat_id, text):
        self.text_calls.append((chat_id, text))
        if self.uncertain:
            raise RuntimeError("M9_TELEGRAM_AMBIGUOUS_RESPONSE")
        return [704]


class M9IntegrationContracts(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = Path(self.t.name)
        Image.new("RGB", (1800, 1500), "gray").save(self.root / "cover.jpg")
        Image.new("RGB", (1800, 1500), "blue").save(self.root / "body.jpg")
        Image.new("RGB", (1080, 1350), "#812112").save(self.root / "cta.png")
        self.brief = make_brief()
        self.media = {
            "editorial_review_only": True,
            "cover": {
                "file": "cover.jpg",
                "source_url": "https://publisher.example.org/photos/cover.jpg",
                "article_url": "https://publisher.example.org/news/1",
                "credit": "PHOTO: Reporter A", "subject_metadata_checked": True,
                "rights_status": "UNVERIFIED",
            },
            "body": {
                "file": "body.jpg",
                "source_url": "https://publisher.example.org/photos/body.jpg",
                "article_url": "https://publisher.example.org/news/1",
                "credit": "PHOTO: Reporter B", "subject_metadata_checked": True,
                "rights_status": "UNVERIFIED",
            },
        }
        self.font = find_font()

    def tearDown(self):
        self.t.cleanup()

    def test_reads_actual_creative_briefs_slides_json_object(self):
        self.assertEqual(len(brief_slides(self.brief)), 2)
        self.assertEqual(split_hook("첫 번째 줄\n두 번째 줄"), ("첫 번째 줄", "두 번째 줄"))
        p = prepared_render_job(self.brief, self.media)
        self.assertEqual(p["cover_line_one"], "맨유 경기 종료")
        self.assertEqual(p["cover_line_two"], "결과는 무승부")
        self.assertEqual(p["body_paragraphs"], ["전반전이 종료됐다.", "후반전도 종료됐다."])
        self.assertEqual(len(p["body_slides"]), 1)
        self.assertEqual(p["cover_photo_source"], self.media["cover"]["source_url"])

    def test_hook_role_is_first_and_remaining_slides_keep_index_order(self):
        self.brief["slides_json"] = {"slides": [
            {"slide_number": 1, "index": 3, "role": "KEY_FACT", "headline": "세 번째", "body": "세 번째 근거."},
            {"slide_number": 2, "index": 4, "role": "IMPLICATION", "headline": "네 번째", "body": "네 번째 해석."},
            {"slide_number": 3, "index": 1, "role": "CONTEXT", "headline": "첫 배경", "body": "첫 배경 설명."},
            {"slide_number": 4, "index": 2, "role": "HOOK", "headline": "실제 표지", "body": ""},
        ]}
        ordered = brief_slides(self.brief)
        self.assertEqual([slide["role"] for slide in ordered], [
            "HOOK", "CONTEXT", "KEY_FACT", "IMPLICATION",
        ])
        prepared = prepared_render_job(self.brief, self.media)
        self.assertEqual(prepared["cover_source_role"], "HOOK")
        self.assertEqual(prepared["cover_source_index"], 2)
        self.assertEqual([slide["role"] for slide in prepared["body_slides"]], [
            "CONTEXT", "KEY_FACT", "IMPLICATION",
        ])
        self.assertEqual([slide["source_index"] for slide in prepared["body_slides"]], [1, 3, 4])

    def test_explicit_roles_must_be_complete_and_have_one_hook(self):
        self.brief["slides_json"] = {"slides": [
            {"index": 1, "role": "HOOK", "headline": "표지", "body": ""},
            {"index": 2, "headline": "역할 누락", "body": "본문."},
        ]}
        with self.assertRaisesRegex(ValueError, "M9_BRIEF_SLIDE_ROLE_INVALID"):
            brief_slides(self.brief)

        self.brief["slides_json"]["slides"][1]["role"] = "HOOK"
        with self.assertRaisesRegex(ValueError, "M9_BRIEF_HOOK_ROLE_INVALID"):
            brief_slides(self.brief)

    def test_preview_caption_keeps_original_and_appends_article_and_photo_credit(self):
        self.brief["caption_draft"] = "기존 캡션 내용"
        media = {
            "cover": {**self.media["cover"], "credit": "Photo credit: BBC/Getty Images"},
            "body": {**self.media["body"], "credit": "Photo credit: BBC/Getty Images"},
            "pages": [
                {"slide_number": 1, **self.media["cover"], "credit": "Photo credit: BBC/Getty Images"},
                {"slide_number": 2, **self.media["body"], "credit": "Photo credit: BBC/Getty Images"},
            ],
        }
        caption = preview_caption(self.brief, media)
        self.assertIn("기존 캡션 내용", caption)
        self.assertIn("https://publisher.example.org/news/1", caption)
        self.assertIn("Photo credit: BBC/Getty Images", caption)
        self.assertEqual(caption.count("Photo credit: BBC/Getty Images"), 1)

    def test_caption_split_respects_telegram_utf16_limit_without_losing_text(self):
        original = "📋 캡션\n" + ("맨유⚽ " * 1600)
        chunks = telegram_text_chunks(original)
        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks), original.strip())
        self.assertTrue(all(len(chunk.encode("utf-16-le")) // 2 <= 4096 for chunk in chunks))

    def test_maps_page_media_and_preserves_legacy_cover_body_aliases(self):
        self.brief["slides_json"]["slides"].append({
            "slide_number": 3, "headline": "후속 내용", "body": "기사의 추가 근거를 소개한다.",
        })
        page_three = {
            **self.media["body"], "file": "body.jpg",
            "source_url": "https://publisher.example.org/photos/page-three.jpg",
        }
        media = {**self.media, "pages": [
            {"slide_number": 1, **self.media["cover"]},
            {"slide_number": 2, **self.media["body"]},
            {"slide_number": 3, **page_three},
        ]}
        prepared = prepared_render_job(self.brief, media)
        self.assertEqual(prepared["page_photos"]["1"]["file"], "cover.jpg")
        self.assertEqual(prepared["body_slides"][1]["photo"]["source_url"], page_three["source_url"])
        self.assertEqual(prepared["body_photo"], "body.jpg")

    def test_exploration_page_bounds_apply_by_mode_and_leave_ready_unchanged(self):
        draft = {
            **self.brief, "status": "DRAFT", "content_mode": "ANALYSIS_CONTEXT",
            "generation_metadata": {"generation_intent": "EXPLORATION"},
            "slides_json": {"slides": [dict(slide) for slide in self.brief["slides_json"]["slides"]]},
        }
        with self.assertRaisesRegex(ValueError, "M9_EXPLORATION_SLIDE_COUNT_INVALID"):
            prepared_render_job(draft, self.media)
        for slide_number in (3, 4):
            draft["slides_json"]["slides"].append({
                "slide_number": slide_number, "headline": f"추가 근거 {slide_number}",
                "body": f"원문 근거를 설명한다. {slide_number}",
            })
        self.assertEqual(len(prepared_render_job(draft, self.media)["body_slides"]), 3)
        ready = {**make_brief(), "status": "READY", "content_mode": "ANALYSIS_CONTEXT"}
        self.assertEqual(len(prepared_render_job(ready, self.media)["body_slides"]), 1)

    def test_prepared_render_job_carries_crop_quality_faces_and_manual_focus(self):
        crop = {"x": 0.1, "y": 0.0, "width": 0.6, "height": 1.0, "scale": 1.0,
                "focus_x": 0.4, "focus_y": 0.5, "review_required": False, "flags": []}
        face = {"x": 0.2, "y": 0.2, "width": 0.1, "height": 0.1, "confidence": 0.9}
        self.media["cover"].update({
            "crop": crop, "faces": [face], "quality": {"crop_scale": 1.0},
            "review_required": False, "review_flags": [], "cover_focus_x": 0.7,
            "cover_focus_y": 0.4,
        })
        self.media["body"].update({
            "crop": crop, "faces": [face], "quality": {"crop_scale": 1.2},
            "review_required": True, "review_flags": ["MANUAL_FOCUS"],
            "body_focus_x": 0.3, "body_focus_y": 0.6,
        })
        p = prepared_render_job(self.brief, self.media)
        self.assertEqual(p["cover_crop"], crop)
        self.assertEqual(p["cover_faces"], [face])
        self.assertEqual(p["cover_quality"], {"crop_scale": 1.0})
        self.assertEqual(p["cover_focus_x"], 0.7)
        self.assertEqual(p["cover_focus_y"], 0.4)
        self.assertEqual(p["body_crop"], crop)
        self.assertEqual(p["body_faces"], [face])
        self.assertEqual(p["body_quality"], {"crop_scale": 1.2})
        self.assertEqual(p["body_review_flags"], ["MANUAL_FOCUS"])
        self.assertEqual(p["body_focus_x"], 0.3)
        self.assertEqual(p["body_focus_y"], 0.6)

    def test_draft_preview_requires_explicit_opt_in_and_exploration_intent(self):
        draft = {**self.brief, "status": "DRAFT", "generation_metadata": {"generation_intent": "EXPLORATION"}}
        with self.assertRaisesRegex(ValueError, "M9_DRAFT_PREVIEW_REQUIRES_OPT_IN"):
            validate_preview_status(draft)
        validate_preview_status(draft, allow_draft_preview=True)
        with self.assertRaisesRegex(ValueError, "M9_DRAFT_EXPLORATION_REQUIRED"):
            validate_preview_status({**draft, "generation_metadata": {}}, allow_draft_preview=True)

    def test_draft_preview_cannot_send_telegram(self):
        draft = {**self.brief, "status": "DRAFT", "generation_metadata": {"generation_intent": "EXPLORATION"}}
        with self.assertRaisesRegex(ValueError, "M9_DRAFT_TELEGRAM_SEND_REQUIRES_OWNER_OPT_IN"):
            run_preview(draft, {}, self.root, self.root / "out", Path("unused"), None,
                        None, None, send=True, allow_draft_preview=True)

    def test_refuses_tampered_media_bytes(self):
        import hashlib
        altered = {**self.media, "cover": {**self.media["cover"],
            "source_sha256": hashlib.sha256(b"different file").hexdigest()}}
        with self.assertRaisesRegex(ValueError, "M9_MEDIA_HASH_MISMATCH"):
            checked_media(altered, self.root)
        valid = {**self.media, "cover": {**self.media["cover"],
            "source_sha256": hashlib.sha256((self.root / "cover.jpg").read_bytes()).hexdigest()}}
        checked_media(valid, self.root)

    def test_rotating_signed_photo_urls_do_not_create_second_job(self):
        import copy
        altered = copy.deepcopy(self.media)
        altered["cover"]["source_url"] += "?s=new-temporary-cdn-signature"
        altered["body"]["source_sha256"] = "1" * 64
        self.assertEqual(job_key(self.brief, altered), job_key(self.brief, self.media))
        changed_revision = copy.deepcopy(self.brief)
        changed_revision["version"] += 1
        self.assertNotEqual(job_key(changed_revision, altered), job_key(self.brief, self.media))

    def test_refuses_unreviewed_media_or_path_traversal(self):
        altered = {**self.media, "editorial_review_only": False}
        with self.assertRaisesRegex(ValueError, "M9_REVIEW_ONLY_REQUIRED"):
            checked_media(altered, self.root)
        altered = {**self.media, "cover": {**self.media["cover"], "file": "../secrets.jpg"}}
        with self.assertRaisesRegex(ValueError, "M9_MEDIA_FILE_INVALID"):
            checked_media(altered, self.root)
        self.assertEqual(job_key(self.brief, self.media), job_key(self.brief, self.media))

    def test_failure_category_persists_only_safe_m9_code(self):
        self.assertEqual(safe_failure_category(ValueError("M9_STORAGE_UPLOAD_FAILED")), "STORAGE_UPLOAD_FAILED")
        self.assertEqual(safe_failure_category(RuntimeError("M9_STAGE_TIMEOUT: m9_collect_media.ts")), "STAGE_TIMEOUT")
        self.assertEqual(safe_failure_category(RuntimeError("secret-key: https://example.test")), "PREVIEW_PIPELINE_FAILED")

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_full_pipeline_sends_copyable_caption_separately_from_ordered_album(self):
        store, tel = FakeGateway(), FakeTelegram()
        result = run_preview(self.brief, self.media, self.root, self.root / "out",
                             self.font, None, store, tel, send=True, chat_id="321",
                             cta_file=self.root / "cta.png")
        self.assertEqual(result["status"], "SENT")
        self.assertEqual(result["telegram_message_ids"], [701, 702, 703, 704])
        self.assertEqual(len(store.uploaded), 3)
        self.assertEqual(store.uploaded[-1][0].endswith("/slide_03.png"), True)
        self.assertEqual(store.verified, [path for path, _ in store.uploaded])
        self.assertTrue(store.private_bucket_checked)
        self.assertEqual(len(tel.calls), 1)
        self.assertEqual(len(tel.calls[0][1]), 3)
        self.assertEqual([name for name, _ in tel.calls[0][1]], ["slide_01.png", "slide_02.png", "slide_03.png"])
        self.assertEqual([data for _, data in tel.calls[0][1]], [data for _, data in store.uploaded])
        self.assertEqual(tel.text_calls, [
            ("321", "🔒 비공개 Storage 업로드와 PNG SHA-256 검증을 마쳤습니다. 이제 전체 카드뉴스와 캡션을 전달합니다."),
            ("321", "📋 Instagram 캡션 (복사)\n\n맨유 경기 최종 결과\n\n원문: https://publisher.example.org/news/1\n\n사진 크레딧: PHOTO: Reporter A / PHOTO: Reporter B"),
        ])
        manifest = store.patches[1]["rendered_manifest"]
        self.assertEqual(manifest["job_id"], "a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        self.assertEqual(manifest["story_cluster_id"], "2c2c2c2c-cccc-4ccc-8ccc-cccccccccccc")
        self.assertEqual(manifest["source_publisher"], "TEAMtalk")
        self.assertEqual(manifest["source_url"], "https://www.teamtalk.com/manchester-united/news/1")
        self.assertEqual(manifest["slide_count"], 3)
        self.assertEqual(manifest["slides"][-1]["kind"], "CTA")
        self.assertEqual(store.patches[-1]["rendered_manifest"]["status"], "SENT")
        self.assertEqual(store.changes, [
            ("CLAIMED", "RENDERED"), ("RENDERED", "UPLOADED"),
            ("UPLOADED", "SENDING"), ("SENDING", "SENT")
        ])
        self.assertEqual((self.root / "cta.png").read_bytes(),
                         (self.root / "out" / "slide_03_cta.png").read_bytes())

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_explicit_owner_opt_in_allows_exploration_draft_review_send(self):
        draft = {**self.brief, "status": "DRAFT", "content_mode": "NEWS_UPDATE",
                 "generation_metadata": {"generation_intent": "EXPLORATION"}}
        store, tel = FakeGateway(), FakeTelegram()
        result = run_preview(draft, self.media, self.root, self.root / "draft-send",
                             self.font, None, store, tel, send=True, chat_id="321",
                             cta_file=self.root / "cta.png", allow_draft_preview=True,
                             allow_draft_telegram_send=True)
        self.assertEqual(result["status"], "SENT")
        self.assertEqual(len(tel.calls), 1)

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_retry_same_brief_and_photos_fails_before_any_second_send(self):
        store, tel = FakeGateway(), FakeTelegram()
        call = lambda: run_preview(self.brief, self.media, self.root, self.root / "out",
                                   self.font, None, store, tel, send=True, chat_id="321",
                                   cta_file=self.root / "cta.png")
        call()
        with self.assertRaisesRegex(ValueError, "M9_JOB_ALREADY_CLAIMED_NO_RETRY"):
            call()
        self.assertEqual(len(tel.calls), 1)

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_renderer_continues_existing_cloud_claim_without_claiming_a_second_job(self):
        store, tel = FakeGateway(), FakeTelegram()
        key = job_key(self.brief, {})
        store.claim(key, self.brief["id"], {"source": "photo-pipeline-start"})
        result = run_preview(self.brief, self.media, self.root, self.root / "preclaimed",
                             self.font, None, store, tel, send=False,
                             cta_file=self.root / "cta.png", job_already_claimed=True)
        self.assertEqual(result["status"], "UPLOADED")
        self.assertEqual(store.claimed, {key})
        self.assertEqual(store.changes, [("CLAIMED", "RENDERED"), ("RENDERED", "UPLOADED")])

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_renderer_continues_reserved_pre_send_retry_claim(self):
        first = pre_send_retry_job_key(self.brief)
        retry_keys = [first, first.rsplit(":v", 1)[0] + ":v00", first.rsplit(":v", 1)[0] + ":v000"]
        for index, key in enumerate(retry_keys):
            with self.subTest(key=key):
                store, tel = FakeGateway(), FakeTelegram()
                store.claim(key, self.brief["id"], {"retry_reason": "CONFIRMED_PRE_SEND_FAILURE"})
                result = run_preview(self.brief, self.media, self.root, self.root / f"retry-preclaimed-{index}",
                                     self.font, None, store, tel, send=False,
                                     cta_file=self.root / "cta.png", job_already_claimed=True,
                                     job_key_override=key)
                self.assertEqual(result["job_key"], key)
                self.assertEqual(store.claimed, {key})

    def test_renderer_rejects_unrecognized_job_key_override(self):
        store, tel = FakeGateway(), FakeTelegram()
        with self.assertRaisesRegex(ValueError, "M9_JOB_KEY_INVALID"):
            run_preview(self.brief, self.media, self.root, self.root / "invalid-job-key",
                        Path("unused"), None, store, tel, send=False,
                        job_already_claimed=True, job_key_override="m9:other:v0")
        self.assertEqual(store.claimed, set())

    def test_renderer_rejects_a_missing_preclaim_without_making_one(self):
        store, tel = FakeGateway(), FakeTelegram()
        with self.assertRaisesRegex(ValueError, "M9_JOB_CLAIM_NOT_ACTIVE"):
            run_preview(self.brief, self.media, self.root, self.root / "missing-preclaim",
                        Path("unused"), None, store, tel, send=False,
                        cta_file=self.root / "cta.png", job_already_claimed=True)
        self.assertEqual(store.claimed, set())
        self.assertEqual(tel.calls, [])

    def test_preclaimed_job_cannot_be_used_without_remote_gateway(self):
        with self.assertRaisesRegex(ValueError, "M9_JOB_CLAIM_REMOTE_REQUIRED"):
            run_preview(self.brief, self.media, self.root, self.root / "local-preclaim",
                        Path("unused"), None, None, None, send=False,
                        cta_file=self.root / "cta.png", job_already_claimed=True)

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_storage_sha_failure_prevents_any_telegram_send(self):
        store, tel = FakeGateway(), FakeTelegram()
        store.fail_verify = True
        with self.assertRaisesRegex(ValueError, "M9_STORAGE_SHA256_MISMATCH"):
            run_preview(self.brief, self.media, self.root, self.root / "out",
                        self.font, None, store, tel, send=True, chat_id="321",
                        cta_file=self.root / "cta.png")
        self.assertEqual(len(tel.calls), 0)
        self.assertEqual(store.state[job_key(self.brief, self.media)], "FAILED")

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_storage_upload_failure_marks_job_failed_and_prevents_any_telegram_send(self):
        store, tel = FakeGateway(), FakeTelegram()
        store.fail_upload = True
        with self.assertRaisesRegex(ValueError, "M9_STORAGE_UPLOAD_FAILED"):
            run_preview(self.brief, self.media, self.root, self.root / "out-upload-fail",
                        self.font, None, store, tel, send=True, chat_id="321",
                        cta_file=self.root / "cta.png")
        self.assertEqual(store.state[job_key(self.brief, self.media)], "FAILED")
        self.assertEqual(tel.calls, [])
        self.assertEqual(tel.text_calls, [])
        self.assertEqual(store.patches[-1]["error_category"], "STORAGE_UPLOAD_FAILED")

    def test_render_failure_marks_claim_failed_and_never_contacts_telegram(self):
        from unittest.mock import patch
        store, tel = FakeGateway(), FakeTelegram()
        with patch("m9_preview_workflow.render", side_effect=ValueError("M9_RENDER_FAILED")):
            with self.assertRaisesRegex(ValueError, "M9_RENDER_FAILED"):
                run_preview(self.brief, self.media, self.root, self.root / "out-render-fail",
                            Path("unused"), None, store, tel, send=True, chat_id="321",
                            cta_file=self.root / "cta.png")
        self.assertEqual(store.state[job_key(self.brief, self.media)], "FAILED")
        self.assertEqual(tel.calls, [])
        self.assertEqual(tel.text_calls, [])
        self.assertEqual(store.patches[-1]["error_category"], "RENDER_FAILED")

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_uncertain_send_is_marked_uncertain_and_not_retried(self):
        store, tel = FakeGateway(), FakeTelegram(uncertain=True)
        with self.assertRaisesRegex(RuntimeError, "M9_TELEGRAM_AMBIGUOUS_RESPONSE"):
            run_preview(self.brief, self.media, self.root, self.root / "out",
                        self.font, None, store, tel, send=True, chat_id="321",
                        cta_file=self.root / "cta.png")
        self.assertEqual(store.state[job_key(self.brief, self.media)], "SEND_UNCERTAIN")
        self.assertEqual(len(tel.calls), 1)

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_local_preview_no_remote_calls(self):
        result = run_preview(self.brief, self.media, self.root, self.root / "local",
                             self.font, None, None, None, send=False,
                             cta_file=self.root / "cta.png")
        self.assertEqual(result["status"], "LOCAL_PREVIEW_ONLY")
        self.assertTrue((self.root / "local" / "slide_03_cta.png").is_file())

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_exploration_preview_renders_every_content_slide_and_cta(self):
        brief = {**self.brief, "status": "DRAFT", "generation_metadata": {"generation_intent": "EXPLORATION"},
                 "content_mode": "NEWS_UPDATE",
                 "evidence_snapshot": {"exploration_articles": [{"published_at": "2026-10-12T09:00:00Z"}]},
                 "slides_json": {"slides": [
                     {"slide_number": 1, "headline": "맨유의 이적설", "body": ""},
                     {"slide_number": 2, "headline": "보도 내용", "body": "BBC Sport는 맨유의 관심을 보도했다."},
                     {"slide_number": 3, "headline": "확정은 아니다", "body": "구단은 영입을 확정하지 않았다."},
                 ]}}
        result = run_preview(brief, self.media, self.root, self.root / "exploration",
                             self.font, None, None, None, send=False,
                             cta_file=self.root / "cta.png", body_font_file=self.font,
                             allow_draft_preview=True)
        self.assertEqual(result["status"], "LOCAL_PREVIEW_ONLY")
        self.assertEqual(result["rendered"], [
            "slide_01_cover_news.png", "slide_02_body_news.png", "slide_03_body_news.png",
        ])
        self.assertTrue((self.root / "exploration" / "slide_04_cta.png").is_file())


class M9RemoteSignContract(unittest.TestCase):
    def test_upload_guard_allows_six_news_pages_plus_cta(self):
        class UploadHttp:
            def request(self, method, url, headers, body=None):
                assert method == "POST"
                assert url.endswith("/slide_07.png")
                assert headers["content-type"] == "image/png"
                return b""

        sup = SupabaseGateway("https://abc.supabase.co", "mock-role-key", UploadHttp())
        sup.upload_png("previews/72bf1111-ae15-45ca-a812-3c1e2ee37a10/slide_07.png",
                       b"\x89PNG\r\n\x1a\nvalid")
        with self.assertRaisesRegex(ValueError, "M9_INVALID_STORAGE_PATH"):
            sup.upload_png("previews/72bf1111-ae15-45ca-a812-3c1e2ee37a10/slide_08.png",
                           b"\x89PNG\r\n\x1a\nvalid")

    def test_signer_handles_relative_private_storage_signed_url(self):
        class FakeHttp:
            def request(self, method, url, headers, body=None):
                self_args = (method,url)
                assert method == "POST"
                assert "/object/sign/" in url
                return b'{"signedURL": "/object/sign/manutd-card-assets/assets/cta.png?token=123"}'
        sup = SupabaseGateway("https://abc.supabase.co", "mock-role-key", FakeHttp())
        self.assertEqual(sup.signed_url("assets/cta.png"),
            "https://abc.supabase.co/storage/v1/object/sign/manutd-card-assets/assets/cta.png?token=123")

    def test_telegram_receives_ordered_png_documents_as_exact_multipart_bytes(self):
        class TelegramHttp:
            def request(self, method, url, headers, body=None):
                self.request_row = (method, url, headers, body)
                return b'{"ok":true,"result":[{"message_id":11},{"message_id":12}]}'
        transport=TelegramHttp()
        telegram=TelegramGateway("mock-token",transport)
        payloads=[("slide_01.png",b"\x89PNG\r\n\x1a\ncover"),("slide_02.png",b"\x89PNG\r\n\x1a\ncta")]
        self.assertEqual(telegram.send_png_documents("321",payloads),[11,12])
        method,url,headers,body=transport.request_row
        self.assertEqual(method,"POST")
        self.assertTrue(url.endswith("/sendMediaGroup"))
        self.assertIn("multipart/form-data; boundary=",headers["content-type"])
        self.assertIn(b'"type":"document"',body)
        self.assertIn(b'"media":"attach://document1"',body)
        self.assertIn(b'filename="slide_01.png"',body)
        self.assertIn(payloads[0][1],body)
        self.assertIn(payloads[1][1],body)

    def test_http_409_duplicate_claim_is_converted_to_no_retry(self):
        class ConflictHttp:
            def request(self, method, url, headers, body=None):
                raise RemoteError(409, "DUPLICATE")
        sup = SupabaseGateway("https://abc.supabase.co", "mock-role-key", ConflictHttp())
        with self.assertRaisesRegex(ValueError, "M9_JOB_ALREADY_CLAIMED_NO_RETRY"):
            sup.claim("jobkey", BRIEF_ID, {})


if __name__ == "__main__":
    unittest.main()
