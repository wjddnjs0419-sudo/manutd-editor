"""Unit tests for the M9 Pillow private-preview renderer. No news photos bundled."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from PIL import ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_render_news_deck import SIZE, render, _record_body_text_overlap


def find_font() -> Path | None:
    for p in [
        os.environ.get("M9_TEST_FONT"),
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    ]:
        if p and Path(p).is_file():
            return Path(p)
    return None


@unittest.skipUnless(find_font(), "Provide a Korean font through M9_TEST_FONT")
class M9RenderSmoke(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.font = find_font()
        assert self.font
        body_font = os.environ.get("M9_TEST_BODY_FONT")
        self.body_font = Path(body_font) if body_font and Path(body_font).is_file() else self.font
        Image.new("RGB", (2000, 1500), "#404448").save(self.root / "cover.jpg")
        Image.new("RGB", (1800, 1500), "#69626e").save(self.root / "body.jpg")
        Image.new("RGBA", (300, 300), (150, 20, 30, 255)).save(self.root / "logo.png")
        Image.new("RGB", SIZE, "#222222").save(self.root / "cta.png")
        self.data = {
            "article_url": "https://news.example.org/match",
            "article_published_at": "2026-10-10",
            "cover_line_one": "맨유의 경기",
            "cover_line_two": "다음 상대는?",
            "body_headline": "경기 요약",
            "body_paragraphs": ["후반전 주요 장면을 정리했다.", "실제 기사 내용을 바탕으로 작성했다."],
            "body_highlight": "공식 확인된 내용만",
            "cover_photo": "cover.jpg",
            "body_photo": "body.jpg",
            "cover_photo_credit": "PHOTO: CREDIT TEST",
            "body_photo_credit": "PHOTO: CREDIT TEST",
            "cover_photo_source": "https://news.example.org/a.jpg",
            "body_photo_source": "https://news.example.org/b.jpg",
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_renders_full_bleed_cover_body_plus_exact_cta(self) -> None:
        out = self.root / "out"
        report = render(self.data, self.root, out, self.font,
                        self.root / "logo.png", self.root / "cta.png",
                        body_font_path=self.body_font)
        self.assertEqual(len(report["slides"]), 3)
        self.assertEqual(report["state"], "PRIVATE_PREVIEW_REQUIRES_REVIEW")
        for entry in report["slides"]:
            with Image.open(out / entry["file"]) as image:
                self.assertEqual(image.size, SIZE)
        self.assertEqual((self.root / "cta.png").read_bytes(),
                         (out / "slide_03_cta.png").read_bytes())
        self.assertFalse(report["approval"]["auto_publishing_allowed"])
        self.assertFalse(report["approval"]["image_reuse_rights"])
        for slide in report["slides"][:-1]:
            for text in slide["text_bounds"]:
                x0, y0, x1, y1 = text["bounds"]
                self.assertGreaterEqual(x0, 0)
                self.assertGreaterEqual(y0, 0)
                self.assertLessEqual(x1, SIZE[0])
                self.assertLessEqual(y1, SIZE[1])
                self.assertGreaterEqual(text["contrast_ratio"], 3.0)
        self.assertEqual(json.loads((out / "manifest.json").read_text())["article_url"],
                         self.data["article_url"])

    def test_rejects_tiny_photo(self) -> None:
        Image.new("RGB", (200, 240)).save(self.root / "tiny.jpg")
        self.data["cover_photo"] = "tiny.jpg"
        with self.assertRaisesRegex(ValueError, "too small"):
            render(self.data, self.root, self.root / "out", self.font, None, None)

    def test_rejects_cover_text_overflow(self) -> None:
        self.data["cover_line_two"] = "긴 헤드라인" * 15
        with self.assertRaisesRegex(ValueError, "too long"):
            render(self.data, self.root, self.root / "out", self.font, None, None)

    def test_rejects_photo_outside_workdir(self) -> None:
        self.data["cover_photo"] = "../outside.jpg"
        with self.assertRaisesRegex(ValueError, "escapes job directory"):
            render(self.data, self.root, self.root / "out", self.font, None, None)

    @staticmethod
    def crop(x: float) -> dict:
        return {
            "x": x, "y": 0.0, "width": 2 / 3, "height": 1.0,
            "scale": 0.9, "focus_x": x + 1 / 3, "focus_y": 0.5,
            "review_required": False, "flags": [],
        }

    def paint_cover_markers(self) -> None:
        image = Image.new("RGB", (1800, 1500), "#234567")
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 599, 1499), fill="#e00000")
        draw.rectangle((600, 0, 1199, 1499), fill="#00d000")
        draw.rectangle((1200, 0, 1799, 1499), fill="#0000e0")
        image.save(self.root / "cover.jpg", quality=100)

    def test_render_uses_crop_rectangle_not_center_fit(self) -> None:
        self.paint_cover_markers()
        self.data["cover_crop"] = self.crop(0.0)
        out = self.root / "crop-out"
        report = render(self.data, self.root, out, self.font, None, None)
        with Image.open(out / report["slides"][0]["file"]) as page:
            self.assertEqual(page.size, SIZE)
            self.assertLess(page.getpixel((8, 8))[1], 60)
        self.assertEqual(report["photos"]["cover"]["crop"]["x"], 0.0)

    def test_manual_cover_and_body_focus_override_detection(self) -> None:
        cover_faces = [{"x": 0.72, "y": 0.35, "width": 0.10, "height": 0.12, "confidence": 0.94}]
        body_faces = [{"x": 0.20, "y": 0.35, "width": 0.10, "height": 0.12, "confidence": 0.92}]
        self.data.update({
            "cover_crop": self.crop(0.0), "cover_faces": cover_faces,
            "body_crop": self.crop(1 / 3), "body_faces": body_faces,
            "cover_focus_x": 0.80, "cover_focus_y": 0.50,
            "body_focus_x": 0.20, "body_focus_y": 0.50,
        })
        report = render(self.data, self.root, self.root / "manual", self.font, None, None)
        cover = report["photos"]["cover"]
        body = report["photos"]["body"]
        self.assertAlmostEqual(cover["crop"]["x"], 0.4, places=3)
        self.assertAlmostEqual(body["crop"]["x"], 0.0, places=3)
        self.assertIn("MANUAL_FOCUS", cover["review_flags"])
        self.assertIn("MANUAL_FOCUS", body["review_flags"])
        self.assertTrue(cover["quality_measurements"]["crop_scale"] < 2.0)

    def test_manual_focus_bounds_and_body_text_overlap(self) -> None:
        self.data.update({
            "body_crop": self.crop(1 / 6),
            "body_faces": [{"x": 0.20, "y": 0.12, "width": 0.14, "height": 0.10, "confidence": 0.94}],
            "body_focus_x": 0.5, "body_focus_y": 1.01,
        })
        with self.assertRaisesRegex(ValueError, "M9_MANUAL_FOCUS_OUT_OF_BOUNDS"):
            render(self.data, self.root, self.root / "invalid-focus", self.font, None, None)

        self.data["body_focus_y"] = 0.5
        baseline = render(self.data, self.root, self.root / "overlap", self.font, None, None)
        baseline_bounds = baseline["photos"]["body"]["text_bounds"]
        self.assertTrue(baseline["photos"]["body"]["text_overlap"])
        self.assertIn("FACE_OVERLAPS_BODY_TEXT", baseline["photos"]["body"]["review_flags"])
        self.assertEqual(baseline_bounds[0]["origin"], [80, 168])

        self.data["body_focus_x"] = 0.65
        moved_crop = render(self.data, self.root, self.root / "manual-moved", self.font, None, None)
        self.assertEqual(moved_crop["photos"]["body"]["text_bounds"], baseline_bounds)

    def test_face_text_overlap_is_diagnostic_and_does_not_set_review_required(self) -> None:
        state = {
            "crop": self.crop(0.0),
            "faces": [{"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2, "confidence": 0.9}],
            "text_bounds": [{"bounds": [100, 100, 250, 180]}],
            "review_required": False,
            "review_flags": [],
        }
        _record_body_text_overlap(state)
        self.assertTrue(state["text_overlap"])
        self.assertIn("FACE_OVERLAPS_BODY_TEXT", state["review_flags"])
        self.assertFalse(state["review_required"])

    def test_each_page_can_use_its_own_photo_and_manifest_records_provenance(self) -> None:
        Image.new("RGB", (1800, 1500), "#dd1122").save(self.root / "page-2.jpg")
        Image.new("RGB", (1800, 1500), "#1188dd").save(self.root / "page-3.jpg")
        import hashlib
        page_two_hash = hashlib.sha256((self.root / "page-2.jpg").read_bytes()).hexdigest()
        page_three_hash = hashlib.sha256((self.root / "page-3.jpg").read_bytes()).hexdigest()
        self.data.update({
            "brief_status": "DRAFT", "generation_intent": "EXPLORATION",
            "content_mode": "MATCH_CONTENT",
            "body_slides": [
                {"body_headline": "두 번째", "body_paragraphs": ["두 번째 본문"], "photo": {
                    "file": "page-2.jpg", "source_url": "https://news.example.org/2.jpg",
                    "article_url": "https://news.example.org/story", "credit": "PHOTO: TWO",
                    "source_sha256": page_two_hash, "image_reuse_status": "UNIQUE",
                }},
                {"body_headline": "세 번째", "body_paragraphs": ["세 번째 본문"], "photo": {
                    "file": "page-3.jpg", "source_url": "https://news.example.org/3.jpg",
                    "article_url": "https://news.example.org/story", "credit": "PHOTO: THREE",
                    "source_sha256": page_three_hash, "image_reuse_status": "UNIQUE",
                }},
            ],
        })
        report = render(self.data, self.root, self.root / "page-specific", self.font, None,
                        self.root / "cta.png")
        self.assertEqual([slide["kind"] for slide in report["slides"]], [
            "COVER_NEWS", "BODY_NEWS", "BODY_NEWS", "CTA",
        ])
        self.assertEqual([item["photo_url"] for item in report["sources"] if item["kind"] == "BODY_NEWS"], [
            "https://news.example.org/2.jpg", "https://news.example.org/3.jpg",
        ])
        self.assertEqual(report["slides"][1]["photo_sha256"], page_two_hash)
        self.assertEqual(report["slides"][2]["photo_sha256"], page_three_hash)

    def test_legacy_body_photo_fallback_is_recorded_as_reused_per_page(self) -> None:
        photo = {
            "file": "body.jpg", "source_url": self.data["body_photo_source"],
            "article_url": self.data["article_url"], "credit": self.data["body_photo_credit"],
            "image_reuse_status": "UNIQUE",
        }
        self.data.update({
            "body_slides": [
                {"body_headline": "두 번째", "body_paragraphs": ["두 번째 본문"], "photo": photo},
                {"body_headline": "세 번째", "body_paragraphs": ["세 번째 본문"], "photo": photo},
            ],
        })
        report = render(self.data, self.root, self.root / "legacy-reuse", self.font, None, None)
        self.assertEqual(report["slides"][1]["image_reuse_status"], "UNIQUE")
        self.assertEqual(report["slides"][2]["image_reuse_status"], "REUSED_EXACT")
        self.assertEqual(report["slides"][2]["duplicate_of_slide_number"], 2)
        self.assertEqual(report["photo_summary"]["unique_image_count"], 2)
        self.assertEqual(report["photo_summary"]["reused_page_count"], 1)

    def test_contact_sheet_crop_audit_and_manifest_order(self) -> None:
        self.paint_cover_markers()
        self.data.update({
            "cover_crop": self.crop(0.0), "cover_faces": [],
            "body_crop": self.crop(1 / 3), "body_faces": [],
            "brief_status": "DRAFT", "generation_intent": "EXPLORATION",
            "content_mode": "ANALYSIS_CONTEXT",
            "body_slides": [
                {"body_headline": "두 번째", "body_paragraphs": ["두 번째 본문"]},
                {"body_headline": "세 번째", "body_paragraphs": ["세 번째 본문"]},
                {"body_headline": "네 번째", "body_paragraphs": ["네 번째 근거와 맥락"]},
            ],
        })
        out = self.root / "audited"
        cta_bytes = (self.root / "cta.png").read_bytes()
        report = render(self.data, self.root, out, self.font, None, self.root / "cta.png")
        self.assertTrue(report["cta_integrity"]["byte_identical"])
        self.assertEqual(report["cta_integrity"]["input_sha256"], report["cta_integrity"]["output_sha256"])
        self.assertFalse(report["cta_integrity"]["historical_storage_match_verified"])
        self.assertEqual([page["kind"] for page in report["slides"]],
                         ["COVER_NEWS", "BODY_NEWS", "BODY_NEWS", "BODY_NEWS", "CTA"])
        self.assertEqual([page["file"] for page in report["slides"]],
                         report["review_artifacts"]["contact_sheet_pages"])
        self.assertEqual((out / report["slides"][-1]["file"]).read_bytes(), cta_bytes)
        for page in report["slides"]:
            with Image.open(out / page["file"]) as image:
                self.assertEqual(image.size, SIZE)
        for artifact in ("contact_sheet.png", "crop_audit.png"):
            self.assertTrue((out / artifact).is_file())
            with Image.open(out / artifact) as image:
                self.assertGreater(image.width, 0)
                self.assertGreater(image.height, 0)
        manifest = json.loads((out / "manifest.json").read_text())
        self.assertEqual(manifest["slides"], report["slides"])
        self.assertEqual(manifest["photos"]["cover"]["faces"], [])
        self.assertIn("quality_thresholds", manifest["photos"]["cover"])


if __name__ == "__main__":
    unittest.main()
