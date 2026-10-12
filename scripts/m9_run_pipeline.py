#!/usr/bin/env python3
"""M9 one-command, publisher-first news-photo preview pipeline.

Requires Python 3 + Pillow, Deno 2 + existing repository. Use only original
publisher URLs/subject aliases in an existing canonical brief. This launcher does
NOT configure scheduled execution, edit the active Telegram webhook, or
publish publicly. --send-telegram is opt-in and delivers PRIVATE review only.

Local:
 python3 scripts/m9_run_pipeline.py --brief-json brief.json \
     --workdir ./m9-preview --font /path/to/KoreanFont.otf --logo ./logo.png --cta ./cta.png \\
     --approved-image-hosts i.guim.co.uk

With configured service role, applied M9 migration and worker host:
 python3 scripts/m9_run_pipeline.py --brief-id UUID \
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
from m9_source_request_from_brief import build_request
from m9_preview_workflow import (
    Http, SupabaseGateway, TelegramGateway, job_key, safe_failure_category,
    pre_send_retry_job_keys, validate_preview_status,
)

ROOT = Path(__file__).resolve().parents[1]

def command(cmd: list[str]) -> None:
    # Do not echo token-bearing output or untrusted news HTML on errors.
    try:
        done = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, check=False, timeout=240)
    except subprocess.TimeoutExpired:
        stage = Path(cmd[1]).name if len(cmd) > 1 else "unknown"
        raise RuntimeError("M9_STAGE_TIMEOUT: " + stage) from None
    if done.returncode:
        stage = Path(cmd[1]).name if len(cmd) > 1 else "unknown"
        raise RuntimeError("M9_STAGE_FAILED: " + stage)

def content_slide_count(brief: dict) -> int:
    raw = brief.get("slides_json")
    slides = raw.get("slides") if isinstance(raw, dict) else raw
    if not isinstance(slides, list) or not 2 <= len(slides) <= 6:
        raise ValueError("M9_BRIEF_SLIDE_COUNT_INVALID")
    return len(slides)

def reviewed_selections_match(result: dict, expected_count: int) -> bool:
    selections = result.get("selections")
    if not isinstance(selections, list) or len(selections) != expected_count:
        return False
    for expected_number, selection in enumerate(selections, start=1):
        if not isinstance(selection, dict) or not isinstance(selection.get("selected"), dict):
            return False
        if selection.get("slide_number") != expected_number:
            return False
        if selection.get("slot") != ("COVER_NEWS" if expected_number == 1 else "BODY_NEWS"):
            return False
    return True

def require_exploration_owner_draft(brief: dict) -> None:
    metadata = brief.get("generation_metadata") if isinstance(brief.get("generation_metadata"), dict) else {}
    if brief.get("status") not in ("DRAFT", "SELECTED") or metadata.get("generation_intent") != "EXPLORATION":
        raise ValueError("M9_DRAFT_EXPLORATION_REQUIRED")

def claim_cloud_preview(remote: SupabaseGateway, brief: dict) -> str:
    original_key = job_key(brief, {})
    remote.ensure_private_bucket()
    previous = remote.get_preview(original_key)
    key = original_key
    manifest = {
        "content_mode": brief.get("content_mode"),
        "brief_version": brief.get("version"),
        "source": "telegram_owner_preview",
    }
    if previous is not None:
        if (previous.get("creative_brief_id") != brief["id"] or
                previous.get("status") != "FAILED" or
                previous.get("telegram_message_ids") != []):
            raise ValueError("M9_JOB_ALREADY_CLAIMED_NO_RETRY")
        retry_keys = pre_send_retry_job_keys(brief)
        retry_records = [remote.get_preview(retry_key) for retry_key in retry_keys]
        for attempt, (retry_key, retry_record) in enumerate(zip(retry_keys, retry_records), start=1):
            if retry_record is None:
                if any(later is not None for later in retry_records[attempt:]):
                    raise ValueError("M9_JOB_ALREADY_CLAIMED_NO_RETRY")
                key = retry_key
                manifest.update({
                    "retry_of": original_key,
                    "retry_reason": "CONFIRMED_PRE_SEND_FAILURE",
                    "retry_attempt": attempt,
                })
                break
            if (retry_record.get("creative_brief_id") != brief["id"] or
                    retry_record.get("status") != "FAILED" or
                    retry_record.get("telegram_message_ids") != []):
                raise ValueError("M9_JOB_ALREADY_CLAIMED_NO_RETRY")
        else:
            raise ValueError("M9_JOB_RETRY_ALREADY_USED")
    remote.claim(key, brief["id"], manifest)
    return key

def fail_unrendered_cloud_preview(remote: SupabaseGateway, key: str, error: BaseException) -> None:
    try:
        remote.transition(key, "CLAIMED", "FAILED", {
            "error_category": safe_failure_category(error),
        })
    except Exception:
        pass  # A later rendering stage may already have recorded a more precise terminal state.

def launch(argv: list[str] | None = None) -> Path:
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--brief-json")
    g.add_argument("--brief-id")
    p.add_argument("--request", help="Optional override. If omitted, derive publisher URLs and named photo subjects from creative_briefs.")
    p.add_argument("--approved-image-hosts", help="Operator-approved CDN hosts; defaults to M9_APPROVED_IMAGE_HOSTS")
    p.add_argument("--workdir", required=True)
    p.add_argument("--font", required=True)
    p.add_argument("--body-font", help="Optional Pretendard SemiBold font for body copy; defaults to --font")
    p.add_argument("--allow-draft-preview", action="store_true", help="Explicitly allow an Exploration DRAFT/SELECTED brief for private owner review")
    p.add_argument("--require-draft-owner-review", action="store_true", help="Require this run to be an explicit Exploration DRAFT owner delivery")
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
    remote = None
    if args.brief_id:
        remote = SupabaseGateway(os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SECRET_KEY", ""), Http())
        brief_data = remote.load_brief(args.brief_id, args.allow_draft_preview)
    else:
        brief_data = json.loads(Path(args.brief_json).read_text(encoding="utf-8"))
    validate_preview_status(brief_data, args.allow_draft_preview)
    if args.require_draft_owner_review:
        require_exploration_owner_draft(brief_data)
        if not args.allow_draft_preview or not args.send_telegram:
            raise ValueError("M9_DRAFT_TELEGRAM_SEND_REQUIRES_OWNER_OPT_IN")
    if args.send_telegram:
        if os.getenv("M9_ENABLE_TELEGRAM_PREVIEW") != "YES":
            raise ValueError("M9_TELEGRAM_PREVIEW_DISABLED")
        if not os.getenv("TELEGRAM_OWNER_USER_ID") or args.chat_id != os.getenv("TELEGRAM_OWNER_USER_ID"):
            raise ValueError("M9_TELEGRAM_OWNER_CHAT_REQUIRED")
    if brief_data.get("status") in ("DRAFT", "SELECTED") and args.send_telegram and not args.allow_draft_preview:
        raise ValueError("M9_DRAFT_TELEGRAM_SEND_REQUIRES_OWNER_OPT_IN")
    claimed_key = claim_cloud_preview(remote, brief_data) if args.upload and remote else None
    is_pre_send_recovery = claimed_key in pre_send_retry_job_keys(brief_data) if claimed_key else False
    try:
        telegram = None
        if args.send_telegram:
            telegram = TelegramGateway(os.getenv("TELEGRAM_BOT_TOKEN", ""), Http())
            if not is_pre_send_recovery:
                telegram.send_text(args.chat_id, "📨 비공개 카드뉴스 작업을 접수했습니다. 기사 원문에 연결된 사진 후보를 수집합니다.")
        if args.request:
            request_path = Path(args.request).resolve()
            request = json.loads(request_path.read_text(encoding="utf-8"))
        else:
            names = (args.approved_image_hosts or os.getenv("M9_APPROVED_IMAGE_HOSTS") or "").split(",")
            approved_hosts = [name.strip().lower() for name in names if name.strip()]
            request = build_request(brief_data, approved_hosts)
            request_path = root / "derived_source_request.json"
            request_path.write_text(json.dumps(request,ensure_ascii=False,indent=2),encoding="utf-8")
        hosts = request.get("allowed_image_hosts")
        if not isinstance(hosts, list) or not hosts or any(not isinstance(h, str) for h in hosts):
            raise ValueError("M9_ALLOWLIST_REQUIRED")
        candidate_file = root / "candidates.json"
        command([args.deno, "run", "--allow-read", "--allow-write", "--allow-net",
                 str(ROOT / "scripts/m9_collect_media.ts"),
                 str(request_path), str(candidate_file)])
        result = json.loads(candidate_file.read_text(encoding="utf-8"))
        if result.get("status") != "CANDIDATES_FOR_REVIEW" or not reviewed_selections_match(
            result, content_slide_count(brief_data)
        ):
            raise ValueError("M9_PHOTOS_REQUIRE_REVIEW_BEFORE_RENDER")
        media_dir = root / "photo_sources"
        command([sys.executable, str(ROOT / "scripts/m9_acquire_photos.py"),
                 "--candidates", str(candidate_file),
                 "--output", str(media_dir),
                 "--allowed-hosts", ",".join(hosts)])
        if telegram:
            telegram.send_text(args.chat_id, "🖼️ 사진 검토와 MediaPipe CPU 인물 분석을 마쳤습니다. 전체 페이지와 CTA를 렌더링하고 비공개 Storage를 검증합니다.")
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
        if args.body_font: next_command += ["--body-font", str(Path(args.body_font).resolve())]
        if args.allow_draft_preview: next_command += ["--allow-draft-preview"]
        if args.upload: next_command += ["--upload"]
        if claimed_key: next_command += ["--job-already-claimed", "--job-key", claimed_key]
        if args.send_telegram: next_command += ["--send-telegram","--chat-id", args.chat_id]
        command(next_command)
        state = root / "slides/delivery-state.json"
        if not state.exists():
            raise RuntimeError("M9_RENDER_OUTPUT_MISSING")
        report = json.loads(state.read_text(encoding="utf-8"))
        print(json.dumps({"status":report["status"],"slides_dir":str(root / "slides"),
                          "cta":"assets/cta.png","review_only":True},ensure_ascii=False))
        return state
    except Exception as exc:
        if claimed_key and remote:
            fail_unrendered_cloud_preview(remote, claimed_key, exc)
        raise

if __name__ == "__main__":
    launch()
