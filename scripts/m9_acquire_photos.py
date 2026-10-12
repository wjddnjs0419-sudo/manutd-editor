#!/usr/bin/env python3
"""M9: fetch shortlisted REAL article photos into local reviewed-only render media.

Input is M9 Deno collector output. Images are metadata-matched candidates,
not visually verified players or licensed public-republication material.
Downloads are bounded to exact configured, trusted publisher image CDN hosts.
No image-generation tools; original image data is retained in private workspace.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Protocol

from PIL import Image, ImageOps
from m9_photo_analysis import (
    MediaPipeFaceDetector,
    NormalizedFace,
    PhotoEvaluation,
    analyze_photo,
    decode_photo,
    ensure_face_model,
    load_crop_policy,
)

MAX_IMAGE_BYTES = 12 * 1024 * 1024
# Geometry and sharpness gates below decide whether a source is large enough.
MIN_DIMENSION = 1
MAX_FULL_IMAGES_PER_SLOT = 3
CANDIDATE_DOWNLOAD_FAILURES = {
    "M9_IMAGE_DOWNLOAD_FAILED",
    "M9_IMAGE_TOO_LARGE",
    "M9_INVALID_IMAGE_BYTES",
    "M9_IMAGE_TOO_SMALL_OR_UNSUPPORTED",
    "M9_IMAGE_DECODE_FAILED",
}
CANDIDATE_ANALYSIS_FAILURES = {
    "M9_IMAGE_DECODE_FAILED",
    "M9_SOURCE_TOO_SMALL_FOR_TARGET",
}
HARD_CROP_FAILURES = {
    "UPSCALE_ABOVE_LIMIT",
    "FACE_SHARPNESS_BELOW_THRESHOLD",
    "FACE_TOO_SMALL_FOR_SCALE",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_cdn_url(image_url: str, allowed_hosts: list[str]) -> None:
    parsed = urllib.parse.urlsplit(image_url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("M9_IMAGE_URL_NOT_HTTPS")
    if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", host) or host not in allowed_hosts:
        raise ValueError("M9_IMAGE_HOST_NOT_APPROVED")
    if len(image_url) > 2500:
        raise ValueError("M9_IMAGE_URL_TOO_LONG")


def fetch_bounded_image(image_url: str, allowed_hosts: list[str]) -> tuple[bytes, str]:
    validate_cdn_url(image_url, allowed_hosts)
    opener = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(image_url, headers={
        "user-agent": "ManutdEditorInternalPreview/1.0",
        "accept": "image/jpeg,image/png,image/webp",
    })
    try:
        with opener.open(req, timeout=20) as response:
            declared = response.headers.get("content-length")
            if declared and int(declared) > MAX_IMAGE_BYTES:
                raise ValueError("M9_IMAGE_TOO_LARGE")
            mime = response.headers.get("content-type", "").split(";")[0].lower()
            if mime not in ("image/jpeg", "image/png", "image/webp", "application/octet-stream"):
                raise ValueError("M9_IMAGE_MIME_INVALID")
            body = response.read(MAX_IMAGE_BYTES + 1)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        raise ValueError("M9_IMAGE_DOWNLOAD_FAILED") from None
    if len(body) > MAX_IMAGE_BYTES:
        raise ValueError("M9_IMAGE_TOO_LARGE")
    try:
        with Image.open(BytesIO(body)) as preview:
            fmt = preview.format
            dims = preview.size
            preview.verify()
    except (OSError, ValueError):
        raise ValueError("M9_INVALID_IMAGE_BYTES") from None
    if fmt not in ("JPEG", "PNG", "WEBP") or min(dims) < MIN_DIMENSION:
        raise ValueError("M9_IMAGE_TOO_SMALL_OR_UNSUPPORTED")
    return body, {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}[fmt]


class Detector(Protocol):
    def detect(self, image: Image.Image) -> list[NormalizedFace]: ...


Analyzer = Callable[[Image.Image, str, Detector], PhotoEvaluation]


def _validated_assessment(choice: Any, slot: str) -> dict[str, Any]:
    if not isinstance(choice, dict):
        raise ValueError("M9_PHOTO_ASSESSMENT_INVALID_" + slot)
    if choice.get("identity_evidence") != "ALT_OR_CAPTION_MATCH":
        raise ValueError("M9_SUBJECT_METADATA_NOT_CONFIRMED_" + slot)
    info = choice.get("candidate")
    probe = choice.get("probe")
    if not isinstance(info, dict) or not isinstance(probe, dict) or probe.get("status") != "VALID":
        raise ValueError("M9_IMAGE_PROBE_INVALID_" + slot)
    subject_match = choice.get("subject_match")
    if subject_match is not None:
        if not isinstance(subject_match, dict):
            raise ValueError("M9_SUBJECT_MATCH_INVALID_" + slot)
        requested = subject_match.get("requested_subjects")
        metadata_matched = subject_match.get("metadata_matched_subjects")
        filename_matched = subject_match.get("filename_matched_subjects")
        requested_count = subject_match.get("requested_subject_count")
        coverage = subject_match.get("coverage")
        if (not isinstance(requested, list) or not 1 <= len(requested) <= 6 or
                any(not isinstance(name, str) or len(name.strip()) < 4 for name in requested) or
                not isinstance(metadata_matched, list) or
                any(name not in requested for name in metadata_matched) or
                not isinstance(filename_matched, list) or
                any(name not in requested for name in filename_matched) or
                requested_count != len(requested) or coverage not in ("FULL", "PARTIAL") or
                (coverage == "FULL" and len(metadata_matched) != len(requested)) or
                (coverage == "PARTIAL" and not 0 < len(metadata_matched) < len(requested))):
            raise ValueError("M9_SUBJECT_MATCH_INVALID_" + slot)
    if info.get("rights_status") != "UNVERIFIED" or choice.get("can_auto_publish") is not False:
        raise ValueError("M9_REVIEW_STATUS_INVALID_" + slot)
    if "ARCHIVE_PHOTO" in (choice.get("flags") or []):
        raise ValueError("M9_ARCHIVED_PHOTO_REQUIRES_OVERRIDE")
    url = info.get("image_url")
    article_url = info.get("article_url")
    if not isinstance(url, str):
        raise ValueError("M9_IMAGE_SOURCE_REQUIRED")
    if not isinstance(article_url, str) or not article_url.startswith("https://"):
        raise ValueError("M9_IMAGE_ARTICLE_URL_REQUIRED")
    return choice


def _candidate_rejection(assessment: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "source_url": assessment["candidate"]["image_url"],
        "status": "REJECTED",
        "reasons": [reason],
    }


def _perceptual_hash(image: Image.Image) -> int:
    """Small dependency-free 64-bit DCT pHash for resized/re-encoded photos."""
    pixels = list(ImageOps.fit(image.convert("L"), (32, 32), method=Image.Resampling.LANCZOS).getdata())
    cosine = [[math.cos((2 * position + 1) * frequency * math.pi / 64) for position in range(32)]
              for frequency in range(8)]
    horizontal = [[sum(pixels[y * 32 + x] * cosine[u][x] for x in range(32))
                   for y in range(32)] for u in range(8)]
    coefficients = [
        sum(horizontal[u][y] * cosine[v][y] for y in range(32))
        for u in range(8) for v in range(8)
    ]
    median = sorted(coefficients[1:])[len(coefficients[1:]) // 2]
    value = 0
    for coefficient in coefficients:
        value = (value << 1) | int(coefficient > median)
    return value


def _visual_fingerprint(image: Image.Image) -> dict[str, Any]:
    rgb = image.convert("RGB")
    width, height = rgb.size
    target_ratio = 4 / 5
    if width / height > target_ratio:
        crop_width = round(height * target_ratio)
        left = (width - crop_width) // 2
        crop = rgb.crop((left, 0, left + crop_width, height))
    else:
        crop_height = round(width / target_ratio)
        top = (height - crop_height) // 2
        crop = rgb.crop((0, top, width, top + crop_height))
    mean = rgb.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
    return {
        "hashes": (_perceptual_hash(rgb), _perceptual_hash(crop)),
        "aspect": width / height,
        "mean_rgb": mean,
    }


def _same_visual(left: dict[str, Any], right: dict[str, Any]) -> bool:
    if abs(left["aspect"] - right["aspect"]) > 0.2:
        return False
    color_distance = math.sqrt(sum((a - b) ** 2 for a, b in zip(left["mean_rgb"], right["mean_rgb"])))
    if color_distance > 34:
        return False
    return min((a ^ b).bit_count() for a in left["hashes"] for b in right["hashes"]) <= 5


def choose_media(
    gathered: dict[str, Any], output: Path, allowed_hosts: list[str],
    downloader: Callable[[str, list[str]], tuple[bytes, str]] = fetch_bounded_image,
    detector: Detector | None = None,
    analyzer: Analyzer = analyze_photo,
) -> dict[str, Any]:
    if gathered.get("schema_version") != "m9-media-v1" or gathered.get("review_only") is not True:
        raise ValueError("M9_PHOTO_MANIFEST_INVALID")
    selections = gathered.get("selections")
    if not isinstance(selections, list):
        raise ValueError("M9_PHOTO_MANIFEST_INVALID")
    if not selections:
        raise ValueError("M9_PHOTO_REVIEW_REQUIRED_COVER_NEWS")
    choices: list[tuple[int, str, list[dict[str, Any]]]] = []
    next_body_slide = 2
    seen_slide_numbers: set[int] = set()
    for row in selections:
        if not isinstance(row, dict) or row.get("slot") not in ("COVER_NEWS", "BODY_NEWS"):
            raise ValueError("M9_PHOTO_SELECTION_INVALID")
        role_kind = str(row["slot"])
        slide_number = row.get("slide_number")
        if slide_number is None:
            slide_number = 1 if role_kind == "COVER_NEWS" else next_body_slide
        if not isinstance(slide_number, int) or slide_number < 1 or slide_number > 6:
            raise ValueError("M9_PHOTO_SLIDE_NUMBER_INVALID")
        if role_kind == "COVER_NEWS" and slide_number != 1:
            raise ValueError("M9_PHOTO_COVER_SLIDE_INVALID")
        if role_kind == "BODY_NEWS":
            next_body_slide = max(next_body_slide, slide_number + 1)
        if slide_number in seen_slide_numbers:
            raise ValueError("M9_PHOTO_SLIDE_NUMBER_DUPLICATE")
        seen_slide_numbers.add(slide_number)
        kind = "cover" if role_kind == "COVER_NEWS" else "body"
        if "shortlist" not in row:
            selected = row.get("selected")
            candidates = [selected] if isinstance(selected, dict) else []
        else:
            shortlist = row.get("shortlist")
            if not isinstance(shortlist, list):
                raise ValueError("M9_PHOTO_SHORTLIST_INVALID_" + role_kind)
            candidates = shortlist[:MAX_FULL_IMAGES_PER_SLOT]
        validated = [_validated_assessment(candidate, role_kind) for candidate in candidates]
        choices.append((slide_number, kind, validated))
    choices.sort(key=lambda row: row[0])
    if not any(slide == 1 and role == "cover" for slide, role, _ in choices):
        raise ValueError("M9_PHOTO_REVIEW_REQUIRED_COVER_NEWS")
    if not any(slide == 2 and role == "body" for slide, role, _ in choices):
        raise ValueError("M9_PHOTO_REVIEW_REQUIRED_BODY_NEWS")
    if detector is None:
        raise ValueError("M9_FACE_DETECTOR_REQUIRED")
    output.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {
        "editorial_review_only": True,
        "rights_status": "UNVERIFIED",
        "selection_status": "CANDIDATES_FOR_REVIEW",
        "candidate_attempts": {},
        "candidate_rejections": {},
        "quality_policy": load_crop_policy(),
        "candidate_count": int(gathered.get("candidate_count", len(selections))),
        "pages": [],
        "photo_shortage": {"missing_slide_numbers": [], "unique_image_count": 0},
    }
    cache: dict[str, tuple[bytes, str]] = {}
    download_failures: dict[str, str] = {}
    analysis_cache: dict[tuple[str, str], PhotoEvaluation] = {}
    fingerprint_by_slide: dict[int, dict[str, Any]] = {}
    photo_by_slide: dict[int, dict[str, Any]] = {}
    visual_by_digest: dict[str, dict[str, Any]] = {}
    policy = load_crop_policy()
    for slide_number, role, assessments in choices:
        attempt_key = role if slide_number in (1, 2) else f"slide_{slide_number:02d}"
        attempts: list[dict[str, Any]] = []
        rejections: list[dict[str, Any]] = []
        seen_urls: set[str] = set()
        passing_duplicate: tuple[dict[str, Any], str, dict[str, Any], PhotoEvaluation, str, int] | None = None
        chosen: tuple[dict[str, Any], str, dict[str, Any], PhotoEvaluation, str, int] | None = None
        for choice in assessments[:MAX_FULL_IMAGES_PER_SLOT]:
            item = choice["candidate"]
            url = item["image_url"]
            validate_cdn_url(url, allowed_hosts)
            if url in seen_urls:
                attempts.append({
                    "source_url": url,
                    "status": "SKIPPED",
                    "reasons": ["M9_DUPLICATE_CANDIDATE_URL"],
                })
                continue
            seen_urls.add(url)
            if url in download_failures:
                rejection = _candidate_rejection(choice, download_failures[url])
                attempts.append(rejection)
                rejections.append(rejection)
                continue
            try:
                if url not in cache:
                    cache[url] = downloader(url, allowed_hosts)
                data, ext = cache[url]
                if ext not in (".jpg", ".jpeg", ".png", ".webp"):
                    raise ValueError("M9_IMAGE_EXTENSION_INVALID")
                image = decode_photo(data)
            except ValueError as error:
                reason = str(error)
                if reason not in CANDIDATE_DOWNLOAD_FAILURES:
                    raise
                download_failures[url] = reason
                rejection = _candidate_rejection(choice, reason)
                attempts.append(rejection)
                rejections.append(rejection)
                continue
            digest = hashlib.sha256(data).hexdigest()
            try:
                evaluation = analysis_cache.get((digest, role))
                if evaluation is None:
                    evaluation = analyzer(image, role, detector)
                    analysis_cache[(digest, role)] = evaluation
            except ValueError as error:
                reason = str(error)
                if reason not in CANDIDATE_ANALYSIS_FAILURES:
                    raise
                rejection = _candidate_rejection(choice, reason)
                attempts.append(rejection)
                rejections.append(rejection)
                continue

            hard_failures = [flag for flag in evaluation.flags if flag in HARD_CROP_FAILURES]
            if evaluation.crop.scale > float(policy["max_enlargement"]):
                hard_failures.append("UPSCALE_ABOVE_LIMIT")
            visual = visual_by_digest.get(digest)
            if visual is None:
                visual = _visual_fingerprint(image)
                visual_by_digest[digest] = visual
            subject_match = choice.get("subject_match")
            review_flags = list(evaluation.flags)
            if isinstance(subject_match, dict) and subject_match.get("coverage") == "PARTIAL":
                review_flags.append("SUBJECT_METADATA_PARTIAL")
            attempt = {
                "source_url": url,
                "source_sha256": digest,
                "status": "REJECTED" if hard_failures else "SELECTED",
                "reasons": list(dict.fromkeys(hard_failures)),
                "face_count": evaluation.face_count,
                "crop_scale": evaluation.crop.scale,
                "review_required": evaluation.review_required,
                "review_flags": list(dict.fromkeys(review_flags)),
                "analysis_ms": evaluation.analysis_ms,
            }
            attempts.append(attempt)
            if hard_failures:
                rejections.append(attempt)
                continue

            duplicate_slide = next((prior for prior, prior_visual in fingerprint_by_slide.items()
                                     if prior_visual["sha256"] == digest or _same_visual(prior_visual["visual"], visual)), None)
            entry = {
                "slide_number": slide_number,
                "slot": "COVER_NEWS" if role == "cover" else "BODY_NEWS",
                "file": "",
                "source_url": url,
                "article_url": item["article_url"],
                "credit": str(item.get("credit") or "Photo credit: see original article")[:220],
                "source_sha256": digest,
                "subject_metadata_checked": True,
                "identity_evidence": choice["identity_evidence"],
                "subject_match": subject_match,
                "visual_subject_verified": False,
                "rights_status": "UNVERIFIED",
                "crop": asdict(evaluation.crop),
                "faces": [asdict(face) for face in evaluation.faces],
                "face_count": evaluation.face_count,
                "quality": evaluation.quality,
                "analysis_ms": evaluation.analysis_ms,
                "review_required": evaluation.review_required,
                "review_flags": list(dict.fromkeys(review_flags)),
                "crop_coordinates": asdict(evaluation.crop),
                "scale": evaluation.crop.scale,
                "subject_detection_result": {
                    "face_count": evaluation.face_count,
                    "faces": [asdict(face) for face in evaluation.faces],
                    "review_required": evaluation.review_required,
                    "review_flags": list(dict.fromkeys(review_flags)),
                    "analysis_ms": evaluation.analysis_ms,
                },
                "image_reuse_status": "UNIQUE" if duplicate_slide is None else "REUSED_EXACT" if fingerprint_by_slide[duplicate_slide]["sha256"] == digest else "REUSED_PERCEPTUAL",
            }
            if duplicate_slide is not None:
                if passing_duplicate is None:
                    original = photo_by_slide[duplicate_slide]
                    passing_duplicate = (choice, original["file"], original, evaluation, digest, duplicate_slide)
                attempt["status"] = "DUPLICATE"
                attempt["duplicate_of_slide_number"] = duplicate_slide
                attempt["reasons"] = [entry["image_reuse_status"]]
                continue
            chosen = (choice, "", entry, evaluation, digest, 0)
            break
        if chosen is None and passing_duplicate is not None:
            chosen = passing_duplicate
        if chosen is not None:
            choice, existing_file, entry, evaluation, digest, duplicate_slide = chosen
            item = choice["candidate"]
            ext = cache[item["image_url"]][1]
            if duplicate_slide:
                original = photo_by_slide[duplicate_slide]
                entry = {**original, "slide_number": slide_number, "slot": "BODY_NEWS",
                         "image_reuse_status": "REUSED_EXACT" if original["source_sha256"] == digest else "REUSED_PERCEPTUAL",
                         "duplicate_of_slide_number": duplicate_slide}
                file_name = original["file"]
            else:
                file_name = "cover" + ext if slide_number == 1 else "body" + ext if slide_number == 2 else f"slide_{slide_number:02d}" + ext
                path = output / file_name
                path.write_bytes(cache[item["image_url"]][0])
                fingerprint_by_slide[slide_number] = {"sha256": digest, "visual": visual_by_digest[digest]}
                entry["file"] = file_name
            entry["duplicate_of_slide_number"] = duplicate_slide or None
            photo_by_slide[slide_number] = entry
            attempts[-1]["status"] = "SELECTED" if not duplicate_slide else "REUSED"
            attempts[-1]["slide_number"] = slide_number
        result["candidate_attempts"][attempt_key] = attempts
        if rejections:
            result["candidate_rejections"][attempt_key] = rejections
        if slide_number in photo_by_slide:
            result["pages"].append(photo_by_slide[slide_number])
        else:
            result["selection_status"] = "REVIEW_REQUIRED"
            result["photo_shortage"]["missing_slide_numbers"].append(slide_number)
    if 1 in photo_by_slide:
        result["cover"] = photo_by_slide[1]
    if 2 in photo_by_slide:
        body_alias = {**photo_by_slide[2]}
        alias_path = output / ("body" + Path(body_alias["file"]).suffix)
        if body_alias["file"] != alias_path.name:
            alias_path.write_bytes((output / body_alias["file"]).read_bytes())
            body_alias["file"] = alias_path.name
        result["body"] = body_alias
    result["photo_shortage"]["unique_image_count"] = len(fingerprint_by_slide)
    result["photo_shortage"]["reused_page_count"] = sum(
        1 for page in result["pages"] if page["image_reuse_status"] != "UNIQUE"
    )
    result["page_photo_map"] = {str(page["slide_number"]): page for page in result["pages"]}
    (output / "media.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> None:
    cli = argparse.ArgumentParser()
    cli.add_argument("--candidates", required=True)
    cli.add_argument("--output", required=True)
    cli.add_argument("--allowed-hosts", required=True,
                     help="Comma-separated exact trusted publisher media CDN hostnames")
    args = cli.parse_args()
    hosts = [h.strip().lower() for h in args.allowed_hosts.split(",") if h.strip()]
    gathered = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
    detector = MediaPipeFaceDetector(ensure_face_model())
    try:
        result = choose_media(gathered, Path(args.output), hosts, detector=detector)
    finally:
        detector.close()
    print(json.dumps({"media_file": str(Path(args.output) / "media.json"),
                      "roles": ["cover", "body"],
                      "status": result["selection_status"],
                      "rights": result["rights_status"]}, ensure_ascii=False))
    if result["selection_status"] == "REVIEW_REQUIRED":
        raise SystemExit("M9_NO_CROP_QUALIFIED_CANDIDATE")


if __name__ == "__main__":
    main()
