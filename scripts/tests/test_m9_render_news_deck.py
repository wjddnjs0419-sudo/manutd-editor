"""Unit tests for the M9 Pillow private-preview renderer. No news photos bundled."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_render_news_deck import SIZE, render


def find_font() -> Path | None:
    for p in [
        os.environ.get("M9_TEST_FONT"),
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
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
                        self.root / "logo.png", self.root / "cta.png")
        self.assertEqual(len(report["slides"]), 3)
        self.assertEqual(report["state"], "PRIVATE_PREVIEW_REQUIRES_REVIEW")
        for entry in report["slides"]:
            with Image.open(out / entry["file"]) as image:
                self.assertEqual(image.size, SIZE)
        self.assertEqual((self.root / "cta.png").read_bytes(),
                         (out / "slide_03_cta.png").read_bytes())
        self.assertFalse(report["approval"]["auto_publishing_allowed"])
        self.assertFalse(report["approval"]["image_reuse_rights"])
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


if __name__ == "__main__":
    unittest.main()
