"""Pixel-level tests for M9 subject crop planning; face boxes are injected."""
from __future__ import annotations

import io
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import m9_photo_analysis as photo_analysis
from m9_photo_analysis import (
    NormalizedFace,
    analyze_photo,
    apply_crop,
    decode_photo,
    ensure_face_model,
)


class FakeDetector:
    def __init__(self, faces: list[NormalizedFace]):
        self.faces = faces

    def detect(self, image: Image.Image) -> list[NormalizedFace]:
        return list(self.faces)


def checker_image(size: tuple[int, int] = (1600, 1200)) -> Image.Image:
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    for x in range(0, size[0], 16):
        color = "#404040" if (x // 16) % 2 else "#e0e0e0"
        draw.rectangle((x, 0, min(size[0], x + 7), size[1]), fill=color)
    return image


def mark_face(image: Image.Image, face: NormalizedFace) -> None:
    draw = ImageDraw.Draw(image)
    x0 = round(face.x * image.width)
    y0 = round(face.y * image.height)
    x1 = round((face.x + face.width) * image.width)
    y1 = round((face.y + face.height) * image.height)
    draw.rectangle((x0, y0, x1, y1), outline="#ff0000", width=4)


class M9PhotoAnalysisTests(unittest.TestCase):
    def test_center_left_right_faces_stay_inside_crop(self) -> None:
        for x in (0.04, 0.44, 0.90):
            with self.subTest(x=x):
                face = NormalizedFace(x, 0.30, 0.06, 0.16, 0.91)
                image = checker_image()
                mark_face(image, face)
                result = analyze_photo(image, "cover", FakeDetector([face]))
                cropped = apply_crop(image, result.crop, (1080, 1350))
                self.assertLessEqual(result.crop.x, face.x)
                self.assertGreaterEqual(result.crop.x + result.crop.width, face.x + face.width)
                self.assertLessEqual(result.crop.y, face.y)
                self.assertGreaterEqual(result.crop.y + result.crop.height, face.y + face.height)
                self.assertEqual(cropped.size, (1080, 1350))
                self.assertIn((255, 0, 0), set(cropped.getdata()))

    def test_face_box_and_focus_are_normalized(self) -> None:
        face = NormalizedFace(0.25, 0.2, 0.18, 0.3, 0.92)
        result = analyze_photo(checker_image(), "cover", FakeDetector([face]))
        self.assertEqual(result.faces, (face,))
        self.assertEqual(result.face_count, 1)
        self.assertTrue(0 <= result.crop.x <= 1)
        self.assertTrue(0 <= result.crop.y <= 1)
        self.assertLessEqual(result.crop.x + result.crop.width, 1)
        self.assertLessEqual(result.crop.y + result.crop.height, 1)
        self.assertTrue(0 <= result.crop.focus_x <= 1)
        self.assertTrue(0 <= result.crop.focus_y <= 1)

    def test_detection_confidence_threshold_is_inclusive(self) -> None:
        accepted = NormalizedFace(0.4, 0.3, 0.1, 0.15, 0.5)
        rejected = NormalizedFace(0.6, 0.3, 0.1, 0.15, 0.499)
        result = analyze_photo(checker_image(), "cover", FakeDetector([rejected, accepted]))
        self.assertEqual(len(result.faces), 1)
        self.assertAlmostEqual(result.faces[0].x, accepted.x)
        self.assertAlmostEqual(result.faces[0].y, accepted.y)
        self.assertAlmostEqual(result.faces[0].width, accepted.width)
        self.assertAlmostEqual(result.faces[0].height, accepted.height)
        self.assertAlmostEqual(result.faces[0].confidence, accepted.confidence)
        self.assertEqual(result.face_count, 1)

    def test_face_size_threshold_is_inclusive(self) -> None:
        image = checker_image()
        policy = {
            "quality": {
                "basic_min_face_sharpness": 0,
                "basic_min_face_width_px": 20,
                "basic_min_face_height_px": 24,
            }
        }
        at_cutoff = NormalizedFace(0.40, 0.30, 20 / 1600, 24 / 1200, 0.9)
        below_cutoff = NormalizedFace(0.40, 0.30, 19.9 / 1600, 24 / 1200, 0.9)
        accepted = analyze_photo(image, "cover", FakeDetector([at_cutoff]), policy=policy)
        rejected = analyze_photo(image, "cover", FakeDetector([below_cutoff]), policy=policy)
        self.assertNotIn("FACE_TOO_SMALL_FOR_SCALE", accepted.flags)
        self.assertIn("FACE_TOO_SMALL_FOR_SCALE", rejected.flags)

    def test_no_face_without_focus_is_review_required(self) -> None:
        result = analyze_photo(checker_image(), "body", FakeDetector([]))
        self.assertTrue(result.review_required)
        self.assertIn("NO_FACE_DETECTED", result.flags)
        self.assertEqual(result.crop.focus_x, 0.5)
        self.assertEqual(result.crop.focus_y, 0.5)

    def test_manual_focus_overrides_detected_face(self) -> None:
        face = NormalizedFace(0.04, 0.28, 0.08, 0.18, 0.95)
        result = analyze_photo(
            checker_image(), "cover", FakeDetector([face]), manual_focus=(1.0, 0.5)
        )
        self.assertIn("MANUAL_FOCUS", result.flags)
        self.assertGreater(result.crop.x, 0.35)
        self.assertTrue(result.review_required)
        self.assertIn("FACE_OUTSIDE_CROP", result.flags)

    def test_similar_faces_require_manual_review(self) -> None:
        faces = [
            NormalizedFace(0.36, 0.28, 0.10, 0.18, 0.88),
            NormalizedFace(0.52, 0.29, 0.095, 0.18, 0.91),
        ]
        result = analyze_photo(checker_image(), "cover", FakeDetector(faces))
        self.assertTrue(result.review_required)
        self.assertIn("AMBIGUOUS_MULTIPLE_FACES", result.flags)
        self.assertEqual(result.face_count, 2)
        self.assertTrue(all(0 <= face.x <= 1 for face in result.faces))

    def test_single_dominant_face_may_be_protected(self) -> None:
        dominant = NormalizedFace(0.70, 0.26, 0.16, 0.30, 0.86)
        small = NormalizedFace(0.20, 0.30, 0.05, 0.12, 0.93)
        result = analyze_photo(checker_image(), "cover", FakeDetector([dominant, small]))
        self.assertFalse(result.review_required)
        self.assertIn("DOMINANT_FACE_BY_VISIBLE_AREA", result.flags)
        self.assertLessEqual(result.crop.x, dominant.x)
        self.assertGreaterEqual(result.crop.x + result.crop.width, dominant.x + dominant.width)

    def test_scale_bands_1_5_1_8_2_0_and_above_2(self) -> None:
        expected = [
            ((720, 900), 1.5, "UPSCALE_BASIC"),
            ((600, 750), 1.8, "UPSCALE_SHARP"),
            ((540, 675), 2.0, "UPSCALE_STRICT"),
            ((512, 640), 1080 / 512, "UPSCALE_ABOVE_LIMIT"),
        ]
        face = NormalizedFace(0.4, 0.25, 0.2, 0.25, 0.9)
        for size, scale, flag in expected:
            with self.subTest(size=size):
                result = analyze_photo(checker_image(size), "cover", FakeDetector([face]))
                self.assertAlmostEqual(result.crop.scale, scale, places=3)
                self.assertIn(flag, result.flags)
                self.assertEqual(flag == "UPSCALE_ABOVE_LIMIT", result.crop.scale > 2.0)
                threshold = result.quality["required_face_sharpness"]
                self.assertGreater(threshold, 0)
                if scale <= 1.5:
                    self.assertEqual(threshold, 20.0)
                elif scale <= 1.8:
                    self.assertEqual(threshold, 55.0)
                else:
                    self.assertEqual(threshold, 90.0)

    def test_edge_face_is_preserved_or_flagged(self) -> None:
        face = NormalizedFace(0.0, 0.0, 0.10, 0.18, 0.9)
        result = analyze_photo(checker_image(), "cover", FakeDetector([face]))
        self.assertLessEqual(result.crop.x, face.x)
        self.assertLessEqual(result.crop.y, face.y)
        self.assertTrue(result.review_required)
        self.assertIn("FACE_HEADROOM_UNAVAILABLE", result.flags)

    def test_blurry_face_is_review_required_even_when_scale_is_allowed(self) -> None:
        face = NormalizedFace(0.40, 0.28, 0.20, 0.24, 0.95)
        sharp = checker_image()
        blurred = sharp.filter(ImageFilter.GaussianBlur(radius=4))
        sharp_result = analyze_photo(sharp, "cover", FakeDetector([face]))
        blurred_result = analyze_photo(blurred, "cover", FakeDetector([face]))
        self.assertLessEqual(sharp_result.crop.scale, 1.5)
        self.assertGreater(
            sharp_result.quality["face_sharpness"],
            blurred_result.quality["face_sharpness"],
        )
        self.assertTrue(blurred_result.review_required)
        self.assertIn("FACE_SHARPNESS_BELOW_THRESHOLD", blurred_result.flags)

    def test_face_sharpness_threshold_is_inclusive(self) -> None:
        face = NormalizedFace(0.40, 0.28, 0.20, 0.24, 0.95)
        image = checker_image()
        measured = analyze_photo(image, "cover", FakeDetector([face]))
        cutoff = measured.quality["face_sharpness"]
        at_cutoff = analyze_photo(
            image,
            "cover",
            FakeDetector([face]),
            policy={"quality": {"basic_min_face_sharpness": cutoff}},
        )
        just_above = analyze_photo(
            image,
            "cover",
            FakeDetector([face]),
            policy={"quality": {"basic_min_face_sharpness": cutoff + 1e-6}},
        )
        self.assertNotIn("FACE_SHARPNESS_BELOW_THRESHOLD", at_cutoff.flags)
        self.assertIn("FACE_SHARPNESS_BELOW_THRESHOLD", just_above.flags)

    def test_corrupt_and_exif_rotated_sources(self) -> None:
        with self.assertRaisesRegex(ValueError, "M9_IMAGE_DECODE_FAILED"):
            decode_photo(b"not an image")
        source = Image.new("RGB", (80, 160), "navy")
        exif = Image.Exif()
        exif[274] = 6
        content = io.BytesIO()
        source.save(content, format="JPEG", exif=exif)
        oriented = decode_photo(content.getvalue())
        self.assertEqual(oriented.size, (160, 80))

    def test_model_download_checks_host_size_and_sha256(self) -> None:
        payload = b"test model bytes"

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def geturl(self):
                return "https://storage.googleapis.com/test/model.tflite"

            def read(self, limit):
                self.limit = limit
                return payload

        fake_response = FakeResponse()
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "model.tflite"
            with (
                patch.object(photo_analysis, "MODEL_SHA256", hashlib.sha256(payload).hexdigest()),
                patch.object(photo_analysis.urllib.request, "urlopen", return_value=fake_response),
            ):
                self.assertEqual(ensure_face_model(model_path), model_path)
            self.assertEqual(model_path.read_bytes(), payload)
            self.assertEqual(fake_response.limit, photo_analysis.MAX_MODEL_BYTES + 1)

    def test_existing_model_with_wrong_hash_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory) / "model.tflite"
            model_path.write_bytes(b"not the pinned model")
            with self.assertRaisesRegex(ValueError, "M9_FACE_MODEL_SHA256_MISMATCH"):
                ensure_face_model(model_path)


if __name__ == "__main__":
    unittest.main()
