#!/usr/bin/env python3
"""M9 private-review delivery worker.

1. Load an existing creative_briefs row (no AI rewrite).
2. Render supplied, editorially selected real photo files via Pillow.
3. Claim a unique M9 job, upload only rendered PNGs into private Storage.
4. Sign both PNGs plus the once-uploaded CTA; optionally send Telegram album.

This is a Python-capable WORKER, not a Supabase/Deno Edge Function.
A Telegram send in flight is never retried: SENDING -> SEND_UNCERTAIN on failure.
This worker never posts to Instagram, never acquires photo reuse rights,
and does not infer that photo metadata is visual identity confirmation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from m9_render_news_deck import render

BUCKET = "manutd-card-assets"
CTA_PATH = "assets/cta.png"
MAX_BYTES = 12 * 1024 * 1024
UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def json_bytes(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def split_hook(text: str) -> tuple[str, str]:
    """Only break existing Korean hook text; never invent/rewrite claims."""
    text = text.strip()
    if not text or len(text) < 5:
        raise ValueError("M9_HOOK_TOO_SHORT")
    if "\n" in text:
        pieces = [x.strip() for x in text.splitlines() if x.strip()]
        if len(pieces) == 2:
            return pieces[0], pieces[1]
    text = " ".join(text.split())
    positions = [m.start() for m in re.finditer(r"\s+", text)]
    if not positions:
        cut = len(text) // 2
        return text[:cut].strip(), text[cut:].strip()
    middle = len(text) // 2
    cut = min(positions, key=lambda x: abs(x - middle))
    return text[:cut].strip(), text[cut:].strip()


def brief_slides(brief: dict[str, Any]) -> list[dict[str, Any]]:
    # Production creative_briefs.slides_json is {"slides":[...]}, not an array.
    raw = brief.get("slides_json")
    if isinstance(raw, dict):
        raw = raw.get("slides")
    if not isinstance(raw, list):
        raise ValueError("M9_BRIEF_SLIDES_INVALID")
    slides = [s for s in raw if isinstance(s, dict)]
    slides.sort(key=lambda s: int(s.get("slide_number", s.get("index", 0))))
    if len(slides) < 2:
        raise ValueError("M9_BRIEF_REQUIRES_TWO_SLIDES")
    return slides


def safe_local_file(media_root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name:
        raise ValueError("M9_MEDIA_FILE_REQUIRED")
    result = (media_root / name).resolve()
    if not result.is_relative_to(media_root.resolve()) or not result.is_file():
        raise ValueError("M9_MEDIA_FILE_INVALID")
    if result.stat().st_size > MAX_BYTES:
        raise ValueError("M9_MEDIA_FILE_TOO_LARGE")
    return result


def checked_media(media: dict[str, Any], media_root: Path) -> dict[str, Any]:
    if media.get("editorial_review_only") is not True:
        raise ValueError("M9_REVIEW_ONLY_REQUIRED")
    for slot in ("cover", "body"):
        info = media.get(slot)
        if not isinstance(info, dict):
            raise ValueError(f"M9_{slot.upper()}_MEDIA_REQUIRED")
        photo_file = safe_local_file(media_root, info.get("file", ""))
        expected_sha = info.get("source_sha256")
        if expected_sha is not None:
            if not isinstance(expected_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_sha):
                raise ValueError("M9_MEDIA_HASH_INVALID")
            if hashlib.sha256(photo_file.read_bytes()).hexdigest() != expected_sha:
                raise ValueError("M9_MEDIA_HASH_MISMATCH")
        for field in ("source_url", "article_url", "credit"):
            if not isinstance(info.get(field), str) or not info[field].strip():
                raise ValueError(f"M9_{slot.upper()}_{field.upper()}_REQUIRED")
        for field in ("source_url", "article_url"):
            u = urllib.parse.urlsplit(info[field])
            if u.scheme != "https" or not u.hostname or u.username or u.password:
                raise ValueError("M9_SOURCE_URL_INVALID")
        if info.get("subject_metadata_checked") is not True:
            raise ValueError("M9_SUBJECT_METADATA_REVIEW_REQUIRED")
    return media


def prepared_render_job(brief: dict[str, Any], media: dict[str, Any]) -> dict[str, Any]:
    slides = brief_slides(brief)
    first, second = slides[0], slides[1]
    hooks = brief.get("hooks_json")
    hook = first.get("headline", "")
    if isinstance(hooks, list) and hooks and isinstance(hooks[0], dict):
        hook = hooks[0].get("text") or hook
    line_one, line_two = split_hook(str(hook))
    body = second.get("body")
    if not isinstance(body, str) or not body.strip():
        raise ValueError("M9_BODY_TEXT_REQUIRED")
    paragraphs = [x.strip() for x in body.splitlines() if x.strip()]
    if len(paragraphs) == 1:
        # Preserve exact original prose. The renderer will wrap visually.
        paragraphs = [body.strip()]
    headline = second.get("headline")
    if not isinstance(headline, str) or not headline.strip():
        raise ValueError("M9_BODY_HEADLINE_REQUIRED")
    cover = media["cover"]
    body_media = media["body"]
    return {
        "article_url": cover["article_url"],
        "article_published_at": brief.get("generated_at") or brief.get("created_at") or "",
        "eyebrow": media.get("eyebrow") or "■  NEWS  |  맨유 에디터",
        "cover_line_one": line_one,
        "cover_line_two": line_two,
        "body_headline": headline,
        "body_paragraphs": paragraphs,
        "body_highlight": second.get("highlight") or "",
        "cover_photo": cover["file"],
        "body_photo": body_media["file"],
        "cover_photo_credit": cover["credit"],
        "body_photo_credit": body_media["credit"],
        "cover_photo_source": cover["source_url"],
        "body_photo_source": body_media["source_url"],
        "cover_source_article_url": cover["article_url"],
        "body_source_article_url": body_media["article_url"],
    }


def job_key(brief: dict[str, Any], media: dict[str, Any]) -> str:
    brief_id = str(brief.get("id") or "")
    if not UUID.fullmatch(brief_id):
        raise ValueError("M9_CREATIVE_BRIEF_ID_REQUIRED")
    # One private-preview delivery per canonical brief revision, regardless of
    # rotating CDN signatures or newly downloaded media filenames.
    revision = brief.get("version")
    if not isinstance(revision, int) or revision < 1:
        raise ValueError("M9_CREATIVE_BRIEF_VERSION_REQUIRED")
    return "m9:" + brief_id + ":v" + str(revision)


class RemoteError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Http:
    """Injectable synchronous transport. Does not expose tokens or error bodies."""
    def request(self, method: str, url: str, headers: dict[str, str],
                body: bytes | None = None) -> bytes:
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                return resp.read(1024 * 1024)
        except urllib.error.HTTPError as exc:
            raise RemoteError(exc.code, f"M9_HTTP_{exc.code}") from None
        except (TimeoutError, OSError, urllib.error.URLError):
            raise RemoteError(0, "M9_NETWORK_UNCERTAIN") from None


class SupabaseGateway:
    def __init__(self, url: str, secret: str, http: Http):
        base = url.rstrip("/")
        u = urllib.parse.urlsplit(base)
        if u.scheme != "https" or not u.netloc or u.username or u.password:
            raise ValueError("M9_SUPABASE_HTTPS_REQUIRED")
        if not secret:
            raise ValueError("M9_SERVICE_ROLE_KEY_REQUIRED")
        self.base, self.secret, self.http = base, secret, http

    def request(self, method: str, path: str, payload: Any = None,
                *, schema: str | None = None, content_type: str = "application/json",
                headers: dict[str, str] | None = None) -> Any:
        h = {"apikey": self.secret, "authorization": "Bearer " + self.secret,
             "content-type": content_type, **(headers or {})}
        if schema:
            h["accept-profile"] = schema
            h["content-profile"] = schema
        data = None if payload is None else json_bytes(payload) if content_type == "application/json" else payload
        response = self.http.request(method, self.base + path, h, data)
        if content_type != "application/json" or not response:
            return response
        try:
            return json.loads(response)
        except ValueError:
            raise RemoteError(502, "M9_INVALID_JSON_RESPONSE") from None

    def load_brief(self, identifier: str) -> dict[str, Any]:
        if not UUID.fullmatch(identifier):
            raise ValueError("M9_BRIEF_ID_INVALID")
        fields = "id,candidate_id,version,slides_json,hooks_json,caption_draft,cta,generated_at,created_at,evidence_snapshot"
        result = self.request("GET", "/rest/v1/creative_briefs?select=" + fields + "&id=eq." + identifier + "&limit=1")
        if not isinstance(result, list) or len(result) != 1:
            raise ValueError("M9_BRIEF_NOT_FOUND")
        return result[0]

    def claim(self, key: str, brief_id: str, media: dict[str, Any]) -> None:
        try:
            self.request("POST", "/rest/v1/m9_preview_jobs", {
                "job_key": key, "creative_brief_id": brief_id,
                "status": "CLAIMED", "media_manifest": media,
            }, schema="app_private", headers={"prefer": "return=minimal"})
        except RemoteError as exc:
            if exc.status == 409:
                raise ValueError("M9_JOB_ALREADY_CLAIMED_NO_RETRY") from None
            raise

    def transition(self, key: str, previous: str, next_status: str, patch: dict[str, Any] | None = None) -> None:
        query = "?job_key=eq." + urllib.parse.quote(key, safe="") + "&status=eq." + previous
        result = self.request("PATCH", "/rest/v1/m9_preview_jobs" + query,
            {"status": next_status, **(patch or {})},
            schema="app_private", headers={"prefer": "return=representation"})
        if not isinstance(result, list) or len(result) != 1:
            raise RuntimeError("M9_STATE_TRANSITION_CONFLICT")

    def upload_png(self, object_path: str, data: bytes) -> None:
        if not re.fullmatch(r"previews/[a-f0-9-]+/slide_0[12]\.png", object_path):
            raise ValueError("M9_INVALID_STORAGE_PATH")
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > MAX_BYTES:
            raise ValueError("M9_INVALID_PNG")
        self.request("POST", "/storage/v1/object/" + BUCKET + "/" + object_path,
                     data, content_type="image/png", headers={"x-upsert": "false"})

    def signed_url(self, object_path: str) -> str:
        result = self.request("POST", "/storage/v1/object/sign/" + BUCKET + "/" + object_path,
                              {"expiresIn": 900})
        if not isinstance(result, dict):
            raise ValueError("M9_SIGN_RESPONSE_INVALID")
        signed = result.get("signedURL") or result.get("signedUrl")
        if not isinstance(signed, str):
            raise ValueError("M9_SIGN_RESPONSE_INVALID")
        if signed.startswith("https://"):
            uri = signed
        elif signed.startswith("/storage/v1/"):
            uri = self.base + signed
        elif signed.startswith("/object/sign/"):
            uri = self.base + "/storage/v1" + signed
        else:
            raise ValueError("M9_SIGN_RESPONSE_INVALID")
        parsed = urllib.parse.urlsplit(uri)
        if parsed.scheme != "https" or parsed.hostname != urllib.parse.urlsplit(self.base).hostname:
            raise ValueError("M9_SIGN_HOST_INVALID")
        return uri


class TelegramGateway:
    def __init__(self, token: str, http: Http):
        if not token:
            raise ValueError("M9_BOT_TOKEN_REQUIRED")
        self.token, self.http = token, http

    def send_album(self, chat_id: str, urls: list[str], caption: str) -> list[int]:
        if not re.fullmatch(r"-?\d+", str(chat_id)):
            raise ValueError("M9_CHAT_ID_INVALID")
        if not (2 <= len(urls) <= 10) or len(caption) > 1024:
            raise ValueError("M9_ALBUM_INVALID")
        media = [{"type": "photo", "media": url, **({"caption": caption} if i == 0 else {})}
                 for i, url in enumerate(urls)]
        endpoint = "https://api.telegram.org/bot" + self.token + "/sendMediaGroup"
        data = {"chat_id": chat_id, "media": media}
        body = self.http.request("POST", endpoint, {"content-type": "application/json"}, json_bytes(data))
        try:
            decoded = json.loads(body)
        except (ValueError, TypeError):
            raise RuntimeError("M9_TELEGRAM_AMBIGUOUS_RESPONSE") from None
        if decoded.get("ok") is not True or not isinstance(decoded.get("result"), list):
            raise RuntimeError("M9_TELEGRAM_REJECTED")
        ids = [x.get("message_id") for x in decoded["result"]]
        if len(ids) != len(urls) or any(type(i) is not int for i in ids):
            raise RuntimeError("M9_TELEGRAM_AMBIGUOUS_RESPONSE")
        return ids


def run_preview(brief: dict[str, Any], media: dict[str, Any], media_root: Path,
                output: Path, font_file: Path, logo: Path | None,
                gateway: SupabaseGateway | None, telegram: TelegramGateway | None,
                *, send: bool, chat_id: str | None = None, cta_file: Path | None = None) -> dict[str, Any]:
    checked_media(media, media_root)
    key = job_key(brief, media)
    payload = prepared_render_job(brief, media)
    workdir = media_root.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if gateway:
        gateway.claim(key, brief["id"], media)
    stage = "CLAIMED"
    try:
        manifest = render(payload, workdir, output, font_file, logo, cta_path=cta_file)
        files = [output / entry["file"] for entry in manifest["slides"] if entry["kind"] != "CTA"]
        if len(files) != 2:
            raise ValueError("M9_TWO_RENDERED_SLIDES_REQUIRED")
        state = {"job_key": key, "status": "RENDERED", "rendered": [str(x.name) for x in files],
                 "cta_reference": CTA_PATH, "review_only": True}
        if gateway:
            gateway.transition(key, stage, "RENDERED", {"rendered_manifest": manifest})
            stage = "RENDERED"
            unique_dir = str(uuid.uuid5(uuid.NAMESPACE_URL, key))
            paths = [f"previews/{unique_dir}/slide_0{i}.png" for i in (1, 2)]
            for path, file in zip(paths, files):
                gateway.upload_png(path, file.read_bytes())
            gateway.transition(key, stage, "UPLOADED")
            stage = "UPLOADED"
            state["paths"] = paths
            state["status"] = "UPLOADED"
            if send:
                if telegram is None or not chat_id:
                    raise ValueError("M9_TELEGRAM_CONFIG_REQUIRED")
                # Sign all THREE objects BEFORE claiming any Telegram dispatch.
                signed = [gateway.signed_url(x) for x in [*paths, CTA_PATH]]
                caption = "맨유 에디터 | 카드뉴스 검토용 미리보기\n" + (
                    str(brief.get("caption_draft") or "").strip()[:850]
                ) + "\n\n⚠️ 사진 사용권·디자인 검토 후 게시"
                gateway.transition(key, stage, "SENDING")
                stage = "SENDING"
                message_ids = telegram.send_album(chat_id, signed, caption)
                gateway.transition(key, stage, "SENT", {"telegram_message_ids": message_ids})
                stage = "SENT"
                state.update({"status": "SENT", "telegram_message_ids": message_ids})
        else:
            state["status"] = "LOCAL_PREVIEW_ONLY"
        (output / "delivery-state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        return state
    except Exception:
        if gateway:
            try:
                gateway.transition(key, stage, "SEND_UNCERTAIN" if stage == "SENDING" else "FAILED",
                                   {"error_category": "SEND_AMBIGUOUS" if stage == "SENDING" else "PREVIEW_PIPELINE_FAILED"})
            except Exception:
                pass  # Do not mask original, do not retry Telegram.
        raise


def main() -> None:
    cli = argparse.ArgumentParser()
    group = cli.add_mutually_exclusive_group(required=True)
    group.add_argument("--brief-json")
    group.add_argument("--brief-id")
    cli.add_argument("--media", required=True, help="Reviewed local cover/body image manifest")
    cli.add_argument("--out", required=True)
    cli.add_argument("--font", required=True)
    cli.add_argument("--logo")
    cli.add_argument("--cta", help="Optional existing CTA PNG for local 3-slide review; never uploaded again")
    cli.add_argument("--upload", action="store_true", help="Upload private PNGs to Supabase")
    cli.add_argument("--send-telegram", action="store_true", help="Send ONE private review album after upload")
    cli.add_argument("--chat-id", help="Owner-only Telegram chat ID")
    args = cli.parse_args()
    if args.send_telegram and (not args.upload or not args.chat_id):
        cli.error("--send-telegram requires --upload and --chat-id")
    if args.send_telegram and os.getenv("M9_ENABLE_TELEGRAM_PREVIEW") != "YES":
        cli.error("Set M9_ENABLE_TELEGRAM_PREVIEW=YES to allow one private preview send")
    if args.send_telegram and args.chat_id != os.getenv("TELEGRAM_OWNER_USER_ID"):
        cli.error("Only the configured Telegram owner private chat can receive M9 previews")
    http = Http()
    needs_remote = args.upload or args.brief_id
    service = SupabaseGateway(os.getenv("SUPABASE_URL", ""),
                              os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SECRET_KEY", ""),
                              http) if needs_remote else None
    brief = service.load_brief(args.brief_id) if args.brief_id else json.loads(Path(args.brief_json).read_text(encoding="utf-8"))
    media_path = Path(args.media).resolve()
    media = json.loads(media_path.read_text(encoding="utf-8"))
    result = run_preview(brief, media, media_path.parent, Path(args.out).resolve(),
                         Path(args.font).resolve(), Path(args.logo).resolve() if args.logo else None,
                         service if args.upload else None,
                         TelegramGateway(os.getenv("TELEGRAM_BOT_TOKEN", ""), http) if args.send_telegram else None,
                         send=args.send_telegram, chat_id=args.chat_id,
                         cta_file=Path(args.cta).resolve() if args.cta else None)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
