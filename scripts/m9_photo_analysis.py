"""Free CPU face localization and auditable 4:5 crop planning for M9 photos.

Face boxes are composition hints only. This module never attempts to identify a
person or infer identity from article metadata.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "supabase/functions/_shared/m9/crop_policy.json"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)
MODEL_SHA256 = "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f"
MODEL_LICENSE = "Apache-2.0"
MAX_MODEL_BYTES = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_PIXELS = 60_000_000


@dataclass(frozen=True)
class NormalizedFace:
    """A top-left face rectangle and confidence, all in normalized coordinates."""

    x: float
    y: float
    width: float
    height: float
    confidence: float


@dataclass(frozen=True)
class CropPlan:
    """Normalized 4:5 crop rectangle plus effective focus and review state."""

    x: float
    y: float
    width: float
    height: float
    scale: float
    focus_x: float
    focus_y: float
    review_required: bool
    flags: tuple[str, ...]


@dataclass(frozen=True)
class PhotoEvaluation:
    """JSON-ready crop analysis; face_count is a detection count, not people ID."""

    faces: tuple[NormalizedFace, ...]
    face_count: int
    crop: CropPlan
    quality: dict[str, float]
    review_required: bool
    flags: tuple[str, ...]
    analysis_ms: float


class FaceDetector(Protocol):
    def detect(self, image: Image.Image) -> list[NormalizedFace]: ...


def load_crop_policy() -> dict:
    with POLICY_PATH.open("r", encoding="utf-8") as policy_file:
        return json.load(policy_file)


def _deep_merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _default_model_path() -> Path:
    configured = os.environ.get("M9_FACE_MODEL_PATH")
    if configured:
        return Path(configured).expanduser()
    runner_temp = os.environ.get("RUNNER_TEMP")
    base = Path(runner_temp) if runner_temp else Path.home() / ".cache"
    return base / "m9-photo-crop" / "blaze_face_short_range.tflite"


def ensure_face_model(path: Path | None = None, timeout: float = 30.0) -> Path:
    """Return the pinned model, downloading it once and checking its fixed hash."""
    model_path = Path(path) if path is not None else _default_model_path()
    if model_path.exists():
        digest = _sha256_file(model_path)
        if digest != MODEL_SHA256:
            raise ValueError("M9_FACE_MODEL_SHA256_MISMATCH")
        return model_path

    model_path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        MODEL_URL,
        headers={"User-Agent": "ManUtdEditor-M9-CPU/1.0"},
    )
    temp_name: str | None = None
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            final_url = response.geturl()
            if not final_url.startswith("https://storage.googleapis.com/"):
                raise ValueError("M9_FACE_MODEL_HOST_REJECTED")
            payload = response.read(MAX_MODEL_BYTES + 1)
        if len(payload) > MAX_MODEL_BYTES:
            raise ValueError("M9_FACE_MODEL_TOO_LARGE")
        if hashlib.sha256(payload).hexdigest() != MODEL_SHA256:
            raise ValueError("M9_FACE_MODEL_SHA256_MISMATCH")
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix="m9-model-", suffix=".tmp", dir=model_path.parent,
            delete=False,
        ) as temp_file:
            temp_file.write(payload)
            temp_name = temp_file.name
        os.replace(temp_name, model_path)
        temp_name = None
        return model_path
    except ValueError:
        raise
    except Exception:
        raise ValueError("M9_FACE_MODEL_DOWNLOAD_FAILED") from None
    finally:
        if temp_name is not None:
            Path(temp_name).unlink(missing_ok=True)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decode_photo(data: bytes) -> Image.Image:
    """Decode bounded image bytes and apply EXIF orientation before analysis."""
    if not isinstance(data, bytes) or len(data) < 24 or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("M9_IMAGE_DECODE_FAILED")
    try:
        with Image.open(io.BytesIO(data)) as opened:
            width, height = opened.size
            if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("M9_IMAGE_DECODE_FAILED")
            opened.load()
            corrected = ImageOps.exif_transpose(opened)
            corrected.load()
            return corrected.convert("RGB")
    except Exception as error:
        if isinstance(error, ValueError) and str(error) == "M9_IMAGE_DECODE_FAILED":
            raise
        raise ValueError("M9_IMAGE_DECODE_FAILED") from None


class MediaPipeFaceDetector:
    """MediaPipe Tasks IMAGE-mode adapter using CPU and normalized face boxes."""

    def __init__(self, model_path: Path, policy: dict | None = None):
        verified_model = ensure_face_model(Path(model_path))
        import mediapipe as mp
        import numpy as np
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision

        settings = _deep_merge(load_crop_policy(), policy or {})
        options = vision.FaceDetectorOptions(
            base_options=python.BaseOptions(
                model_asset_path=str(verified_model),
                delegate=python.BaseOptions.Delegate.CPU,
            ),
            running_mode=vision.RunningMode.IMAGE,
            min_detection_confidence=float(settings["face_detection_min_confidence"]),
        )
        self._mp = mp
        self._np = np
        self._detector = vision.FaceDetector.create_from_options(options)

    def detect(self, image: Image.Image) -> list[NormalizedFace]:
        rgb = self._np.asarray(image.convert("RGB"))
        mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._detector.detect(mp_image)
        width, height = image.size
        faces: list[NormalizedFace] = []
        for detection in result.detections or []:
            box = detection.bounding_box
            categories = getattr(detection, "categories", None) or []
            confidence = float(categories[0].score) if categories else 0.0
            faces.append(NormalizedFace(
                x=box.origin_x / width,
                y=box.origin_y / height,
                width=box.width / width,
                height=box.height / height,
                confidence=confidence,
            ))
        return faces

    def close(self) -> None:
        self._detector.close()


def _clamped_face(face: NormalizedFace) -> NormalizedFace | None:
    values = (face.x, face.y, face.width, face.height, face.confidence)
    if not all(math.isfinite(float(value)) for value in values):
        return None
    left = min(1.0, max(0.0, float(face.x)))
    top = min(1.0, max(0.0, float(face.y)))
    right = min(1.0, max(left, float(face.x + face.width)))
    bottom = min(1.0, max(top, float(face.y + face.height)))
    confidence = min(1.0, max(0.0, float(face.confidence)))
    if right - left <= 0 or bottom - top <= 0:
        return None
    return NormalizedFace(left, top, right - left, bottom - top, confidence)


def _source_crop_dimensions(
    image_size: tuple[int, int], target_size: tuple[int, int]
) -> tuple[int, int]:
    image_width, image_height = image_size
    target_width, target_height = target_size
    divisor = math.gcd(target_width, target_height)
    unit_width, unit_height = target_width // divisor, target_height // divisor
    units = min(image_width // unit_width, image_height // unit_height)
    if units < 1:
        return 0, 0
    return units * unit_width, units * unit_height


def _clamp_origin(center: float, extent: float, available: int) -> int:
    start = int(round(center - extent / 2))
    return min(max(0, start), max(0, available - extent))


def _sharpness(image: Image.Image, rect: tuple[int, int, int, int]) -> float:
    import cv2
    import numpy as np

    roi = image.crop(rect).convert("RGB")
    if roi.width < 3 or roi.height < 3:
        return 0.0
    gray = cv2.cvtColor(np.asarray(roi), cv2.COLOR_RGB2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _visible_area(
    face: NormalizedFace,
    crop_box: tuple[int, int, int, int],
    size: tuple[int, int],
) -> float:
    width, height = size
    left, top, right, bottom = crop_box
    fx0, fy0 = face.x * width, face.y * height
    fx1, fy1 = (face.x + face.width) * width, (face.y + face.height) * height
    intersection = max(0.0, min(fx1, right) - max(fx0, left)) * max(
        0.0, min(fy1, bottom) - max(fy0, top)
    )
    total = max(1e-9, (fx1 - fx0) * (fy1 - fy0))
    return intersection / total


def analyze_photo(
    image: Image.Image,
    role: Literal["cover", "body"],
    detector: FaceDetector,
    manual_focus: tuple[float, float] | None = None,
    policy: dict | None = None,
) -> PhotoEvaluation:
    """Detect face locations and compute a bounded, exact-aspect crop plus gates."""
    started = time.perf_counter()
    if role not in ("cover", "body"):
        raise ValueError("M9_PHOTO_ROLE_INVALID")
    settings = _deep_merge(load_crop_policy(), policy or {})
    oriented = ImageOps.exif_transpose(image).convert("RGB")
    width, height = oriented.size
    if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
        raise ValueError("M9_IMAGE_DECODE_FAILED")
    target_size = (int(settings["target_width"]), int(settings["target_height"]))
    crop_width_px, crop_height_px = _source_crop_dimensions(
        (width, height), target_size
    )
    flags: list[str] = []
    quality_settings = settings.get("quality", {})
    if crop_width_px <= 0 or crop_height_px <= 0:
        raise ValueError("M9_SOURCE_TOO_SMALL_FOR_TARGET")

    normalized: list[NormalizedFace] = []
    min_confidence = float(settings["face_detection_min_confidence"])
    for item in detector.detect(oriented):
        face = _clamped_face(item)
        if face is not None and face.confidence >= min_confidence:
            normalized.append(face)
    normalized.sort(key=lambda face: face.width * face.height, reverse=True)

    crop_width = crop_width_px / width
    crop_height = crop_height_px / height
    manual = manual_focus is not None
    faces_to_protect: list[NormalizedFace] = []
    if manual:
        if len(manual_focus) != 2 or not all(math.isfinite(float(value)) for value in manual_focus):
            raise ValueError("M9_MANUAL_FOCUS_INVALID")
        focus_x, focus_y = (float(manual_focus[0]), float(manual_focus[1]))
        if not (0 <= focus_x <= 1 and 0 <= focus_y <= 1):
            raise ValueError("M9_MANUAL_FOCUS_OUT_OF_BOUNDS")
        flags.append("MANUAL_FOCUS")
        desired_x = focus_x * width
        desired_y = focus_y * height
        subject_top = desired_y
        subject_bottom = desired_y
        faces_to_protect = normalized
    elif normalized:
        area_ratio = float(settings["dominant_face_area_ratio"])
        dominant = len(normalized) == 1 or (
            normalized[0].width * normalized[0].height
            >= area_ratio * normalized[1].width * normalized[1].height
        )
        if dominant:
            chosen = normalized[0]
            faces_to_protect = [chosen]
            focus_x = chosen.x + chosen.width / 2
            subject_top = chosen.y * height
            subject_bottom = (chosen.y + chosen.height) * height
            desired_x = focus_x * width
            if len(normalized) > 1:
                flags.append("DOMINANT_FACE_BY_VISIBLE_AREA")
        else:
            faces_to_protect = normalized
            flags.append("AMBIGUOUS_MULTIPLE_FACES")
            group_left = min(face.x for face in normalized)
            group_right = max(face.x + face.width for face in normalized)
            focus_x = (group_left + group_right) / 2
            desired_x = focus_x * width
            subject_top = min(face.y for face in normalized) * height
            subject_bottom = max(face.y + face.height for face in normalized) * height
        focus_y = (subject_top + subject_bottom) / (2 * height)
    else:
        focus_x = focus_y = 0.5
        desired_x, desired_y = width * 0.5, height * 0.5
        subject_top = subject_bottom = desired_y
        flags.append("NO_FACE_DETECTED")

    crop_left = _clamp_origin(desired_x, crop_width_px, width)
    if manual or not normalized:
        crop_top = _clamp_origin(desired_y, crop_height_px, height)
    else:
        headroom = float(quality_settings.get("face_top_padding_ratio", 0.10))
        crop_top = int(round(subject_top - crop_height_px * headroom))
        crop_top = min(max(0, crop_top), max(0, height - crop_height_px))
    crop_box = (
        crop_left,
        crop_top,
        crop_left + crop_width_px,
        crop_top + crop_height_px,
    )
    crop_x, crop_y = crop_left / width, crop_top / height
    scale = max(target_size[0] / crop_width_px, target_size[1] / crop_height_px)
    flags.append(
        "UPSCALE_BASIC" if scale <= float(settings["scale_bands"]["basic_max"])
        else "UPSCALE_SHARP" if scale <= float(settings["scale_bands"]["sharpness_max"])
        else "UPSCALE_STRICT" if scale <= float(settings["scale_bands"]["strict_max"])
        else "UPSCALE_ABOVE_LIMIT"
    )
    if scale > float(settings["max_enlargement"]):
        if "UPSCALE_ABOVE_LIMIT" not in flags:
            flags.append("UPSCALE_ABOVE_LIMIT")

    if faces_to_protect and any(
        _visible_area(face, crop_box, (width, height)) < 0.999
        for face in faces_to_protect
    ):
        flags.append("FACE_OUTSIDE_CROP")
    if normalized and not manual:
        topmost = min(face.y for face in faces_to_protect) * height
        minimum_headroom = crop_height_px * float(
            quality_settings.get("minimum_face_headroom_ratio", 0.06)
        )
        if topmost - crop_top < minimum_headroom:
            flags.append("FACE_HEADROOM_UNAVAILABLE")
        if (
            max(face.y + face.height for face in faces_to_protect)
            > crop_y + 0.767 * crop_height
        ):
            flags.append("FACE_IN_TITLE_SAFE_ZONE")

    sharpness_roi = crop_box
    measured_face = next(
        (face for face in normalized if _visible_area(face, crop_box, (width, height)) > 0),
        None,
    )
    if measured_face is not None:
        margin_x = measured_face.width * width * 0.15
        margin_y = measured_face.height * height * 0.15
        sharpness_roi = (
            max(crop_left, int((measured_face.x * width) - margin_x)),
            max(crop_top, int((measured_face.y * height) - margin_y)),
            min(
                crop_left + crop_width_px,
                int(((measured_face.x + measured_face.width) * width) + margin_x),
            ),
            min(
                crop_top + crop_height_px,
                int(((measured_face.y + measured_face.height) * height) + margin_y),
            ),
        )
    face_sharpness = _sharpness(oriented, sharpness_roi)
    if scale <= float(settings["scale_bands"]["basic_max"]):
        sharpness_key = "basic_min_face_sharpness"
        face_width_key = "basic_min_face_width_px"
        face_height_key = "basic_min_face_height_px"
    elif scale <= float(settings["scale_bands"]["sharpness_max"]):
        sharpness_key = "sharp_min_face_sharpness"
        face_width_key = "sharp_min_face_width_px"
        face_height_key = "sharp_min_face_height_px"
    else:
        sharpness_key = "strict_min_face_sharpness"
        face_width_key = "strict_min_face_width_px"
        face_height_key = "strict_min_face_height_px"
    required_sharpness = float(quality_settings.get(sharpness_key, 0.0))
    required_face_width = float(quality_settings.get(face_width_key, 0.0))
    required_face_height = float(quality_settings.get(face_height_key, 0.0))
    measured_face_width = measured_face.width * width if measured_face else 0.0
    measured_face_height = measured_face.height * height if measured_face else 0.0
    if face_sharpness < required_sharpness:
        flags.append("FACE_SHARPNESS_BELOW_THRESHOLD")
    if measured_face and (
        measured_face_width < required_face_width
        or measured_face_height < required_face_height
    ):
        flags.append("FACE_TOO_SMALL_FOR_SCALE")

    review_flags = {
        "NO_FACE_DETECTED", "MANUAL_FOCUS", "AMBIGUOUS_MULTIPLE_FACES",
        "FACE_OUTSIDE_CROP", "FACE_HEADROOM_UNAVAILABLE", "FACE_IN_TITLE_SAFE_ZONE",
        "FACE_SHARPNESS_BELOW_THRESHOLD", "FACE_TOO_SMALL_FOR_SCALE", "UPSCALE_ABOVE_LIMIT",
    }
    unique_flags = tuple(dict.fromkeys(flags))
    review_required = any(flag in review_flags for flag in unique_flags)
    crop = CropPlan(
        x=crop_x,
        y=crop_y,
        width=crop_width,
        height=crop_height,
        scale=scale,
        focus_x=min(1.0, max(0.0, focus_x)),
        focus_y=min(1.0, max(0.0, focus_y)),
        review_required=review_required,
        flags=unique_flags,
    )
    quality = {
        "source_width_px": float(width),
        "source_height_px": float(height),
        "crop_width_px": float(crop_width_px),
        "crop_height_px": float(crop_height_px),
        "crop_scale": float(scale),
        "face_sharpness": float(face_sharpness),
        "required_face_sharpness": required_sharpness,
        "face_width_px": float(measured_face_width),
        "face_height_px": float(measured_face_height),
        "required_face_width_px": required_face_width,
        "required_face_height_px": required_face_height,
        "face_confidence": float(measured_face.confidence if measured_face else 0.0),
        "sharpness_roi_x": float(sharpness_roi[0]),
        "sharpness_roi_y": float(sharpness_roi[1]),
        "sharpness_roi_width": float(sharpness_roi[2] - sharpness_roi[0]),
        "sharpness_roi_height": float(sharpness_roi[3] - sharpness_roi[1]),
    }
    return PhotoEvaluation(
        faces=tuple(normalized),
        face_count=len(normalized),
        crop=crop,
        quality=quality,
        review_required=review_required,
        flags=unique_flags,
        analysis_ms=(time.perf_counter() - started) * 1000,
    )


def apply_crop(
    image: Image.Image,
    crop: CropPlan,
    size: tuple[int, int] = (1080, 1350),
) -> Image.Image:
    """Crop a validated normalized rectangle and resize without stretching."""
    if size[0] < 1 or size[1] < 1:
        raise ValueError("M9_CROP_OUTPUT_SIZE_INVALID")
    if not all(
        math.isfinite(value)
        for value in (crop.x, crop.y, crop.width, crop.height)
    ):
        raise ValueError("M9_CROP_RECT_INVALID")
    if crop.width <= 0 or crop.height <= 0 or crop.x < 0 or crop.y < 0:
        raise ValueError("M9_CROP_RECT_INVALID")
    if crop.x + crop.width > 1.000001 or crop.y + crop.height > 1.000001:
        raise ValueError("M9_CROP_RECT_INVALID")
    oriented = ImageOps.exif_transpose(image).convert("RGB")
    width, height = oriented.size
    crop_width = int(round(crop.width * width))
    crop_height = int(round(crop.height * height))
    target_aspect = size[0] / size[1]
    if crop_width / max(1, crop_height) > target_aspect:
        crop_width = int(round(crop_height * target_aspect))
    else:
        crop_height = int(round(crop_width / target_aspect))
    crop_width = min(width, max(1, crop_width))
    crop_height = min(height, max(1, crop_height))
    left = int(round(crop.x * width))
    top = int(round(crop.y * height))
    left = min(max(0, left), width - crop_width)
    top = min(max(0, top), height - crop_height)
    cropped = oriented.crop((left, top, left + crop_width, top + crop_height))
    return cropped.resize(size, Image.Resampling.LANCZOS)
