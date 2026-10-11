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
from io import BytesIO
from pathlib import Path
from typing import Any, Callable

from PIL import Image

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MIN_DIMENSION = 900


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


def choose_media(
    gathered: dict[str, Any], output: Path, allowed_hosts: list[str],
    downloader: Callable[[str, list[str]], tuple[bytes, str]] = fetch_bounded_image,
) -> dict[str, Any]:
    if gathered.get("schema_version") != "m9-media-v1" or gathered.get("review_only") is not True:
        raise ValueError("M9_PHOTO_MANIFEST_INVALID")
    selections = gathered.get("selections")
    if not isinstance(selections, list):
        raise ValueError("M9_PHOTO_MANIFEST_INVALID")
    expected = ("COVER_NEWS", "BODY_NEWS")
    choices: list[tuple[str, dict[str, Any]]] = []
    for kind in expected:
        row = next((r for r in selections if isinstance(r, dict) and r.get("slot") == kind), None)
        if not row or not isinstance(row.get("selected"), dict):
            raise ValueError("M9_PHOTO_REVIEW_REQUIRED_" + kind)
        choice = row["selected"]
        # This proves only the surrounding text mentions the player, not visual identity.
        if choice.get("identity_evidence") != "ALT_OR_CAPTION_MATCH":
            raise ValueError("M9_SUBJECT_METADATA_NOT_CONFIRMED_" + kind)
        info = choice.get("candidate")
        probe = choice.get("probe")
        if not isinstance(info, dict) or not isinstance(probe, dict) or probe.get("status") != "VALID":
            raise ValueError("M9_IMAGE_PROBE_INVALID_" + kind)
        if info.get("rights_status") != "UNVERIFIED" or choice.get("can_auto_publish") is not False:
            raise ValueError("M9_REVIEW_STATUS_INVALID_" + kind)
        if "ARCHIVE_PHOTO" in (choice.get("flags") or []):
            raise ValueError("M9_ARCHIVED_PHOTO_REQUIRES_OVERRIDE")
        choices.append(("cover" if kind == "COVER_NEWS" else "body", info))
    output.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {
        "editorial_review_only": True,
        "rights_status": "UNVERIFIED",
        "selection_status": "CANDIDATES_FOR_REVIEW",
    }
    cache: dict[str, tuple[bytes, str]] = {}
    for role, item in choices:
        url = item.get("image_url")
        if not isinstance(url, str):
            raise ValueError("M9_IMAGE_SOURCE_REQUIRED")
        if url not in cache:
            cache[url] = downloader(url, allowed_hosts)
        data, ext = cache[url]
        path = output / (role + ext)
        path.write_bytes(data)
        credit = item.get("credit") or "Photo credit: see original article"
        article_url = item.get("article_url")
        if not isinstance(article_url, str) or not article_url.startswith("https://"):
            raise ValueError("M9_IMAGE_ARTICLE_URL_REQUIRED")
        result[role] = {
            "file": path.name, "source_url": url, "article_url": article_url,
            "credit": str(credit)[:220],
            "source_sha256": hashlib.sha256(data).hexdigest(),
            "subject_metadata_checked": True,
            "visual_subject_verified": False,
            "rights_status": "UNVERIFIED",
        }
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
    result = choose_media(gathered, Path(args.output), hosts)
    print(json.dumps({"media_file": str(Path(args.output) / "media.json"),
                      "roles": ["cover", "body"],
                      "status": "PRIVATE_REVIEW_ONLY",
                      "rights": result["rights_status"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
