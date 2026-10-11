#!/usr/bin/env python3
"""Automatically deliver recent READY creative briefs as PRIVATE Telegram reviews.

Called hourly by GitHub Actions; no manual brief ID or workflow_dispatch needed.
- Read recent READY drafts from the existing Supabase database.
- Skip already claimed/rendered/sent versions via service-role-only RPC.
- For suitable new stories: original article photos -> Pillow cover/body PNGs
  -> private Storage upload -> fixed CTA -> owner Telegram album.
- If subject/photo/source is ambiguous: skip safely, never make up images.
- Never publish to Instagram or claim photo redistribution permission.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Callable

from m9_preview_workflow import Http, SupabaseGateway, job_key

ROOT = Path(__file__).resolve().parents[1]
UUID_RE = re.compile(r"^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$")


def recent_ready_briefs(
    store: SupabaseGateway, now: datetime, hours_back: int = 24, limit: int = 30,
) -> list[dict[str, Any]]:
    if hours_back < 1 or hours_back > 48 or limit < 1 or limit > 40:
        raise ValueError("M9_POLL_LIMITS_INVALID")
    if now.tzinfo is None:
        raise ValueError("M9_NOW_MUST_BE_TIMEZONE_AWARE")
    cutoff = (now - timedelta(hours=hours_back)).astimezone(timezone.utc).isoformat(timespec="seconds")
    path = (
        "/rest/v1/creative_briefs?select=id,version,status,created_at"
        "&status=eq.READY&created_at=gte." + cutoff.replace("+00:00", "Z")
        + "&order=created_at.asc&limit=" + str(limit)
    )
    data = store.request("GET", path)
    if not isinstance(data, list):
        raise ValueError("M9_INVALID_BRIEF_LIST")
    eligible = []
    for item in data:
        if not isinstance(item, dict) or item.get("status") != "READY":
            continue
        identifier, version = item.get("id"), item.get("version")
        if not isinstance(identifier, str) or not UUID_RE.fullmatch(identifier) or type(version) is not int or version < 1:
            continue
        eligible.append(item)
    return eligible


def run_once(
    store: SupabaseGateway,
    *, now: datetime, image_hosts: list[str], font: Path,
    logo: Path, cta: Path, workdir: Path,
    chat_id: str, deno: str = "deno",
    max_sends: int = 2, hours_back: int = 24,
    command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    if max_sends < 1 or max_sends > 3:
        raise ValueError("M9_MAX_SENDS_RANGE")
    if not chat_id or not re.fullmatch(r"-?[0-9]+", chat_id):
        raise ValueError("M9_PRIVATE_CHAT_REQUIRED")
    if os.getenv("TELEGRAM_OWNER_USER_ID") != chat_id or os.getenv("M9_ENABLE_TELEGRAM_PREVIEW") != "YES":
        raise ValueError("M9_AUTOMATIC_OWNER_AUTH_REQUIRED")
    if not image_hosts or any(not re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,}",v) for v in image_hosts):
        raise ValueError("M9_IMAGE_HOST_ALLOWLIST_REQUIRED")
    ids = recent_ready_briefs(store, now, hours_back=hours_back)
    summary: dict[str, Any] = {
        "status": "COMPLETED", "seen_ready": len(ids), "skipped_existing": 0,
        "attempted": 0, "sent": 0, "failed": 0,
        "reason": "PRIVATE_EDITORIAL_REVIEW_ONLY",
    }
    for brief in ids:
        if summary["sent"] >= max_sends:
            break
        key = job_key(brief, {})
        if store.get_preview(key) is not None:
            summary["skipped_existing"] += 1
            continue
        summary["attempted"] += 1
        destination = workdir / brief["id"]
        args = [
            sys.executable, str(ROOT / "scripts/m9_run_pipeline.py"),
            "--brief-id", brief["id"],
            "--workdir", str(destination),
            "--font", str(font),
            "--logo", str(logo),
            "--cta", str(cta),
            "--approved-image-hosts", ",".join(image_hosts),
            "--upload", "--send-telegram", "--chat-id", chat_id,
            "--deno", deno,
        ]
        try:
            # Output (including signed URLs and photo metadata) stays private.
            finished = command(args, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, check=False, timeout=400)
            if finished.returncode != 0:
                summary["failed"] += 1
                continue
            result_path = destination / "slides" / "delivery-state.json"
            if not result_path.is_file():
                summary["failed"] += 1
                continue
            state = json.loads(result_path.read_text(encoding="utf-8"))
            if state.get("status") == "SENT":
                summary["sent"] += 1
            else:
                summary["failed"] += 1
        except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            summary["failed"] += 1
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--font", required=True)
    parser.add_argument("--logo", required=True)
    parser.add_argument("--cta", required=True)
    parser.add_argument("--deno", default="deno")
    parser.add_argument("--hours-back", type=int, default=24)
    parser.add_argument("--max-sends", type=int, default=2)
    args = parser.parse_args()
    secret = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SECRET_KEY") or ""
    store = SupabaseGateway(os.getenv("SUPABASE_URL", ""), secret, Http())
    hosts = [h.strip().lower() for h in os.getenv("M9_APPROVED_IMAGE_HOSTS", "").split(",") if h.strip()]
    result = run_once(
        store,
        now=datetime.now(timezone.utc),
        image_hosts=hosts,
        font=Path(args.font).resolve(),
        logo=Path(args.logo).resolve(),
        cta=Path(args.cta).resolve(),
        workdir=Path(args.workdir).resolve(),
        chat_id=os.getenv("TELEGRAM_OWNER_USER_ID", ""),
        deno=args.deno,
        max_sends=args.max_sends,
        hours_back=args.hours_back,
    )
    # Only aggregated counts printed; never secrets, brief identifiers, photo URLs.
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
