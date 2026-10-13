#!/usr/bin/env python3
"""M9 private-review delivery worker.

1. Load an existing creative_briefs row (generation remains in M6/Creative Generation).
2. Render supplied, editorially selected real photo files via Pillow.
3. Claim a unique M9 job, upload every rendered PNG including CTA to private Storage,
   then verify each download SHA-256 and anonymous read denial.
4. On an explicit owner-only DRAFT review, send the original PNG bytes as an ordered
   Telegram document album and the copyable caption separately.

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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from m9_render_news_deck import render
from m9_content_policy import ordered_content_slides, validate_exploration_slide_count

BUCKET = "manutd-card-assets"
CTA_PATH = "assets/cta.png"
RENDER_JOB_REVISION = "render-v2"
RENDER_JOB_REVISION_CODE = 2
RENDER_JOB_RETRY_SLOTS = 3
MAX_BYTES = 12 * 1024 * 1024
MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024
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
    slides = ordered_content_slides(raw)
    if len(slides) < 2:
        raise ValueError("M9_BRIEF_REQUIRES_TWO_SLIDES")
    if len(slides) > 6:
        raise ValueError("M9_NEWS_SLIDE_LIMIT")
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
    page_rows = media.get("pages")
    if page_rows is not None:
        if not isinstance(page_rows, list):
            raise ValueError("M9_PAGE_MEDIA_INVALID")
        pages_by_number: dict[int, dict[str, Any]] = {}
        for info in page_rows:
            if not isinstance(info, dict) or not isinstance(info.get("slide_number"), int):
                raise ValueError("M9_PAGE_MEDIA_INVALID")
            number = info["slide_number"]
            if number < 1 or number > 6 or number in pages_by_number:
                raise ValueError("M9_PAGE_MEDIA_INVALID")
            pages_by_number[number] = info
        if 1 not in pages_by_number or 2 not in pages_by_number:
            raise ValueError("M9_PAGE_PHOTO_REQUIRED")
        media.setdefault("cover", pages_by_number[1])
        media.setdefault("body", pages_by_number[2])
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
    if isinstance(page_rows, list):
        for info in page_rows:
            if not isinstance(info, dict):
                raise ValueError("M9_PAGE_MEDIA_INVALID")
            photo_file = safe_local_file(media_root, info.get("file", ""))
            expected_sha = info.get("source_sha256")
            if expected_sha is not None and hashlib.sha256(photo_file.read_bytes()).hexdigest() != expected_sha:
                raise ValueError("M9_MEDIA_HASH_MISMATCH")
            if any(not isinstance(info.get(field), str) or not info[field].strip()
                   for field in ("source_url", "article_url", "credit")):
                raise ValueError("M9_PAGE_MEDIA_PROVENANCE_REQUIRED")
            if info.get("subject_metadata_checked") is not True:
                raise ValueError("M9_SUBJECT_METADATA_REVIEW_REQUIRED")
    return media


def prepared_render_job(brief: dict[str, Any], media: dict[str, Any]) -> dict[str, Any]:
    slides = brief_slides(brief)
    generation_metadata = brief.get("generation_metadata") if isinstance(brief.get("generation_metadata"), dict) else {}
    validate_exploration_slide_count(
        brief.get("status"), generation_metadata.get("generation_intent"),
        brief.get("content_mode"), len(slides),
    )
    first = slides[0]
    hooks = brief.get("hooks_json")
    hook = str(first.get("headline") or "").strip()
    hook_highlight = str(first.get("highlight") or "").strip()
    if hook_highlight:
        line_one, line_two = hook, hook_highlight
    else:
        selected_hook = hook
        if isinstance(hooks, list) and hooks and isinstance(hooks[0], dict):
            selected_hook = hooks[0].get("text") or hook
        line_one, line_two = split_hook(str(selected_hook))
    cover = media["cover"]
    body_media = media["body"]
    page_media = {
        str(page["slide_number"]): page
        for page in media.get("pages", [])
        if isinstance(page, dict) and isinstance(page.get("slide_number"), int)
    } if isinstance(media.get("pages"), list) else {}
    slide_contract = brief.get("slides_json") if isinstance(brief.get("slides_json"), dict) else {}
    snapshot = brief.get("evidence_snapshot") if isinstance(brief.get("evidence_snapshot"), dict) else {}
    if not snapshot and isinstance(slide_contract.get("evidence_snapshot"), dict):
        snapshot = slide_contract["evidence_snapshot"]
    article_records = snapshot.get("exploration_articles") if isinstance(snapshot.get("exploration_articles"), list) else []
    if not article_records:
        article_records = slide_contract.get("exploration_articles", [])
    published_at = next((row.get("published_at") for row in article_records if isinstance(row, dict) and isinstance(row.get("published_at"), str)), None)
    if not published_at:
        source_rows = snapshot.get("sources") if isinstance(snapshot.get("sources"), list) else slide_contract.get("sources", [])
        for row in source_rows if isinstance(source_rows, list) else []:
            if isinstance(row, dict) and isinstance(row.get("published_at"), str):
                published_at = row["published_at"]
                break
    body_slides = []
    page_photos = {"1": page_media.get("1", cover)}
    for slide_index, slide in enumerate(slides[1:], start=2):
        body_text = slide.get("body")
        if not isinstance(body_text, str) or not body_text.strip():
            raise ValueError("M9_BODY_TEXT_REQUIRED")
        body_headline = slide.get("headline")
        if not isinstance(body_headline, str) or not body_headline.strip():
            raise ValueError("M9_BODY_HEADLINE_REQUIRED")
        page_photo = page_media.get(str(slide_index), body_media)
        page_photos[str(slide_index)] = page_photo
        direction = slide.get("visual_direction") if isinstance(slide.get("visual_direction"), dict) else {}
        body_slides.append({
            "role": str(slide.get("role") or "BODY").strip().upper(),
            "source_index": slide.get("index", slide.get("slide_number", slide_index)),
            "slide_number": slide_index,
            "body_headline": body_headline.strip(),
            "body_paragraphs": _body_paragraphs(body_text),
            "body_highlight": slide.get("highlight") or "",
            "closing_line": slide.get("closing_line") or "",
            "stat_emphasis": direction.get("stat_emphasis") or "",
            "visual_direction": direction,
            "source_headline": body_headline,
            "source_body": body_text,
            "source_highlight": slide.get("highlight") or "",
            "photo": page_photo,
        })
    source_publisher, grounded_article_url = _grounded_article_source(brief, cover["article_url"])
    caption_question = _last_question(brief.get("caption_draft"))
    if body_slides and caption_question and not body_slides[-1]["closing_line"]:
        # Reuse a question already saved in the DRAFT caption; do not invent copy.
        body_slides[-1]["closing_line"] = caption_question
    prepared = {
        "article_url": grounded_article_url or cover["article_url"],
        "article_published_at": published_at or brief.get("generated_at") or brief.get("created_at") or "",
        "source_publisher": source_publisher,
        "eyebrow": media.get("eyebrow") or "■  NEWS  |  맨유 에디터",
        "cover_line_one": line_one,
        "cover_line_two": line_two,
        "cover_source_role": str(first.get("role") or "HOOK").strip().upper(),
        "cover_source_index": first.get("index", first.get("slide_number", 1)),
        "cover_source_headline": first.get("headline") or "",
        "cover_source_highlight": first.get("highlight") or "",
        "body_headline": body_slides[0]["body_headline"],
        "body_paragraphs": body_slides[0]["body_paragraphs"],
        "body_highlight": body_slides[0]["body_highlight"],
        "body_slides": body_slides,
        "cover_photo": cover["file"],
        "body_photo": body_media["file"],
        "cover_photo_credit": cover["credit"],
        "body_photo_credit": body_media["credit"],
        "cover_photo_source": cover["source_url"],
        "body_photo_source": body_media["source_url"],
        "cover_source_article_url": cover["article_url"],
        "body_source_article_url": body_media["article_url"],
        "page_photos": page_photos,
        "caption_draft": brief.get("caption_draft") if isinstance(brief.get("caption_draft"), str) else "",
        "content_mode": brief.get("content_mode"),
        "brief_status": brief.get("status"),
        "generation_intent": (brief.get("generation_metadata") or {}).get("generation_intent")
            if isinstance(brief.get("generation_metadata"), dict) else None,
        "photo_candidate_count": media.get("candidate_count"),
        "photo_shortage": media.get("photo_shortage"),
    }
    for role, source in (("cover", cover), ("body", body_media)):
        for field in ("crop", "faces", "quality", "analysis_ms", "review_required", "review_flags"):
            if field in source:
                prepared[f"{role}_{field}"] = source[field]
        for field in (f"{role}_focus_x", f"{role}_focus_y"):
            if field in source:
                prepared[field] = source[field]
            elif field in media:
                prepared[field] = media[field]
            elif field in brief:
                prepared[field] = brief[field]
    return prepared


def _body_paragraphs(body: str) -> list[str]:
    """Treat single newlines as soft wraps and reflow sentences as short units."""
    paragraphs: list[str] = []
    normalized_body = body.replace("\r\n", "\n").replace("\r", "\n")
    for block in re.split(r"\n\s*\n", normalized_body):
        normalized = re.sub(r"\s+", " ", block).strip()
        if not normalized:
            continue
        sentences = re.split(r"(?<=[.!?。！？])\s+", normalized)
        paragraphs.extend(sentence.strip() for sentence in sentences if sentence.strip())
    return paragraphs or [re.sub(r"\s+", " ", body).strip()]


def _last_question(caption: Any) -> str:
    if not isinstance(caption, str):
        return ""
    questions = re.findall(r"[^\n?？]*[?？]", caption)
    return questions[-1].strip() if questions else ""


def _grounded_article_source(brief: dict[str, Any], fallback_url: str) -> tuple[str, str]:
    """Resolve the article outlet from extracted evidence backing saved claims."""
    slide_contract = brief.get("slides_json") if isinstance(brief.get("slides_json"), dict) else {}
    snapshot = brief.get("evidence_snapshot") if isinstance(brief.get("evidence_snapshot"), dict) else {}
    if not snapshot and isinstance(slide_contract.get("evidence_snapshot"), dict):
        snapshot = slide_contract["evidence_snapshot"]
    articles = snapshot.get("exploration_articles")
    if not isinstance(articles, list):
        articles = slide_contract.get("exploration_articles", [])
    sources = snapshot.get("sources")
    if not isinstance(sources, list):
        sources = slide_contract.get("sources", [])

    evidence_order: list[str] = []
    grounding = brief.get("grounding_json")
    if isinstance(grounding, dict):
        claim_rows = grounding.get("claims", [])
        if isinstance(claim_rows, dict):
            claim_rows = list(claim_rows.values())
        if isinstance(claim_rows, list):
            for claim in claim_rows:
                if isinstance(claim, dict) and isinstance(claim.get("evidence_ids"), list):
                    evidence_order.extend(str(value) for value in claim["evidence_ids"] if value)
    if not evidence_order:
        for slide in brief_slides(brief):
            claims = slide.get("claims")
            if not isinstance(claims, list):
                continue
            for claim in claims:
                if isinstance(claim, dict) and isinstance(claim.get("evidence_ids"), list):
                    evidence_order.extend(str(value) for value in claim["evidence_ids"] if value)
    internal_grounding = slide_contract.get("internal_grounding")
    if not evidence_order and isinstance(internal_grounding, dict):
        ids = internal_grounding.get("evidence_ids")
        if isinstance(ids, list):
            evidence_order.extend(str(value) for value in ids if value)
    evidence_order = list(dict.fromkeys(evidence_order))
    evidence_ids = set(evidence_order)

    for evidence_id in evidence_order:
        for row in articles if isinstance(articles, list) else []:
            if not isinstance(row, dict) or str(row.get("evidence_id") or "") != evidence_id:
                continue
            if str(row.get("extraction_status") or "").upper() != "EXTRACTED":
                continue
            publisher = row.get("publisher_name") or row.get("canonical_name") or row.get("publisher")
            url = row.get("canonical_url") or row.get("url")
            if (isinstance(publisher, str) and publisher.strip() and
                    isinstance(url, str) and url.startswith("https://")):
                return publisher.strip(), url

    # Persisted contracts can contain only an evidence-linked source citation.
    for row in sources if isinstance(sources, list) else []:
        if not isinstance(row, dict):
            continue
        if evidence_ids and str(row.get("evidence_id") or "") not in evidence_ids:
            continue
        if row.get("verified") is False:
            continue
        label = (row.get("canonical_name") or row.get("publisher_name") or
                 row.get("publisher") or row.get("label"))
        url = row.get("canonical_url") or row.get("url")
        if isinstance(label, str) and label.strip():
            publisher = label.split(",", 1)[0].strip()
            return publisher, url if isinstance(url, str) and url.startswith("https://") else fallback_url

    from urllib.parse import urlsplit
    return (urlsplit(str(fallback_url)).hostname or "").removeprefix("www."), fallback_url


def validate_preview_status(brief: dict[str, Any], allow_draft_preview: bool = False) -> None:
    status = brief.get("status")
    if status is None:
        return  # Local legacy fixtures may omit database status.
    if status == "READY":
        return
    if status in ("DRAFT", "SELECTED"):
        if not allow_draft_preview:
            raise ValueError("M9_DRAFT_PREVIEW_REQUIRES_OPT_IN")
        metadata = brief.get("generation_metadata")
        if not isinstance(metadata, dict) or metadata.get("generation_intent") != "EXPLORATION":
            raise ValueError("M9_DRAFT_EXPLORATION_REQUIRED")
        return
    raise ValueError("M9_BRIEF_NOT_READY")


def job_key(brief: dict[str, Any], media: dict[str, Any]) -> str:
    brief_id = str(brief.get("id") or "")
    if not UUID.fullmatch(brief_id):
        raise ValueError("M9_CREATIVE_BRIEF_ID_REQUIRED")
    # The RPC contract accepts only m9:<uuid>:v<digits>. Pack renderer revision,
    # saved brief revision, and a reserved retry digit into that numeric slot.
    # This gives an intentional renderer update one fresh idempotency key while
    # rerunning the same renderer/brief pair still hits the duplicate guard.
    revision = brief.get("version")
    if not isinstance(revision, int) or revision < 1 or revision > 999_999_999:
        raise ValueError("M9_CREATIVE_BRIEF_VERSION_REQUIRED")
    numeric_key = f"{RENDER_JOB_REVISION_CODE:03d}{revision:09d}0"
    return f"m9:{brief_id}:v{numeric_key}"


def pre_send_retry_job_key(brief: dict[str, Any]) -> str:
    """Reserved one-time key for a fresh dispatch after a confirmed pre-send failure."""
    base_key = job_key(brief, {})
    prefix, suffix = base_key.rsplit(":v", 1)
    return f"{prefix}:v{int(suffix) + 1}"


def pre_send_retry_job_keys(brief: dict[str, Any]) -> list[str]:
    """Finite reserved keys for separately approved retries after proven pre-send failures."""
    base_key = job_key(brief, {})
    prefix, suffix = base_key.rsplit(":v", 1)
    first_retry = int(suffix) + 1
    return [f"{prefix}:v{first_retry + attempt}" for attempt in range(RENDER_JOB_RETRY_SLOTS)]


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
            timeout = 120 if url.endswith("/sendMediaGroup") and headers.get("content-type", "").startswith("multipart/form-data") else 25
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read(MAX_HTTP_RESPONSE_BYTES)
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

    def load_brief(self, identifier: str, allow_draft_preview: bool = False) -> dict[str, Any]:
        if not UUID.fullmatch(identifier):
            raise ValueError("M9_BRIEF_ID_INVALID")
        fields = "id,candidate_id,version,status,content_mode,generation_metadata,slides_json,hooks_json,caption_draft,cta,generated_at,created_at,evidence_snapshot,provider_calls,input_tokens,output_tokens,estimated_cost_usd,model_name"
        result = self.request("GET", "/rest/v1/creative_briefs?select=" + fields + "&id=eq." + identifier + "&limit=1")
        if not isinstance(result, list) or len(result) != 1:
            raise ValueError("M9_BRIEF_NOT_FOUND")
        brief = result[0]
        validate_preview_status(brief, allow_draft_preview)
        return brief

    def claim(self, key: str, brief_id: str, media: dict[str, Any]) -> None:
        try:
            result = self.request("POST", "/rest/v1/rpc/m9_claim_preview", {
                "p_job_key": key, "p_brief_id": brief_id, "p_media": media,
            })
        except RemoteError as exc:
            if exc.status == 409:
                raise ValueError("M9_JOB_ALREADY_CLAIMED_NO_RETRY") from None
            raise
        if result is not True:
            raise RuntimeError("M9_JOB_CLAIM_INVALID_RESPONSE")

    def get_preview(self, key: str) -> dict[str, Any] | None:
        result = self.request("POST", "/rest/v1/rpc/m9_get_preview",
                              {"p_job_key": key})
        if result is None:
            return None
        if not isinstance(result, dict):
            raise RuntimeError("M9_JOB_LOOKUP_INVALID_RESPONSE")
        return result

    def transition(self, key: str, previous: str, next_status: str, patch: dict[str, Any] | None = None) -> None:
        result = self.request("POST", "/rest/v1/rpc/m9_transition_preview", {
            "p_job_key": key,
            "p_previous": previous,
            "p_next": next_status,
            "p_patch": patch or {},
        })
        if result is not True:
            raise RuntimeError("M9_STATE_TRANSITION_CONFLICT")

    def ensure_private_bucket(self) -> None:
        result = self.request("GET", "/storage/v1/bucket/" + BUCKET)
        if not isinstance(result, dict) or result.get("public") is not False:
            raise ValueError("M9_STORAGE_BUCKET_NOT_PRIVATE")

    def upload_png(self, object_path: str, data: bytes) -> None:
        # Existing M9 content allows up to six news pages plus the fixed CTA.
        if not re.fullmatch(r"previews/[a-f0-9-]+/slide_0[1-7]\.png", object_path):
            raise ValueError("M9_INVALID_STORAGE_PATH")
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > MAX_BYTES:
            raise ValueError("M9_INVALID_PNG")
        self.request("POST", "/storage/v1/object/" + BUCKET + "/" + object_path,
                     data, content_type="image/png", headers={"x-upsert": "false"})

    def verify_uploaded_png(self, object_path: str, expected: bytes) -> str:
        downloaded = self.download_private_png(object_path)
        expected_sha = hashlib.sha256(expected).hexdigest()
        if not isinstance(downloaded, bytes) or hashlib.sha256(downloaded).hexdigest() != expected_sha:
            raise ValueError("M9_STORAGE_SHA256_MISMATCH")
        public_url = self.base + "/storage/v1/object/public/" + BUCKET + "/" + object_path
        try:
            public_body = self.http.request("GET", public_url, {"accept": "image/png"})
        except RemoteError as exc:
            if exc.status in (400, 401, 403, 404):
                return expected_sha
            raise ValueError("M9_STORAGE_PUBLIC_ACCESS_CHECK_FAILED") from None
        if public_body:
            raise ValueError("M9_STORAGE_PUBLIC_READ_ALLOWED")
        raise ValueError("M9_STORAGE_PUBLIC_ACCESS_CHECK_FAILED")

    def download_private_png(self, object_path: str) -> bytes:
        if not re.fullmatch(r"(?:previews/[a-f0-9-]+/slide_0[1-7]\.png|assets/cta\.png)", object_path):
            raise ValueError("M9_INVALID_STORAGE_PATH")
        data = self.request("GET", "/storage/v1/object/" + BUCKET + "/" + object_path,
                            content_type="image/png")
        if not isinstance(data, bytes) or not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > MAX_BYTES:
            raise ValueError("M9_INVALID_PNG")
        return data

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

    def send_text(self, chat_id: str, text: str) -> list[int]:
        if not re.fullmatch(r"-?\d+", str(chat_id)):
            raise ValueError("M9_CHAT_ID_INVALID")
        chunks = telegram_text_chunks(text)
        ids: list[int] = []
        endpoint = "https://api.telegram.org/bot" + self.token + "/sendMessage"
        for chunk in chunks:
            body = self.http.request("POST", endpoint, {"content-type": "application/json"},
                                     json_bytes({"chat_id": chat_id, "text": chunk}))
            try:
                decoded = json.loads(body)
            except (ValueError, TypeError):
                raise RuntimeError("M9_TELEGRAM_AMBIGUOUS_RESPONSE") from None
            result = decoded.get("result") if isinstance(decoded, dict) else None
            message_id = result.get("message_id") if isinstance(result, dict) else None
            if not isinstance(decoded, dict) or decoded.get("ok") is not True or type(message_id) is not int:
                raise RuntimeError("M9_TELEGRAM_REJECTED")
            ids.append(message_id)
        return ids

    def send_png_documents(self, chat_id: str, documents: list[tuple[str, bytes]]) -> list[int]:
        """Upload PNGs as an ordered document album so Telegram preserves original bytes."""
        if not re.fullmatch(r"-?\d+", str(chat_id)):
            raise ValueError("M9_CHAT_ID_INVALID")
        if not 2 <= len(documents) <= 10 or sum(len(data) for _, data in documents) > 50 * 1024 * 1024:
            raise ValueError("M9_DOCUMENT_ALBUM_INVALID")
        media = []
        for index, (name, data) in enumerate(documents, start=1):
            if not re.fullmatch(r"slide_0[1-7]\.png", name) or not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > MAX_BYTES:
                raise ValueError("M9_DOCUMENT_ALBUM_INVALID")
            media.append({"type": "document", "media": f"attach://document{index}"})
        boundary = "----M9Upload" + uuid.uuid4().hex
        chunks = [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}\r\n".encode(),
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"media\"\r\n\r\n".encode(),
            json_bytes(media) + b"\r\n",
        ]
        for index, (name, data) in enumerate(documents, start=1):
            chunks.extend([
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"document{index}\"; filename=\"{name}\"\r\nContent-Type: image/png\r\n\r\n".encode(),
                data,
                b"\r\n",
            ])
        chunks.append(f"--{boundary}--\r\n".encode())
        endpoint = "https://api.telegram.org/bot" + self.token + "/sendMediaGroup"
        body = self.http.request("POST", endpoint,
                                 {"content-type": "multipart/form-data; boundary=" + boundary},
                                 b"".join(chunks))
        try:
            decoded = json.loads(body)
        except (ValueError, TypeError):
            raise RuntimeError("M9_TELEGRAM_AMBIGUOUS_RESPONSE") from None
        result = decoded.get("result") if isinstance(decoded, dict) else None
        ids = [row.get("message_id") for row in result] if isinstance(result, list) else []
        if not isinstance(decoded, dict) or decoded.get("ok") is not True or len(ids) != len(documents) or any(type(value) is not int for value in ids):
            raise RuntimeError("M9_TELEGRAM_AMBIGUOUS_RESPONSE")
        return ids


def telegram_text_chunks(text: str, limit: int = 4096) -> list[str]:
    if not isinstance(text, str) or not text.strip() or limit < 1:
        raise ValueError("M9_TELEGRAM_TEXT_INVALID")
    remaining = text.strip()
    chunks: list[str] = []
    while len(remaining.encode("utf-16-le")) // 2 > limit:
        split_at = 0
        units = 0
        for index, char in enumerate(remaining):
            char_units = 2 if ord(char) > 0xFFFF else 1
            if units + char_units > limit:
                break
            units += char_units
            split_at = index + 1
        newline = remaining.rfind("\n", max(0, split_at // 2), split_at)
        space = remaining.rfind(" ", max(0, split_at // 2), split_at)
        boundary = max(newline, space)
        if boundary >= 0:
            split_at = boundary + 1
        chunk = remaining[:split_at]
        if not chunk:
            raise ValueError("M9_TELEGRAM_TEXT_INVALID")
        chunks.append(chunk)
        remaining = remaining[split_at:]
    if remaining:
        chunks.append(remaining)
    return chunks


def preview_caption(brief: dict[str, Any], media: dict[str, Any] | None = None) -> str:
    caption = brief.get("caption_draft")
    if not isinstance(caption, str) or not caption.strip():
        raise ValueError("M9_CAPTION_REQUIRED")
    cta = brief.get("cta")
    if isinstance(cta, str) and cta.strip() and cta.strip() not in caption:
        caption = caption.rstrip() + "\n\n" + cta.strip()
    snapshot = brief.get("evidence_snapshot") if isinstance(brief.get("evidence_snapshot"), dict) else {}
    source_urls: list[str] = []
    photo_rows = media.get("pages") if isinstance(media, dict) else None
    if not isinstance(photo_rows, list):
        photo_rows = [media.get("cover"), media.get("body")] if isinstance(media, dict) else []
    if isinstance(media, dict):
        for row in photo_rows:
            value = row.get("article_url") if isinstance(row, dict) else None
            if isinstance(value, str) and value.startswith("https://") and value not in source_urls:
                source_urls.append(value)
    if not source_urls:
        for collection in (snapshot.get("exploration_articles"), snapshot.get("sources")):
            if not isinstance(collection, list):
                continue
            row = next((item for item in collection if isinstance(item, dict)), {})
            value = row.get("canonical_url") or row.get("resolved_publisher_url")
            if isinstance(value, str) and value.startswith("https://"):
                source_urls.append(value)
                break
    for source_url in source_urls:
        if source_url not in caption:
            caption = caption.rstrip() + "\n\n원문: " + source_url
    credits = list(dict.fromkeys(
        row["credit"].strip() for row in photo_rows
        if isinstance(row, dict) and isinstance(row.get("credit"), str) and row["credit"].strip()
    ))
    missing_credits = [credit for credit in credits if credit not in caption]
    if missing_credits:
        caption = caption.rstrip() + "\n\n사진 크레딧: " + " / ".join(missing_credits)
    return "📋 Instagram 캡션 (복사)\n\n" + caption.strip()


def safe_failure_category(error: BaseException) -> str:
    """Persist only a stable, redacted M9 error code, never remote error text."""
    code = str(error).splitlines()[0].split(":", 1)[0].strip() if str(error) else ""
    if not re.fullmatch(r"M9_[A-Z0-9_]+", code):
        return "PREVIEW_PIPELINE_FAILED"
    return code.removeprefix("M9_")


def storage_manifest(brief: dict[str, Any], media: dict[str, Any], rendered: dict[str, Any],
                     paths: list[str], hashes: list[str], job_id: str,
                     *, status: str) -> dict[str, Any]:
    snapshot = brief.get("evidence_snapshot") if isinstance(brief.get("evidence_snapshot"), dict) else {}
    story = snapshot.get("story") if isinstance(snapshot.get("story"), dict) else {}
    articles = snapshot.get("exploration_articles") if isinstance(snapshot.get("exploration_articles"), list) else []
    sources = snapshot.get("sources") if isinstance(snapshot.get("sources"), list) else []
    article = next((row for row in articles if isinstance(row, dict) and row.get("canonical_url")), {})
    source = next((row for row in sources if isinstance(row, dict) and row.get("canonical_url")), {})
    pages = media.get("pages") if isinstance(media.get("pages"), list) else [media.get("cover"), media.get("body")]
    credits = [row.get("credit") for row in pages if isinstance(row, dict) and isinstance(row.get("credit"), str)]
    review_flags = {flag for row in pages if isinstance(row, dict)
                           for flag in (row.get("review_flags") if isinstance(row.get("review_flags"), list) else [])
                           if isinstance(flag, str)}
    if any(isinstance(row, dict) and row.get("rights_status") != "VERIFIED" for row in pages):
        review_flags.add("PHOTO_RIGHTS_UNVERIFIED")
    summary = rendered.get("photo_summary") if isinstance(rendered.get("photo_summary"), dict) else {}
    if summary.get("reused_page_count", 0) > 0:
        review_flags.add("PHOTO_REUSE_REVIEW")
    if summary.get("photo_shortage"):
        review_flags.add("PHOTO_SHORTAGE")
    entries = rendered.get("slides") if isinstance(rendered.get("slides"), list) else []
    slide_rows = []
    for order, (path, digest) in enumerate(zip(paths, hashes), start=1):
        render_row = entries[order - 1] if order <= len(entries) and isinstance(entries[order - 1], dict) else {}
        slide_rows.append({"slide_order": order, "image_path": path, "sha256": digest,
                           "kind": render_row.get("kind", "NEWS")})
    return {
        "job_id": job_id,
        "brief_id": brief.get("id"),
        "story_cluster_id": story.get("id"),
        "content_mode": brief.get("content_mode"),
        "status": status,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "slide_count": len(paths),
        "slides": slide_rows,
        "image_paths": paths,
        "caption": preview_caption(brief, media),
        "source_url": article.get("canonical_url") or source.get("canonical_url") or media.get("cover", {}).get("article_url"),
        "source_publisher": article.get("publisher_name") or source.get("canonical_name"),
        "photo_credits": credits,
        "render_manifest": rendered,
        "review_flags": sorted(review_flags),
        "provider_usage": {key: brief.get(key) for key in
                            ("provider_calls", "input_tokens", "output_tokens", "estimated_cost_usd", "model_name")},
    }


def run_preview(brief: dict[str, Any], media: dict[str, Any], media_root: Path,
                output: Path, font_file: Path, logo: Path | None,
                gateway: SupabaseGateway | None, telegram: TelegramGateway | None,
                *, send: bool, chat_id: str | None = None, cta_file: Path | None = None,
                body_font_file: Path | None = None, allow_draft_preview: bool = False,
                allow_draft_telegram_send: bool = False,
                job_already_claimed: bool = False,
                job_key_override: str | None = None) -> dict[str, Any]:
    if job_already_claimed and gateway is None:
        raise ValueError("M9_JOB_CLAIM_REMOTE_REQUIRED")
    if job_key_override is not None and not job_already_claimed:
        raise ValueError("M9_JOB_KEY_REQUIRES_CLAIM")
    validate_preview_status(brief, allow_draft_preview)
    if brief.get("status") in ("DRAFT", "SELECTED") and send and not allow_draft_telegram_send:
        raise ValueError("M9_DRAFT_TELEGRAM_SEND_REQUIRES_OWNER_OPT_IN")
    checked_media(media, media_root)
    key = job_key(brief, media)
    if job_key_override is not None:
        if job_key_override not in (key, *pre_send_retry_job_keys(brief)):
            raise ValueError("M9_JOB_KEY_INVALID")
        key = job_key_override
    payload = prepared_render_job(brief, media)
    workdir = media_root.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if gateway:
        gateway.ensure_private_bucket()
        if job_already_claimed:
            claimed = gateway.get_preview(key)
            if not isinstance(claimed, dict) or claimed.get("status") != "CLAIMED" or \
                    claimed.get("creative_brief_id") != brief.get("id"):
                raise ValueError("M9_JOB_CLAIM_NOT_ACTIVE")
        else:
            gateway.claim(key, brief["id"], media)
    stage = "CLAIMED"
    try:
        manifest = render(payload, workdir, output, font_file, logo, cta_path=cta_file, body_font_path=body_font_file)
        all_files = [output / entry["file"] for entry in manifest["slides"]]
        files = [output / entry["file"] for entry in manifest["slides"] if entry["kind"] != "CTA"]
        expected_news_slides = 1 + len(payload.get("body_slides", [])) if payload.get("body_slides") else 2
        if len(files) != expected_news_slides or len(all_files) != expected_news_slides + 1 or manifest["slides"][-1].get("kind") != "CTA":
            raise ValueError("M9_NEWS_SLIDE_COUNT_MISMATCH")
        state = {"job_key": key, "status": "RENDERED", "rendered": [str(x.name) for x in files],
                 "cta_reference": CTA_PATH, "review_only": True}
        if gateway:
            claimed = gateway.get_preview(key) or {}
            job_id = claimed.get("id")
            if not isinstance(job_id, str) or not UUID.fullmatch(job_id):
                raise ValueError("M9_JOB_ID_MISSING")
            gateway.transition(key, stage, "RENDERED", {"rendered_manifest": manifest})
            stage = "RENDERED"
            unique_dir = str(uuid.uuid5(uuid.NAMESPACE_URL, key))
            paths = [f"previews/{unique_dir}/slide_0{i}.png" for i in range(1, len(all_files) + 1)]
            hashes: list[str] = []
            for path, file in zip(paths, all_files):
                data = file.read_bytes()
                gateway.upload_png(path, data)
                hashes.append(gateway.verify_uploaded_png(path, data))
            full_manifest = storage_manifest(brief, media, manifest, paths, hashes, job_id, status="UPLOADED")
            gateway.transition(key, stage, "UPLOADED", {"rendered_manifest": full_manifest})
            stage = "UPLOADED"
            state["paths"] = paths
            state["status"] = "UPLOADED"
            if send:
                if telegram is None or not chat_id:
                    raise ValueError("M9_TELEGRAM_CONFIG_REQUIRED")
                caption = preview_caption(brief, media)
                try:
                    telegram.send_text(chat_id, "🔒 비공개 Storage 업로드와 PNG SHA-256 검증을 마쳤습니다. 이제 전체 카드뉴스와 캡션을 전달합니다.")
                except Exception:
                    pass  # Status is best-effort; the idempotent deck send remains the authoritative operation.
                gateway.transition(key, stage, "SENDING")
                stage = "SENDING"
                image_ids = telegram.send_png_documents(
                    chat_id, [(f"slide_{index:02d}.png", file.read_bytes())
                              for index, file in enumerate(all_files, start=1)]
                )
                caption_ids = telegram.send_text(chat_id, caption)
                message_ids = image_ids + caption_ids
                sent_manifest = {**full_manifest, "status": "SENT"}
                gateway.transition(key, stage, "SENT", {
                    "telegram_message_ids": message_ids,
                    "rendered_manifest": sent_manifest,
                })
                stage = "SENT"
                state.update({"status": "SENT", "telegram_message_ids": message_ids})
        else:
            state["status"] = "LOCAL_PREVIEW_ONLY"
        (output / "delivery-state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        return state
    except Exception as exc:
        if gateway:
            try:
                gateway.transition(key, stage, "SEND_UNCERTAIN" if stage == "SENDING" else "FAILED",
                                   {"error_category": "SEND_AMBIGUOUS" if stage == "SENDING" else safe_failure_category(exc)})
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
    cli.add_argument("--body-font")
    cli.add_argument("--allow-draft-preview", action="store_true", help="Explicitly allow an Exploration DRAFT/SELECTED brief for private owner review")
    cli.add_argument("--logo")
    cli.add_argument("--cta", help="Optional existing CTA PNG for local 3-slide review; never uploaded again")
    cli.add_argument("--upload", action="store_true", help="Upload private PNGs to Supabase")
    cli.add_argument("--job-already-claimed", action="store_true", help="Continue a brief job claimed before cloud photo collection")
    cli.add_argument("--job-key", help="Exact previously claimed M9 job key for internal pipeline continuation")
    cli.add_argument("--send-telegram", action="store_true", help="Send ONE private review album after upload")
    cli.add_argument("--chat-id", help="Owner-only Telegram chat ID")
    args = cli.parse_args()
    if args.job_already_claimed and (not args.upload or not args.brief_id):
        cli.error("--job-already-claimed requires --upload and --brief-id")
    if args.job_key and not args.job_already_claimed:
        cli.error("--job-key requires --job-already-claimed")
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
    brief = service.load_brief(args.brief_id, args.allow_draft_preview) if args.brief_id else json.loads(Path(args.brief_json).read_text(encoding="utf-8"))
    validate_preview_status(brief, args.allow_draft_preview)
    media_path = Path(args.media).resolve()
    media = json.loads(media_path.read_text(encoding="utf-8"))
    result = run_preview(brief, media, media_path.parent, Path(args.out).resolve(),
                         Path(args.font).resolve(), Path(args.logo).resolve() if args.logo else None,
                         service if args.upload else None,
                         TelegramGateway(os.getenv("TELEGRAM_BOT_TOKEN", ""), http) if args.send_telegram else None,
                         send=args.send_telegram, chat_id=args.chat_id,
                         cta_file=Path(args.cta).resolve() if args.cta else None,
                         body_font_file=Path(args.body_font).resolve() if args.body_font else None,
                         allow_draft_preview=args.allow_draft_preview,
                         allow_draft_telegram_send=(args.send_telegram and
                             os.getenv("M9_ENABLE_TELEGRAM_PREVIEW") == "YES" and
                             args.chat_id == os.getenv("TELEGRAM_OWNER_USER_ID")),
                         job_already_claimed=args.job_already_claimed,
                         job_key_override=args.job_key)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
