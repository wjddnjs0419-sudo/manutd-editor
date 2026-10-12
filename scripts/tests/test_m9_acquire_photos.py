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
from m9_photo_analysis import CropPlan, NormalizedFace, PhotoEvaluation


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

    def run_choose(self, gathered, downloader=None, detector=None, analyzer=None):
        def fake(url, hosts):
            validate_cdn_url(url, hosts)
            if "/blur" in url:
                return self.blurred_photo, ".jpg"
            if url.endswith("unavailable.jpg"):
                raise ValueError("M9_IMAGE_DOWNLOAD_FAILED")
            return self.photo, ".jpg"

        kwargs = {"detector": detector or self.detector}
        if analyzer is not None:
            kwargs["analyzer"] = analyzer
        return choose_media(gathered, self.root, ["photos.example.org"], downloader or fake, **kwargs)

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

    def test_partial_named_subject_coverage_is_preserved_for_owner_review(self):
        gathered = payload()
        for row in gathered["selections"]:
            row["selected"]["subject_match"] = {
                "requested_subjects": ["Bryan Mbeumo", "Dominic Solanke"],
                "metadata_matched_subjects": ["Bryan Mbeumo"],
                "filename_matched_subjects": [],
                "requested_subject_count": 2,
                "coverage": "PARTIAL",
            }
        result = self.run_choose(gathered, analyzer=lambda _image, _role, _detector: PhotoEvaluation(
            faces=(), face_count=1,
            crop=CropPlan(0, 0, 1, 1, 1, 0.5, 0.5, False, ()),
            quality={"sharpness": 1.0}, review_required=True, flags=(), analysis_ms=0.0,
        ))
        self.assertEqual(result["cover"]["subject_match"]["coverage"], "PARTIAL")
        self.assertIn("SUBJECT_METADATA_PARTIAL", result["cover"]["review_flags"])

    def test_assigns_page_photos_and_reuses_only_when_unique_images_run_out(self):
        gathered = payload()
        second = assessment("https://photos.example.org/photo-2.jpg")
        third = assessment("https://photos.example.org/photo-3.jpg")
        gathered["selections"] = [
            {"slot": "COVER_NEWS", "slide_number": 1, "selected": assessment("https://photos.example.org/photo-1.jpg")},
            {"slot": "BODY_NEWS", "slide_number": 2, "shortlist": [second, third], "selected": second},
            {"slot": "BODY_NEWS", "slide_number": 3, "shortlist": [third, second], "selected": third},
            {"slot": "BODY_NEWS", "slide_number": 4, "shortlist": [
                assessment("https://photos.example.org/photo-1.jpg"), second, third,
            ], "selected": assessment("https://photos.example.org/photo-1.jpg")},
        ]
        colors = {
            "photo-1.jpg": "red", "photo-2.jpg": "green", "photo-3.jpg": "blue",
        }

        def fake(url, hosts):
            validate_cdn_url(url, hosts)
            image = Image.new("RGB", (1800, 1400), colors[url.rsplit("/", 1)[-1]])
            draw = ImageDraw.Draw(image)
            for x in range(0, image.width, 16):
                draw.rectangle((x, 0, min(image.width, x + 7), image.height),
                               fill="#ffffff" if (x // 16) % 2 else "#151515")
            content = BytesIO()
            image.save(content, "JPEG", quality=95)
            return content.getvalue(), ".jpg"

        result = self.run_choose(gathered, fake)
        self.assertEqual([page["slide_number"] for page in result["pages"]], [1, 2, 3, 4])
        self.assertEqual(len({page["source_sha256"] for page in result["pages"]}), 3)
        self.assertEqual([page["image_reuse_status"] for page in result["pages"]], [
            "UNIQUE", "UNIQUE", "UNIQUE", "REUSED_EXACT",
        ])
        self.assertEqual(result["photo_shortage"]["reused_page_count"], 1)
        self.assertEqual(result["body"]["file"], result["pages"][1]["file"])

    def test_one_photo_is_reused_for_every_news_page_without_failing(self):
        gathered = payload()
        one = assessment("https://photos.example.org/only.jpg")
        gathered["selections"] = [
            {"slot": "COVER_NEWS", "slide_number": 1, "selected": one},
            *[
                {"slot": "BODY_NEWS", "slide_number": number, "selected": one}
                for number in (2, 3, 4)
            ],
        ]
        result = self.run_choose(gathered)
        self.assertEqual([row["image_reuse_status"] for row in result["pages"]], [
            "UNIQUE", "REUSED_EXACT", "REUSED_EXACT", "REUSED_EXACT",
        ])
        self.assertEqual(result["photo_shortage"]["unique_image_count"], 1)
        self.assertEqual(result["photo_shortage"]["reused_page_count"], 3)

    def test_two_unique_photos_are_reused_only_after_both_are_assigned(self):
        gathered = payload()
        photo_a = assessment("https://photos.example.org/photo-a.jpg")
        photo_b = assessment("https://photos.example.org/photo-b.jpg")
        gathered["selections"] = [
            {"slot": "COVER_NEWS", "slide_number": 1, "selected": photo_a},
            {"slot": "BODY_NEWS", "slide_number": 2, "selected": photo_b},
            {"slot": "BODY_NEWS", "slide_number": 3, "selected": photo_a},
            {"slot": "BODY_NEWS", "slide_number": 4, "selected": photo_b},
        ]
        variant = Image.new("RGB", (1800, 1400), "#134cba")
        draw = ImageDraw.Draw(variant)
        for x in range(0, variant.width, 24):
            draw.rectangle((x, 0, min(x + 9, variant.width), variant.height), fill="#f3c525")
        encoded = BytesIO()
        variant.save(encoded, "JPEG", quality=94)
        assets = {
            "photo-a.jpg": (self.photo, ".jpg"),
            "photo-b.jpg": (encoded.getvalue(), ".jpg"),
        }

        result = self.run_choose(gathered, lambda url, _hosts: assets[url.rsplit("/", 1)[-1]])

        self.assertEqual(result["photo_shortage"]["unique_image_count"], 2)
        self.assertEqual(result["photo_shortage"]["reused_page_count"], 2)
        self.assertEqual([row["image_reuse_status"] for row in result["pages"]], [
            "UNIQUE", "UNIQUE", "REUSED_EXACT", "REUSED_EXACT",
        ])
        self.assertEqual([row.get("duplicate_of_slide_number") for row in result["pages"]], [
            None, None, 1, 2,
        ])

    def test_five_unique_photos_cover_five_pages_without_reuse(self):
        gathered = payload()
        palette = ["#b02020", "#168d27", "#1b28ad", "#e7d219", "#a516aa"]
        selections = []
        assets = {}
        for number, color in enumerate(palette, start=1):
            filename = f"photo-{number}.jpg"
            row = {"slot": "COVER_NEWS" if number == 1 else "BODY_NEWS",
                   "slide_number": number, "selected": assessment(f"https://photos.example.org/{filename}")}
            selections.append(row)
            image = Image.new("RGB", (1800, 1400), color)
            draw = ImageDraw.Draw(image)
            for x in range(number * 3, image.width, 31 + number):
                draw.rectangle((x, 0, min(x + 10, image.width), image.height), fill="#f4f4f4")
            encoded = BytesIO()
            image.save(encoded, "JPEG", quality=94)
            assets[filename] = (encoded.getvalue(), ".jpg")
        gathered["selections"] = selections

        result = self.run_choose(gathered, lambda url, _hosts: assets[url.rsplit("/", 1)[-1]])

        self.assertEqual(result["photo_shortage"]["unique_image_count"], 5)
        self.assertEqual(result["photo_shortage"]["reused_page_count"], 0)
        self.assertEqual([row["image_reuse_status"] for row in result["pages"]], ["UNIQUE"] * 5)

    def test_detects_same_photo_bytes_from_different_cdn_urls_and_records_reuse(self):
        gathered = payload()
        gathered["selections"] = [
            {"slot": "COVER_NEWS", "slide_number": 1, "selected": assessment("https://photos.example.org/original.jpg")},
            {"slot": "BODY_NEWS", "slide_number": 2, "selected": assessment("https://photos.example.org/variant.jpg")},
        ]
        requests = []

        def fake(url, hosts):
            requests.append(url)
            return self.photo, ".jpg"

        result = self.run_choose(gathered, fake)
        self.assertEqual(len(requests), 2)
        self.assertEqual(result["pages"][0]["source_sha256"], result["pages"][1]["source_sha256"])
        self.assertEqual(result["pages"][1]["image_reuse_status"], "REUSED_EXACT")
        self.assertEqual(result["pages"][1]["duplicate_of_slide_number"], 1)

    def test_perceptual_hash_detects_resized_reencoded_photo_from_another_cdn_url(self):
        gathered = payload()
        gathered["selections"] = [
            {"slot": "COVER_NEWS", "slide_number": 1, "selected": assessment("https://photos.example.org/original.jpg")},
            {"slot": "BODY_NEWS", "slide_number": 2, "selected": assessment("https://photos.example.org/resize.jpg")},
        ]
        resized = Image.open(BytesIO(self.photo)).resize((900, 700), Image.Resampling.LANCZOS)
        encoded = BytesIO()
        resized.save(encoded, "JPEG", quality=84)
        variants = {"original.jpg": (self.photo, ".jpg"), "resize.jpg": (encoded.getvalue(), ".jpg")}

        def fake(url, hosts):
            return variants[url.rsplit("/", 1)[-1]]

        result = self.run_choose(gathered, fake)
        self.assertEqual(result["pages"][1]["image_reuse_status"], "REUSED_PERCEPTUAL")
        body_attempt = result["candidate_attempts"]["body"][-1]
        self.assertEqual(body_attempt["status"], "REUSED")
        self.assertIn("REUSED_PERCEPTUAL", body_attempt["reasons"])

    def test_zero_photos_returns_review_required_state_without_inventing_assets(self):
        gathered = payload()
        gathered["selections"] = [
            {"slot": "COVER_NEWS", "slide_number": 1, "selected": None, "shortlist": []},
            {"slot": "BODY_NEWS", "slide_number": 2, "selected": None, "shortlist": []},
        ]
        result = self.run_choose(gathered)
        self.assertEqual(result["selection_status"], "REVIEW_REQUIRED")
        self.assertEqual(result["pages"], [])
        self.assertEqual(result["photo_shortage"]["missing_slide_numbers"], [1, 2])
        self.assertNotIn("cover", result)

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
