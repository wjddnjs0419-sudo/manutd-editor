#!/usr/bin/env python3
"""Run a credential-free CPU smoke check with a generated image and pinned model."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

from m9_photo_analysis import (
    MODEL_SHA256, MediaPipeFaceDetector, analyze_photo, ensure_face_model,
    load_crop_policy,
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as model:
        for block in iter(lambda: model.read(128 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _generated_image() -> Image.Image:
    """Create a synthetic, non-photographic input entirely in memory."""
    image = Image.new("RGB", (1600, 900), "#26354a")
    draw = ImageDraw.Draw(image)
    draw.ellipse((625, 105, 975, 545), fill="#e8bd91")
    draw.ellipse((710, 260, 755, 305), fill="#20242a")
    draw.ellipse((845, 260, 890, 305), fill="#20242a")
    draw.arc((730, 300, 880, 445), start=15, end=165, fill="#6b3e38", width=12)
    draw.rectangle((540, 520, 1060, 900), fill="#8e2638")
    return image


def run_smoke(model_path: Path, report_path: Path | None = None) -> dict:
    started = time.perf_counter()
    verified_model = ensure_face_model(Path(model_path))
    model_digest = _sha256(verified_model)
    if model_digest != MODEL_SHA256:
        raise ValueError("M9_FACE_MODEL_SHA256_MISMATCH")

    load_started = time.perf_counter()
    detector = MediaPipeFaceDetector(verified_model)
    model_load_ms = (time.perf_counter() - load_started) * 1000
    image = _generated_image()
    try:
        inference_started = time.perf_counter()
        detected = detector.detect(image)
        inference_ms = (time.perf_counter() - inference_started) * 1000
        evaluation = analyze_photo(image, "cover", detector)
    finally:
        detector.close()

    crop = evaluation.crop
    physical_aspect = (image.width * crop.width) / (image.height * crop.height)
    output_status = (
        "PASS" if crop.scale <= float(load_crop_policy()["max_enlargement"])
        and abs(physical_aspect - (1080 / 1350)) <= 0.001
        else "FAIL"
    )
    versions = {
        "python": sys.version.split()[0],
        "mediapipe": importlib.metadata.version("mediapipe"),
        "pillow": importlib.metadata.version("Pillow"),
        "numpy": importlib.metadata.version("numpy"),
        "opencv": importlib.metadata.version("opencv-contrib-python"),
    }
    report = {
        "model_sha256": model_digest,
        "runtime_versions": versions,
        "model_load_ms": round(model_load_ms, 3),
        "inference_ms": round(inference_ms, 3),
        "image_count": 1,
        "candidate_count": 1,
        "max_candidates_per_slot": 3,
        "face_count": len(detected),
        "crop_scale": round(crop.scale, 4),
        "review_required": evaluation.review_required,
        "output_status": output_status,
        "total_elapsed_seconds": round(time.perf_counter() - started, 3),
    }
    if report_path is not None:
        destination = Path(report_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n",
                               encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", required=True,
                        help="Path for the official hash-pinned BlazeFace model")
    parser.add_argument("--report", required=True,
                        help="Local JSON destination for aggregate metrics only")
    args = parser.parse_args()
    report = run_smoke(Path(args.model_path), Path(args.report))
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    if report["output_status"] != "PASS":
        raise SystemExit("M9_CPU_SMOKE_FAILED")


if __name__ == "__main__":
    main()
