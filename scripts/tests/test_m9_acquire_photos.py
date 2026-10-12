"""Bounded publisher-photo acquisition with crop-aware ordered fallback."""
from __future__ import annotations

import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_acquire_photos import choose_media, fetch_bounded_image, validate_cdn_url
from m9_photo_analysis import NormalizedFace


def assessment(url: str, old: bool = False) -> dict:
    return {
        "identity_evidence": "ALT_OR_CAPTION_MATCH",
        "requires_review": True,
        "can_auto_publish": False,
        "flags": ["ARCHIVE_PHOTO"] if old else ["REUSE_RIGHTS_UNVERIFIED"],
        "probe": {
            "status": "VALID", "width": 1800, "height": 1400,
            "mime_type": "image/jpeg", "bytes_read": 4000,
        },
        "candidate": {
            "image_url": url,
            "article_url": "https://news.example.org/football/story",
            "credit": "Photographer B / News Agency",
            "rights_status": "UNVERIFIED",
            "caption": "Bruno Fernandes scores in Manchester",
        },
    }


def selection(role: str, url: str = "https://photos.example.org/photo.jpg", old: bool = False) -> dict:
    chosen = assessment(url, old=old)
    return {"slot": role, "selected": chosen}


def payload() -> dict:
    return {
        "schema_version": "m9-media-v1",
        "review_only": True,
        "rights_status": "UNVERIFIED",
        "status": "CANDIDATES_FOR_REVIEW",
        "selections": [selection("COVER_NEWS"), selection("BODY_NEWS")],
    }


class FakeDetector:
    def __init__(self, faces: list[NormalizedFace] | None = None):
        self.faces = faces if faces is not None else [
            NormalizedFace(0.40, 0.28, 0.20, 0.24, 0.95)
        ]

    def detect(self, image: Image.Image) -> list[NormalizedFace]:
        return list(self.faces)


