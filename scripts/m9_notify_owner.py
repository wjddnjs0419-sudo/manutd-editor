#!/usr/bin/env python3
"""Send one bounded M9 workflow status to the configured private owner chat."""
from __future__ import annotations

import argparse
import json
import os

from m9_preview_workflow import Http, TelegramGateway


def notify_owner(chat_id: str, owner_id: str, message: str, telegram: TelegramGateway) -> list[int]:
    if os.getenv("M9_ENABLE_TELEGRAM_PREVIEW") != "YES":
        raise ValueError("M9_TELEGRAM_PREVIEW_DISABLED")
    if not owner_id or chat_id != owner_id:
        raise ValueError("M9_TELEGRAM_OWNER_CHAT_REQUIRED")
    return telegram.send_text(owner_id, message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chat-id", required=True)
    parser.add_argument("--message", required=True)
    args = parser.parse_args()
    owner_id = os.getenv("TELEGRAM_OWNER_USER_ID") or ""
    telegram = TelegramGateway(os.getenv("TELEGRAM_BOT_TOKEN") or "", Http())
    message_ids = notify_owner(args.chat_id, owner_id, args.message, telegram)
    print(json.dumps({"status": "NOTIFIED", "message_count": len(message_ids)}))


if __name__ == "__main__":
    main()
