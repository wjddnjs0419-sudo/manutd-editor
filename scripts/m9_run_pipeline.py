#!/usr/bin/env python3
"""M9 one-command, publisher-first news-photo preview pipeline.

Requires Python 3 + Pillow, Deno 2 + existing repository. Use only original
publisher URLs/subject aliases you intentionally supplied. This launcher does
NOT configure scheduled execution, edit the active Telegram webhook, or
publish publicly. --send-telegram is opt-in and delivers PRIVATE review only.

Local:
 python3 scripts/m9_run_pipeline.py --request request.json --brief-json brief.json \
     --workdir ./m9-preview --font /path/to/KoreanFont.otf --logo ./logo.png --cta ./cta.png

With configured service role, applied M9 migration and worker host:
 python3 scripts/m9_run_pipeline.py --request request.json --brief-id UUID \
     --workdir ./m9-preview --font /path/to/font --logo ./logo.png \
     --upload --send-telegram --chat-id OWNER_CHAT_ID

No credentials should be passed in command arguments.
"""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def command(cmd: list[str]) -> None:
    # Do not echo token-bearing output or untrusted news HTML on errors.
    done = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=False, timeout=240)
    if done.returncode:
        raise RuntimeError("M9_STAGE_FAILED: " + Path(cmd[1]).name if len(cmd)>1 else "M9_STAGE_FAILED")

def launch(argv: list[str] | None = None) -> Path:
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--brief-json")
    g.add_argument("--brief-id")
    p.add_argument("--request", required=True)
    p.add_argument("--workdir", required=True)
    p.add_argument("--font", required=True)
    p.add_argument("--logo")
    p.add_argument("--cta")
    p.add_argument("--deno", default="deno")
    p.add_argument("--upload", action="store_true")
    p.add_argument("--send-telegram", action="store_true")
    p.add_argument("--chat-id")
    args = p.parse_args(argv)
    if args.send_telegram and (not args.upload or not args.chat_id):
        p.error("--send-telegram requires --upload and --chat-id")
    root = Path(args.workdir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    hosts = request.get("allowed_image_hosts")
    if not isinstance(hosts, list) or not hosts or any(not isinstance(h, str) for h in hosts):
        raise ValueError("M9_ALLOWLIST_REQUIRED")
    candidate_file = root / "candidates.json"
    command([args.deno, "run", "--allow-read", "--allow-write", "--allow-net",
             str(ROOT / "scripts/m9_collect_media.ts"),
             str(Path(args.request).resolve()), str(candidate_file)])
    result = json.loads(candidate_file.read_text(encoding="utf-8"))
    if result.get("status") != "CANDIDATES_FOR_REVIEW" or any(
        not isinstance(s.get("selected"), dict) for s in result.get("selections",[])
    ) or len(result.get("selections",[])) != 2:
        raise ValueError("M9_PHOTOS_REQUIRE_REVIEW_BEFORE_RENDER")
    media_dir = root / "photo_sources"
    command([sys.executable, str(ROOT / "scripts/m9_acquire_photos.py"),
             "--candidates", str(candidate_file),
             "--output", str(media_dir),
             "--allowed-hosts", ",".join(hosts)])
    next_command = [
        sys.executable, str(ROOT / "scripts/m9_preview_workflow.py"),
        "--media", str(media_dir / "media.json"),
        "--out", str(root / "slides"),
        "--font", str(Path(args.font).resolve()),
    ]
    next_command += (["--brief-id", args.brief_id] if args.brief_id else
                     ["--brief-json", str(Path(args.brief_json).resolve())])
    if args.logo: next_command += ["--logo", str(Path(args.logo).resolve())]
    if args.cta: next_command += ["--cta", str(Path(args.cta).resolve())]
    if args.upload: next_command += ["--upload"]
    if args.send_telegram: next_command += ["--send-telegram","--chat-id", args.chat_id]
    command(next_command)
    state = root / "slides/delivery-state.json"
    if not state.exists():
        raise RuntimeError("M9_RENDER_OUTPUT_MISSING")
    report = json.loads(state.read_text(encoding="utf-8"))
    print(json.dumps({"status":report["status"],"slides_dir":str(root / "slides"),
                      "cta":"assets/cta.png","review_only":True},ensure_ascii=False))
    return state

if __name__ == "__main__":
    launch()