def photo_bytes(blur_radius: float = 0, size: tuple[int, int] = (1800, 1400)) -> bytes:
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    for x in range(0, image.width, 16):
        color = "#303030" if (x // 16) % 2 else "#dedede"
        draw.rectangle((x, 0, min(image.width, x + 7), image.height), fill=color)
    if blur_radius:
        image = image.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    content = BytesIO()
    image.save(content, format="JPEG", quality=95)
    return content.getvalue()


class TestAcquire(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.photo = photo_bytes()
        self.blurred_photo = photo_bytes(blur_radius=6)
        self.small_photo = photo_bytes(size=(720, 900))
        self.detector = FakeDetector()

    def tearDown(self):
        self.tmp.cleanup()

    def run_choose(self, gathered, downloader=None, detector=None):
        def fake(url, hosts):
            validate_cdn_url(url, hosts)
            if "/blur" in url:
                return self.blurred_photo, ".jpg"
            if url.endswith("unavailable.jpg"):
                raise ValueError("M9_IMAGE_DOWNLOAD_FAILED")
            return self.photo, ".jpg"

        return choose_media(
            gathered,
            self.root,
            ["photos.example.org"],
            downloader or fake,
            detector=detector or self.detector,
        )

    def test_two_roles_one_download_for_same_url(self):
        requests = []

        def fake(url, hosts):
            validate_cdn_url(url, hosts)
            requests.append(url)
            return self.photo, ".jpg"

        result = self.run_choose(payload(), fake)
        self.assertEqual(requests, ["https://photos.example.org/photo.jpg"])
        self.assertEqual(result["cover"]["file"], "cover.jpg")
        self.assertEqual(result["body"]["file"], "body.jpg")
        self.assertEqual((self.root / "cover.jpg").read_bytes(), self.photo)
        self.assertTrue((self.root / "media.json").is_file())
        self.assertFalse(result["cover"]["visual_subject_verified"])
        self.assertEqual(result["rights_status"], "UNVERIFIED")
        self.assertIn("crop", result["cover"])
        self.assertIn("faces", result["cover"])
        self.assertIn("quality", result["cover"])

    def test_tries_next_candidate_when_crop_gate_fails(self):
        gathered = payload()
        row = gathered["selections"][0]
        failed = assessment("https://photos.example.org/blur.jpg")
        passed = assessment("https://photos.example.org/sharp.jpg")
        row["shortlist"] = [failed, passed]
        row["selected"] = failed

        result = self.run_choose(gathered)

        self.assertEqual(result["cover"]["source_url"], passed["candidate"]["image_url"])
        self.assertEqual(result["candidate_attempts"]["cover"][0]["status"], "REJECTED")
        self.assertIn(
            "FACE_SHARPNESS_BELOW_THRESHOLD",
            result["candidate_attempts"]["cover"][0]["reasons"],
        )
        self.assertEqual(result["candidate_attempts"]["cover"][1]["status"], "SELECTED")

    def test_stops_after_first_passing_candidate(self):
        gathered = payload()
        first = assessment("https://photos.example.org/first.jpg")
        second = assessment("https://photos.example.org/second.jpg")
        gathered["selections"][0]["shortlist"] = [first, second]
        gathered["selections"][0]["selected"] = first
        requested = []

        def fake(url, hosts):
            requested.append(url)
            return self.photo, ".jpg"

        result = self.run_choose(gathered, fake)
        self.assertEqual(result["cover"]["source_url"], first["candidate"]["image_url"])
        self.assertNotIn(second["candidate"]["image_url"], requested)
        self.assertEqual(len(result["candidate_attempts"]["cover"]), 1)

    def test_limits_full_downloads_to_three_per_slot(self):
        gathered = payload()
        candidates = [
            assessment(f"https://photos.example.org/blur-{index}.jpg")
            for index in range(4)
        ]
        gathered["selections"][0]["shortlist"] = candidates
        gathered["selections"][0]["selected"] = candidates[0]
        requested = []

        def fake(url, hosts):
            requested.append(url)
            return self.blurred_photo, ".jpg"

        result = self.run_choose(gathered, fake)
        cover_requested = [url for url in requested if "/blur-" in url]
        self.assertEqual(len(cover_requested), 3)
        self.assertEqual(len(result["candidate_attempts"]["cover"]), 3)
        self.assertEqual(result["selection_status"], "REVIEW_REQUIRED")

    def test_bounded_fallback_and_duplicate_download_cache(self):
        gathered = payload()
        duplicate = assessment("https://photos.example.org/unavailable.jpg")
        good = assessment("https://photos.example.org/sharp.jpg")
        gathered["selections"][0]["shortlist"] = [duplicate, duplicate.copy(), good]
        gathered["selections"][0]["selected"] = duplicate
        requested = []

        def fake(url, hosts):
            requested.append(url)
            validate_cdn_url(url, hosts)
            if url.endswith("unavailable.jpg"):
                raise ValueError("M9_IMAGE_DOWNLOAD_FAILED")
            return self.photo, ".jpg"

        result = self.run_choose(gathered, fake)
        self.assertEqual(requested.count("https://photos.example.org/unavailable.jpg"), 1)
        self.assertEqual(result["cover"]["source_url"], good["candidate"]["image_url"])

    def test_all_candidates_failed_returns_review_reasons(self):
        gathered = payload()
        for row in gathered["selections"]:
            first = assessment("https://photos.example.org/blur.jpg")
            second = assessment("https://photos.example.org/blur-2.jpg")
            row["shortlist"] = [first, second]
            row["selected"] = first

        result = self.run_choose(gathered)

        self.assertEqual(result["selection_status"], "REVIEW_REQUIRED")
        self.assertIn("cover", result["candidate_rejections"])
        self.assertIn("body", result["candidate_rejections"])
        self.assertTrue(all(
            "FACE_SHARPNESS_BELOW_THRESHOLD" in item["reasons"]
            for role in ("cover", "body")
            for item in result["candidate_rejections"][role]
        ))
        self.assertFalse((self.root / "cover.jpg").exists())

    def test_no_face_candidate_remains_reviewable(self):
        result = self.run_choose(payload(), detector=FakeDetector([]))
        self.assertTrue(result["cover"]["review_required"])
        self.assertIn("NO_FACE_DETECTED", result["cover"]["review_flags"])
        self.assertEqual(result["selection_status"], "CANDIDATES_FOR_REVIEW")

    def test_reject_unmatched_subject(self):
        gathered = payload()
        gathered["selections"][0]["selected"]["identity_evidence"] = "UNCONFIRMED"
        with self.assertRaisesRegex(ValueError, "M9_SUBJECT_METADATA_NOT_CONFIRMED"):
            self.run_choose(gathered)

    def test_reject_archive_or_missing_slot(self):
        gathered = payload()
        gathered["selections"][0]["selected"]["flags"] = ["ARCHIVE_PHOTO"]
        with self.assertRaisesRegex(ValueError, "ARCHIVED_PHOTO"):
            self.run_choose(gathered)
        gathered = payload()
        gathered["selections"] = gathered["selections"][:1]
        with self.assertRaisesRegex(ValueError, "M9_PHOTO_REVIEW_REQUIRED_BODY_NEWS"):
            self.run_choose(gathered)

    def test_reject_untrusted_cdn(self):
        for url in (
            "http://photos.example.org/photo.jpg",
            "https://photos.example.org.evil.org/p.jpg",
            "https://127.0.0.1/a.jpg",
            "https://photos.example.org:444/p.jpg",
        ):
            with self.assertRaises(ValueError):
                validate_cdn_url(url, ["photos.example.org"])
        validate_cdn_url(
            "https://photos.example.org/path?width=1920&s=hash",
            ["photos.example.org"],
        )

    def test_untrusted_candidate_host_aborts_before_fallback_download(self):
        gathered = payload()
        blocked = assessment("https://photos.example.org.evil.org/blocked.jpg")
        fallback = assessment("https://photos.example.org/sharp.jpg")
        gathered["selections"][0]["shortlist"] = [blocked, fallback]
        gathered["selections"][0]["selected"] = blocked
        requests = []

        def fake(url, hosts):
            requests.append(url)
            return self.photo, ".jpg"

        with self.assertRaisesRegex(ValueError, "M9_IMAGE_HOST_NOT_APPROVED"):
            self.run_choose(gathered, fake)
        self.assertEqual(requests, [])

    def test_720x900_image_reaches_crop_scale_quality_gate(self):
        class FakeResponse:
            def __init__(self):
                self.headers = {
                    "content-length": str(len(small_photo)),
                    "content-type": "image/jpeg",
                }

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, limit):
                return self_payload

        class FakeOpener:
            def open(self, request, timeout):
                return FakeResponse()

        small_photo = self.small_photo
        self_payload = small_photo
        with patch("m9_acquire_photos.urllib.request.build_opener", return_value=FakeOpener()):
            body, ext = fetch_bounded_image(
                "https://photos.example.org/small.jpg", ["photos.example.org"]
            )
        self.assertEqual(body, self.small_photo)
        self.assertEqual(ext, ".jpg")


if __name__ == "__main__":
    unittest.main()
