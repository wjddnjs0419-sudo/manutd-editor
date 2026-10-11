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
    brief_slides, checked_media, prepared_render_job, split_hook, job_key, run_preview,
    SupabaseGateway, RemoteError, TelegramGateway,
)

def find_font() -> Path | None:
    for path in [
        os.getenv("M9_TEST_FONT"),
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
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
    }


class FakeGateway:
    def __init__(self):
        self.claimed: set[str] = set()
        self.changes: list[tuple[str, str]] = []
        self.uploaded: list[tuple[str, bytes]] = []
        self.signed: list[str] = []
        self.state: dict[str, str] = {}
        self.fail_sign = False

    def claim(self, key, brief_id, media):
        if key in self.claimed:
            raise ValueError("M9_JOB_ALREADY_CLAIMED_NO_RETRY")
        self.claimed.add(key)
        self.state[key] = "CLAIMED"

    def transition(self, key, previous, next_status, patch=None):
        if self.state[key] != previous:
            raise RuntimeError("M9_STATE_TRANSITION_CONFLICT")
        self.state[key] = next_status
        self.changes.append((previous, next_status))

    def upload_png(self, path, data):
        assert data.startswith(b"\x89PNG\r\n\x1a\n")
        assert path.startswith("previews/") and path.endswith(".png")
        self.uploaded.append((path, data))

    def signed_url(self, path):
        self.signed.append(path)
        if self.fail_sign:
            raise ValueError("M9_SIGN_RESPONSE_INVALID")
        return "https://storage.example.org/storage/v1" + path


class FakeTelegram:
    def __init__(self, *, uncertain=False):
        self.calls: list[tuple[str, list[str], str]] = []
        self.uncertain = uncertain

    def send_album(self, chat_id, urls, caption):
        self.calls.append((chat_id, urls, caption))
        if self.uncertain:
            raise RuntimeError("M9_TELEGRAM_AMBIGUOUS_RESPONSE")
        return [701, 702, 703]


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
        self.assertEqual(p["cover_photo_source"], self.media["cover"]["source_url"])

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

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_full_pipeline_uploads_only_two_pngs_uses_existing_cta_then_sends_three(self):
        store, tel = FakeGateway(), FakeTelegram()
        result = run_preview(self.brief, self.media, self.root, self.root / "out",
                             self.font, None, store, tel, send=True, chat_id="321",
                             cta_file=self.root / "cta.png")
        self.assertEqual(result["status"], "SENT")
        self.assertEqual(result["telegram_message_ids"], [701, 702, 703])
        self.assertEqual(len(store.uploaded), 2)
        self.assertEqual(store.signed[-1], "assets/cta.png")
        self.assertEqual(len(tel.calls), 1)
        self.assertEqual(len(tel.calls[0][1]), 3)
        self.assertEqual(store.changes, [
            ("CLAIMED", "RENDERED"), ("RENDERED", "UPLOADED"),
            ("UPLOADED", "SENDING"), ("SENDING", "SENT")
        ])
        self.assertEqual((self.root / "cta.png").read_bytes(),
                         (self.root / "out" / "slide_03_cta.png").read_bytes())

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_retry_same_brief_and_photos_fails_before_any_second_send(self):
        store, tel = FakeGateway(), FakeTelegram()
        call = lambda: run_preview(self.brief, self.media, self.root, self.root / "out",
                                   self.font, None, store, tel, send=True, chat_id="321")
        call()
        with self.assertRaisesRegex(ValueError, "M9_JOB_ALREADY_CLAIMED_NO_RETRY"):
            call()
        self.assertEqual(len(tel.calls), 1)

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_signed_url_failure_prevents_any_telegram_send(self):
        store, tel = FakeGateway(), FakeTelegram()
        store.fail_sign = True
        with self.assertRaisesRegex(ValueError, "M9_SIGN_RESPONSE_INVALID"):
            run_preview(self.brief, self.media, self.root, self.root / "out",
                        self.font, None, store, tel, send=True, chat_id="321")
        self.assertEqual(len(tel.calls), 0)
        self.assertEqual(store.state[job_key(self.brief, self.media)], "FAILED")

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_uncertain_send_is_marked_uncertain_and_not_retried(self):
        store, tel = FakeGateway(), FakeTelegram(uncertain=True)
        with self.assertRaisesRegex(RuntimeError, "M9_TELEGRAM_AMBIGUOUS_RESPONSE"):
            run_preview(self.brief, self.media, self.root, self.root / "out",
                        self.font, None, store, tel, send=True, chat_id="321")
        self.assertEqual(store.state[job_key(self.brief, self.media)], "SEND_UNCERTAIN")
        self.assertEqual(len(tel.calls), 1)

    @unittest.skipUnless(find_font(), "M9_TEST_FONT needed")
    def test_local_preview_no_remote_calls(self):
        result = run_preview(self.brief, self.media, self.root, self.root / "local",
                             self.font, None, None, None, send=False,
                             cta_file=self.root / "cta.png")
        self.assertEqual(result["status"], "LOCAL_PREVIEW_ONLY")
        self.assertTrue((self.root / "local" / "slide_03_cta.png").is_file())


class M9RemoteSignContract(unittest.TestCase):
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

    def test_http_409_duplicate_claim_is_converted_to_no_retry(self):
        class ConflictHttp:
            def request(self, method, url, headers, body=None):
                raise RemoteError(409, "DUPLICATE")
        sup = SupabaseGateway("https://abc.supabase.co", "mock-role-key", ConflictHttp())
        with self.assertRaisesRegex(ValueError, "M9_JOB_ALREADY_CLAIMED_NO_RETRY"):
            sup.claim("jobkey", BRIEF_ID, {})


if __name__ == "__main__":
    unittest.main()
