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
from PIL import ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_render_news_deck import SIZE, render, wrap_text, _record_body_text_overlap


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
            "source_publisher": "BBC Sport",
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

    def test_cover_gradient_starts_at_photo_midpoint_and_fades_to_solid_black(self) -> None:
        report = render(self.data, self.root, self.root / "gradient", self.font,
                        self.root / "logo.png", self.root / "cta.png",
                        body_font_path=self.body_font)
        settings = report["typography"]["settings"]
        self.assertAlmostEqual(settings["cover_gradient_start_y"] / SIZE[1], 0.42, delta=0.01)
        self.assertEqual(settings["cover_gradient_start_opacity"], 0.0)
        self.assertEqual(settings["cover_gradient_mid_opacity"], 0.45)
        self.assertEqual(settings["cover_gradient_end_opacity"], 1.0)
        self.assertEqual(report["slides"][0]["layout_template"], "COVER")

    def test_role_templates_remove_visible_source_urls_but_keep_original_copy(self) -> None:
        original_body = "리그 개막 6경기에서 승점 6점을 기록했다. 출처: BBC Sport | https://news.example.org/match"
        shared_photo = {
            "file": "body.jpg", "source_url": self.data["body_photo_source"],
            "article_url": self.data["article_url"], "credit": self.data["body_photo_credit"],
            "crop": self.crop(0.12),
            "faces": [{"x": 0.25, "y": 0.32, "width": 0.1, "height": 0.12, "confidence": 0.92}],
        }
        self.data.update({
            "body_slides": [
                {"role": "KEY_FACT", "body_headline": "개막 6경기, 승점 6점",
                 "body_paragraphs": [original_body], "body_highlight": "1986-87 이후 최저 출발",
                 "stat_emphasis": "6경기 / 6점", "photo": shared_photo},
                {"role": "CONTEXT", "body_headline": "앞섰지만 추가시간에 멈췄다",
                 "body_paragraphs": ["맨유가 먼저 득점했다.", "토트넘은 10명으로 경기를 이어갔다."],
                 "body_highlight": "1-1", "photo": shared_photo},
                {"role": "IMPLICATION", "body_headline": "무승은 4경기로 늘었다",
                 "body_paragraphs": ["기사에 따르면 최근 리그 네 경기에서 승리하지 못했다."],
                 "body_highlight": "", "closing_line": "숫자보다 먼저, 결과가 필요하다는 흐름이다.",
                 "photo": shared_photo},
            ],
        })
        report = render(self.data, self.root, self.root / "templates", self.font,
                        self.root / "logo.png", self.root / "cta.png",
                        body_font_path=self.body_font)
        self.assertEqual([slide["layout_template"] for slide in report["slides"]], [
            "COVER", "FACT", "CONTEXT", "ANALYSIS", "CTA",
        ])
        fact = report["slides"][1]["content"]
        self.assertEqual(fact["source_body"], original_body)
        self.assertEqual(fact["visible_body"], "리그 개막 6경기에서 승점 6점을 기록했다.")
        self.assertNotIn("https://", fact["visible_body"])
        self.assertEqual(report["slides"][1]["role"], "KEY_FACT")
        self.assertEqual(report["slides"][1]["stat_emphasis"], "6경기 / 6점")
        self.assertGreaterEqual(
            next(row["contrast_ratio"] for row in report["slides"][1]["text_bounds"]
                 if row["kind"] == "stat"),
            3.0,
        )
        self.assertEqual(report["slides"][2]["role"], "CONTEXT")
        self.assertEqual(report["slides"][3]["role"], "IMPLICATION")
        self.assertEqual(len({report["slides"][index]["crop_coordinates"]["x"] for index in (1, 2, 3)}), 3)
        self.assertEqual(report["article_url"], self.data["article_url"])
        self.assertEqual(report["sources"][0]["credit"], self.data["cover_photo_credit"])
        self.assertEqual((self.root / "cta.png").read_bytes(),
                         (self.root / "templates/slide_05_cta.png").read_bytes())

    def test_source_and_photo_credit_are_only_drawn_on_last_content_page(self) -> None:
        self.data["cover_line_two"] = "BBC Sport가 짚은 캐릭의 압박"
        self.data["body_slides"] = [
            {"role": "CONTEXT", "body_headline": "경기 상황",
             "body_paragraphs": ["토트넘은 동점골을 넣었다고 BBC Sport는 전했다."],
             "photo": {"file": "body.jpg", "source_url": "https://news.example.org/a.jpg",
                       "article_url": self.data["article_url"], "credit": "BBC / Getty Images"}},
            {"role": "KEY_FACT", "body_headline": "기록은 분명했다",
             "body_paragraphs": [
                 "BBC Sport는 이 기록이 리그 시즌 첫 6경기 기준 1986-87 이후 가장 적은 승점이라고 보도했다.",
                 "BBC Sport 기사에서 제이미 레드냅은 활동량을 평가했다.",
             ],
             "photo": {"file": "body.jpg", "source_url": "https://news.example.org/a.jpg",
                       "article_url": self.data["article_url"], "credit": "BBC / Getty Images"}},
        ]
        report = render(self.data, self.root, self.root / "last-source", self.font,
                        self.root / "logo.png", self.root / "cta.png",
                        body_font_path=self.body_font)
        cover, first, last = report["slides"][:3]
        self.assertNotIn("source", [row["kind"] for row in cover["text_bounds"]])
        self.assertNotIn("source", [row["kind"] for row in first["text_bounds"]])
        self.assertNotIn("photo_credit", [row["kind"] for row in first["text_bounds"]])
        self.assertIn("source", [row["kind"] for row in last["text_bounds"]])
        self.assertIn("photo_credit", [row["kind"] for row in last["text_bounds"]])
        self.assertEqual(last["content"]["source_label"], "SOURCE: BBC Sport")
        self.assertEqual(last["content"]["photo_credit"], "BBC / Getty Images")
        self.assertNotIn("BBC Sport", cover["content"]["visible_highlight"])
        self.assertNotIn("BBC Sport", first["content"]["visible_body"])
        self.assertNotIn("BBC Sport", last["content"]["visible_body"])
        self.assertIn("이 기록은 리그 시즌 첫 6경기 기준 1986-87 이후 가장 적은 승점이다.",
                      last["content"]["visible_body"])

    def test_visuals_hide_internal_roles_and_have_no_repeated_red_rules(self) -> None:
        self.data["body_slides"] = [
            {"role": "CONTEXT", "body_headline": "경기 상황",
             "body_paragraphs": ["맨유가 먼저 득점했다."]},
            {"role": "KEY_FACT", "body_headline": "기록은 분명했다",
             "body_paragraphs": ["개막 여섯 경기에서 승점 여섯 점을 기록했다."]},
            {"role": "IMPLICATION", "body_headline": "앞으로 지켜볼 점",
             "body_paragraphs": ["다음 경기의 흐름을 확인할 필요가 있다."]},
        ]
        report = render(self.data, self.root, self.root / "no-role-labels", self.font,
                        None, None, body_font_path=self.body_font)
        for slide in report["slides"][1:-1]:
            kinds = [row["kind"] for row in slide["text_bounds"]]
            self.assertNotIn("template_label", kinds)
            self.assertNotIn("analysis_label", kinds)
            self.assertLessEqual(kinds.count("accent_rule"), 1)
            self.assertNotIn("KEY FACT", slide["content"]["visible_headline"])
            self.assertNotIn("MATCH CONTEXT", slide["content"]["visible_headline"])
            self.assertNotIn("IMPLICATION · ANALYSIS", slide["content"]["visible_headline"])

    def test_wrap_text_never_splits_an_unspaced_token(self) -> None:
        draw = ImageDraw.Draw(Image.new("RGB", (100, 100), "white"))
        token = "MANCHESTERUNITED" * 8
        lines = wrap_text(draw, token, ImageFont.truetype(self.body_font, 28), 120)
        self.assertEqual(lines, [token])

    def test_each_paragraph_is_limited_to_two_lines_or_flagged_for_review(self) -> None:
        long_paragraph = "맨유는 경기 초반부터 상대 진영에서 압박을 시도했고 " * 16
        self.data["body_slides"] = [{
            "role": "CONTEXT", "body_headline": "경기 흐름을 살펴보자",
            "body_paragraphs": [long_paragraph],
        }]
        report = render(self.data, self.root, self.root / "paragraph-review", self.font,
                        None, None, body_font_path=self.body_font)
        slide = report["slides"][1]
        self.assertIn("PARAGRAPH_LENGTH_REVIEW", slide["content_review_flags"])
        self.assertEqual(slide["content"]["source_body"], long_paragraph)

    def test_body_text_uses_wide_pixel_measured_lines_and_collapses_soft_breaks(self) -> None:
        self.data["body_slides"] = [{
            "role": "CONTEXT", "body_headline": "앞섰지만, 추가시간에 멈췄다",
            "body_paragraphs": ["맨유가 먼저 득점했다. 토트넘은 10명으로 경기를 이어갔다."],
        }]
        report = render(self.data, self.root, self.root / "wide-reflow", self.font,
                        None, None, body_font_path=self.body_font)
        paragraphs = [row for row in report["slides"][1]["text_bounds"] if row["kind"] == "paragraph"]
        self.assertTrue(all(row["bounds"][2] - row["bounds"][0] <= 872 for row in paragraphs))
        self.assertLessEqual(len(paragraphs), 2)

    def test_cover_manifest_reports_only_cleaned_text_drawn_on_cover(self) -> None:
        source_headline = "맨유 복귀 | 출처: BBC Sport https://bbc.example/story"
        self.data.update({
            "cover_line_one": source_headline,
            "cover_line_two": "핵심 장면 https://bbc.example/photo.jpg",
            "cover_source_headline": source_headline,
        })
        report = render(self.data, self.root, self.root / "cover-markup", self.font,
                        None, None, body_font_path=self.body_font)
        content = report["slides"][0]["content"]
        self.assertEqual(content["source_headline"], source_headline)
        self.assertEqual(content["visible_headline"], "맨유 복귀")
        self.assertEqual(content["visible_highlight"], "핵심 장면")
        self.assertNotIn("https://", content["visible_headline"] + content["visible_highlight"])

    def test_stored_faces_without_crop_metadata_get_an_effective_face_safe_crop(self) -> None:
        faces = [
            {"x": 0.25, "y": 0.20, "width": 0.08, "height": 0.12, "confidence": 0.93},
            {"x": 0.53, "y": 0.21, "width": 0.08, "height": 0.12, "confidence": 0.91},
        ]
        self.data.update({"body_faces": faces})
        self.data["body_slides"] = [{
            "role": "CONTEXT", "body_headline": "경기 장면 정리",
            "body_paragraphs": ["두 선수의 움직임을 확인했다."],
        }]
        report = render(self.data, self.root, self.root / "faces-without-crop", self.font,
                        None, None, body_font_path=self.body_font)
        page = report["slides"][1]
        self.assertIsNotNone(page["crop_coordinates"])
        self.assertEqual(len(page["face_boxes_card"]), 2)
        for box in page["face_boxes_card"]:
            left, top, right, bottom = box["bounds"]
            self.assertGreaterEqual(left, 0)
            self.assertGreaterEqual(top, 0)
            self.assertLessEqual(right, SIZE[0])
            self.assertLessEqual(bottom, SIZE[1])

    def test_closing_line_keeps_normal_size_and_marks_overflow_for_editorial_review(self) -> None:
        compact_closing = "중원 압박과 전환 속도를 살펴야 다음 경기의 흐름을 가늠할 수 있다."
        self.data["body_slides"] = [{
            "role": "IMPLICATION", "body_headline": "다음 경기를 볼 기준",
            "body_paragraphs": ["확정된 결과와 경기 해석은 구분해야 한다."],
            "closing_line": compact_closing,
        }]
        compact_report = render(self.data, self.root, self.root / "analysis-compact", self.font,
                                None, None, body_font_path=self.body_font)
        compact = compact_report["slides"][1]
        self.assertEqual(compact["content"]["source_closing_line"], compact_closing)
        self.assertEqual(compact["content"]["visible_closing_line"], compact_closing.strip())
        self.assertNotIn("ANALYSIS_NOTE_REVIEW", compact["content_review_flags"])
        self.assertTrue(all(row["bounds"][3] <= 1110 for row in compact["text_bounds"]
                            if row["kind"] == "analysis_note"))

        impossible_closing = "중원 전환 압박 흐름을 다음 경기까지 확인해야 한다 " * 24
        self.data["body_slides"][0]["closing_line"] = impossible_closing
        omitted_report = render(self.data, self.root, self.root / "analysis-review", self.font,
                                None, None, body_font_path=self.body_font)
        omitted = omitted_report["slides"][1]
        self.assertEqual(omitted["content"]["source_closing_line"], impossible_closing)
        self.assertEqual(omitted["content"]["visible_closing_line"], "")
        self.assertIn("ANALYSIS_NOTE_REVIEW", omitted["content_review_flags"])

    def test_dense_body_is_preserved_and_marked_for_editorial_review(self) -> None:
        source_body = "첫 번째 문장이다. 두 번째 문장이다. 세 번째 문장이다."
        self.data["body_slides"] = [{
            "role": "KEY_FACT", "body_headline": "정보 확인",
            "body_paragraphs": [source_body], "body_highlight": "",
        }]
        report = render(self.data, self.root, self.root / "dense", self.font, None, None,
                        body_font_path=self.body_font)
        slide = report["slides"][1]
        self.assertEqual(slide["content"]["source_body"], source_body)
        self.assertIn("BODY_SENTENCE_LIMIT_REVIEW", slide["content_review_flags"])

    def test_long_fact_body_and_highlight_fit_without_truncation(self) -> None:
        body = [
            "BBC Sport 기사에서 제이미 레드냅은",
            "토트넘이 5km 더 뛰었다고 평가했다.",
            "대니 머피는 중원 통제와 공간 문제를 지적했다.",
            "이는 패널의 분석이며, 확정 진단은 아니다.",
        ]
        self.data["body_slides"] = [{
            "role": "KEY_FACT", "body_headline": "10명인 토트넘이 5km 더 뛰었다는 분석",
            "body_paragraphs": body, "body_highlight": "기사 속 패널 평가",
            "stat_emphasis": "토트넘 +5km",
        }]
        report = render(self.data, self.root, self.root / "long-fact", self.font,
                        None, None, body_font_path=self.body_font)
        slide = report["slides"][1]
        self.assertEqual(slide["content"]["source_body"], "\n".join(body))
        self.assertIn("BODY_SENTENCE_LIMIT_REVIEW", slide["content_review_flags"])
        self.assertTrue(all(box["bounds"][3] <= 1110 for box in slide["text_bounds"]
                            if box["kind"] not in {"source", "photo_credit"}))

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
            "body_faces": [{"x": 0.20, "y": 0.23, "width": 0.14, "height": 0.10, "confidence": 0.94}],
            "body_focus_x": 0.5, "body_focus_y": 1.01,
        })
        with self.assertRaisesRegex(ValueError, "M9_MANUAL_FOCUS_OUT_OF_BOUNDS"):
            render(self.data, self.root, self.root / "invalid-focus", self.font, None, None)

        self.data["body_focus_y"] = 0.5
        baseline = render(self.data, self.root, self.root / "overlap", self.font, None, None)
        baseline_bounds = baseline["photos"]["body"]["text_bounds"]
        self.assertTrue(baseline["photos"]["body"]["text_overlap"])
        self.assertIn("FACE_OVERLAPS_BODY_TEXT", baseline["photos"]["body"]["review_flags"])
        self.assertEqual(baseline_bounds[0]["origin"], [80, 300])

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
