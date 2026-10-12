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
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Protocol

from PIL import Image
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
    expected = ("COVER_NEWS", "BODY_NEWS")
    choices: list[tuple[str, list[dict[str, Any]]]] = []
    for kind in expected:
        row = next((r for r in selections if isinstance(r, dict) and r.get("slot") == kind), None)
        if not row:
            raise ValueError("M9_PHOTO_REVIEW_REQUIRED_" + kind)
        if "shortlist" not in row:
            selected = row.get("selected")
            if not isinstance(selected, dict):
                raise ValueError("M9_PHOTO_REVIEW_REQUIRED_" + kind)
            candidates = [selected]
        else:
            shortlist = row.get("shortlist")
            if not isinstance(shortlist, list):
                raise ValueError("M9_PHOTO_SHORTLIST_INVALID_" + kind)
            candidates = shortlist[:MAX_FULL_IMAGES_PER_SLOT]
            if not candidates:
                raise ValueError("M9_PHOTO_REVIEW_REQUIRED_" + kind)
        validated = [_validated_assessment(candidate, kind) for candidate in candidates]
        choices.append(("cover" if kind == "COVER_NEWS" else "body", validated))
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
    }
    cache: dict[str, tuple[bytes, str]] = {}
    download_failures: dict[str, str] = {}
    policy = load_crop_policy()
    for role, assessments in choices:
        attempts: list[dict[str, Any]] = []
        rejections: list[dict[str, Any]] = []
        seen_urls: set[str] = set()
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
            try:
                evaluation = analyzer(image, role, detector)
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
            digest = hashlib.sha256(data).hexdigest()
            attempt = {
                "source_url": url,
                "source_sha256": digest,
                "status": "REJECTED" if hard_failures else "SELECTED",
                "reasons": list(dict.fromkeys(hard_failures)),
                "face_count": evaluation.face_count,
                "crop_scale": evaluation.crop.scale,
                "review_required": evaluation.review_required,
                "review_flags": list(evaluation.flags),
                "analysis_ms": evaluation.analysis_ms,
            }
            attempts.append(attempt)
            if hard_failures:
                rejections.append(attempt)
                continue

            path = output / (role + ext)
            path.write_bytes(data)
            result[role] = {
                "file": path.name,
                "source_url": url,
                "article_url": item["article_url"],
                "credit": str(item.get("credit") or "Photo credit: see original article")[:220],
                "source_sha256": digest,
                "subject_metadata_checked": True,
                "identity_evidence": choice["identity_evidence"],
                "visual_subject_verified": False,
                "rights_status": "UNVERIFIED",
                "crop": asdict(evaluation.crop),
                "faces": [asdict(face) for face in evaluation.faces],
                "face_count": evaluation.face_count,
                "quality": evaluation.quality,
                "analysis_ms": evaluation.analysis_ms,
                "review_required": evaluation.review_required,
                "review_flags": list(evaluation.flags),
            }
            break
        result["candidate_attempts"][role] = attempts
        if rejections:
            result["candidate_rejections"][role] = rejections
        if role not in result:
            result["selection_status"] = "REVIEW_REQUIRED"
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
