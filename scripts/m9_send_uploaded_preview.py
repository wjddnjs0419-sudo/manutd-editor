#!/usr/bin/env python3
"""Owner-only M9 approval: send ALREADY-UPLOADED private PNG review album.

Run after the draft has been rendered and uploaded by the M9 workflow.
NO photo recollection, no re-render, no re-upload, no duplicate job claims.
Sends to the exact owner Telegram chat and never retries an uncertain send.
Does not publish to Instagram or authorize image copyright reuse.
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.parse
import uuid
from typing import Any

from m9_preview_workflow import (
    CTA_PATH, Http, SupabaseGateway, TelegramGateway, job_key,
)


def uploaded_paths(key: str) -> list[str]:
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
    query = urllib.parse.quote(key, safe="")
    rows = store.request(
        "GET",
        "/rest/v1/m9_preview_jobs?select=job_key,creative_brief_id,status"
        f"&job_key=eq.{query}&limit=1",
        schema="app_private",
    )
    if not isinstance(rows, list) or len(rows) != 1:
        raise ValueError("M9_UPLOADED_PREVIEW_NOT_FOUND")
    row = rows[0]
    if row.get("creative_brief_id") != brief.get("id") or row.get("status") != "UPLOADED":
        raise ValueError("M9_PREVIEW_NOT_APPROVED_FOR_SEND")

    # Preflight access before irreversible SENDING state transition.
    signed = [store.signed_url(path) for path in uploaded_paths(key)]
    caption = (
        "맨유 에디터 | 카드뉴스 검토용 미리보기\n"
        + str(brief.get("caption_draft") or "").strip()[:850]
        + "\n\n⚠️ 사진 사용권·디자인 검토 후 게시"
    )
    store.transition(key, "UPLOADED", "SENDING")
    try:
        ids = telegram.send_album(owner_chat_id, signed, caption)
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
