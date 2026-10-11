#!/usr/bin/env python3
"""Fetch the previously approved fixed CTA for LOCAL private-review previews.

No public bucket, no permanent public link, no generated image. Obtain a short-
lived signed URL from private Supabase Storage using a worker service key.
Verify the stored image is byte-identical to the previously approved CTA.

This is only for bundling local visual preview files. The Telegram delivery
path still signs the existing CTA object directly, without re-uploading it.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from PIL import Image
from m9_acquire_photos import NoRedirect
from m9_preview_workflow import Http, SupabaseGateway

APPROVED_CTA_SHA256 = "65d40cfa3421d343616eeb6d8412c1feac3aa1d051c3793f8086a0710ccfa88c"
APPROVED_CTA_PATH = "assets/cta.png"
MAX_CTA_BYTES = 2 * 1024 * 1024


def validate_approved_cta_bytes(value: bytes) -> None:
    if len(value) < 24 or len(value) > MAX_CTA_BYTES or not value.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("M9_CTA_INVALID_PNG_BYTES")
    if hashlib.sha256(value).hexdigest() != APPROVED_CTA_SHA256:
        raise ValueError("M9_CTA_ASSET_HASH_MISMATCH")
    with Image.open(BytesIO(value)) as image:
        if image.format != "PNG" or image.size != (1080, 1350):
            raise ValueError("M9_CTA_DIMENSIONS_INVALID")
        image.verify()


def download_approved_cta(gateway: SupabaseGateway, out: Path) -> Path:
    url = gateway.signed_url(APPROVED_CTA_PATH)
    # Signed URLs are from gateway's validated same-host Supabase origin.
    request = Request(url, headers={"accept": "image/png", "user-agent": "ManutdEditorM9PrivatePreview/1.0"})
    try:
        with build_opener(NoRedirect).open(request, timeout=25) as response:
            data = response.read(MAX_CTA_BYTES + 1)
    except (HTTPError, URLError, TimeoutError, OSError):
        raise ValueError("M9_CTA_DOWNLOAD_FAILED") from None
    validate_approved_cta_bytes(data)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return out


def main() -> None:
    cli = argparse.ArgumentParser()
    cli.add_argument("--out", required=True)
    args = cli.parse_args()
    secret = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SECRET_KEY") or ""
    gateway = SupabaseGateway(os.getenv("SUPABASE_URL", ""), secret, Http())
    result = download_approved_cta(gateway, Path(args.out).resolve())
    print("M9_CTA_OK", result.name, "bytes", result.stat().st_size)


if __name__ == "__main__":
    main()
