#!/usr/bin/env python3
"""Owner-only M9 approval: send ALREADY-UPLOADED private PNG review album.

Run after the draft has been rendered and uploaded by the M9 workflow.
NO photo recollection, no re-render, no re-upload, no duplicate job claims.
Sends to the exact owner Telegram chat and never retries an uncertain send.
Does not publish to Instagram or authorize image copyright reuse.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import uuid
from typing import Any

from m9_preview_workflow import (
    CTA_PATH, Http, SupabaseGateway, TelegramGateway, job_key, preview_caption,
)


def uploaded_paths(key: str, manifest: Any = None) -> list[str]:
    if isinstance(manifest, dict) and isinstance(manifest.get("image_paths"), list):
        paths = manifest["image_paths"]
        if not 2 <= len(paths) <= 7 or any(
            not isinstance(path, str) or not re.fullmatch(r"previews/[a-f0-9-]{36}/slide_0[1-7]\.png", path)
            for path in paths
        ):
            raise ValueError("M9_UPLOADED_MANIFEST_INVALID")
        expected = [f"slide_{index:02d}.png" for index in range(1, len(paths) + 1)]
        if [path.rsplit("/", 1)[-1] for path in paths] != expected or \
                len({path.rsplit("/", 1)[0] for path in paths}) != 1 or \
                manifest.get("slide_count") != len(paths):
            raise ValueError("M9_UPLOADED_MANIFEST_INVALID")
        slides = manifest.get("slides")
        if not isinstance(slides, list) or len(slides) != len(paths) or \
                not isinstance(slides[-1], dict) or slides[-1].get("kind") != "CTA":
            raise ValueError("M9_UPLOADED_MANIFEST_INVALID")
        return paths
    # Backward compatibility for READY jobs created before per-job CTA upload.
    directory = str(uuid.uuid5(uuid.NAMESPACE_URL, key))
    return [
        f"previews/{directory}/slide_01.png",
        f"previews/{directory}/slide_02.png",
        CTA_PATH,
    ]


def deliver_existing(
    brief: dict[str, Any], store: SupabaseGateway, telegram: TelegramGateway,
    owner_chat_id: str,
) -> dict[str, Any]:
    key = job_key(brief, {})
    row = store.get_preview(key)
    if row is None:
        raise ValueError("M9_UPLOADED_PREVIEW_NOT_FOUND")
    if row.get("creative_brief_id") != brief.get("id") or row.get("status") != "UPLOADED":
        raise ValueError("M9_PREVIEW_NOT_APPROVED_FOR_SEND")

    # Preflight access before irreversible SENDING state transition.
    rendered = row.get("rendered_manifest") if isinstance(row.get("rendered_manifest"), dict) else {}
    paths = uploaded_paths(key, rendered)
    caption = rendered.get("caption") if isinstance(rendered.get("caption"), str) else preview_caption(brief)
    documents: list[tuple[str, bytes]] | None = None
    if isinstance(rendered.get("image_paths"), list):
        rows = rendered.get("slides")
        if not isinstance(rows, list) or len(rows) != len(paths):
            raise ValueError("M9_UPLOADED_MANIFEST_INVALID")
        documents = []
        for index, (path, row) in enumerate(zip(paths, rows), start=1):
            if not isinstance(row, dict) or row.get("slide_order") != index or row.get("image_path") != path or \
                    not isinstance(row.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", row["sha256"]):
                raise ValueError("M9_UPLOADED_MANIFEST_INVALID")
            data = store.download_private_png(path)
            if hashlib.sha256(data).hexdigest() != row["sha256"]:
                raise ValueError("M9_STORAGE_SHA256_MISMATCH")
            documents.append((f"slide_{index:02d}.png", data))
    else:
        # Legacy READY jobs predate per-job PNG manifests; retain their signed-URL photo path.
        signed = [store.signed_url(path) for path in paths]
    store.transition(key, "UPLOADED", "SENDING")
    try:
        ids = telegram.send_png_documents(owner_chat_id, documents) if documents is not None else telegram.send_album(owner_chat_id, signed, "")
        ids.extend(telegram.send_text(owner_chat_id, caption))
        store.transition(key, "SENDING", "SENT", {"telegram_message_ids": ids})
    except Exception:
        try:
            store.transition(key, "SENDING", "SEND_UNCERTAIN", {
                "error_category": "SEND_AMBIGUOUS",
            })
        except Exception:
            pass
        raise
    return {"status": "SENT", "job_key": key, "message_count": len(ids)}


def main() -> None:
    cli = argparse.ArgumentParser()
    cli.add_argument("--brief-id", required=True)
    cli.add_argument("--chat-id", required=True)
    args = cli.parse_args()
    if os.getenv("M9_ENABLE_TELEGRAM_PREVIEW") != "YES":
        cli.error("M9 private preview send is disabled")
    owner_id = os.getenv("TELEGRAM_OWNER_USER_ID") or ""
    if not owner_id or args.chat_id != owner_id:
        cli.error("Telegram chat must match the configured owner")
    secret = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SECRET_KEY") or ""
    store = SupabaseGateway(os.getenv("SUPABASE_URL", ""), secret, Http())
    telegram = TelegramGateway(os.getenv("TELEGRAM_BOT_TOKEN", ""), Http())
    brief = store.load_brief(args.brief_id)
    result = deliver_existing(brief, store, telegram, owner_id)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
