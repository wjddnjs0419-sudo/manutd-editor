#!/usr/bin/env python3
"""One bounded Google News resolver batch for GitHub Actions."""

from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlsplit

import requests

from scripts.gnews_decoder_poc import (
    MAX_BODY_EXPERIMENT_BYTES,
    fetch_article_page,
    is_google_news_article_url,
    run_decoder,
    validate_publisher_url,
)


MAX_BATCH_SIZE = 30
MAX_ARTICLE_EXCERPT_CHARS = 2_000
MAX_GLOBAL_COOLDOWN_SECONDS = 21_600
DEFAULT_GLOBAL_COOLDOWN_SECONDS = 900
MAX_WORKER_API_BODY_BYTES = 800_000
REQUEST_TIMEOUT_SECONDS = 20
GOOGLE_ARTICLE_ID = re.compile(r"^/rss/articles/([A-Za-z0-9_-]{1,2000})/?$")
RESOLVER_API_ERROR_CODES = {
    "METHOD_NOT_ALLOWED",
    "RESOLVER_DISABLED",
    "UNAUTHORIZED",
    "REQUEST_TOO_LARGE",
    "INVALID_REQUEST_BODY",
    "INVALID_REQUEST_ID",
    "INVALID_BATCH_SIZE",
    "INVALID_MODE",
    "INVALID_LEASE_ID",
    "INVALID_RESULTS",
    "INVALID_UNPROCESSED_IDS",
    "DUPLICATE_RESULT_ID",
    "INVALID_COOLDOWN",
    "INVALID_COOLDOWN_STATE",
    "INVALID_ACTION",
    "RATE_LIMITED",
    "LEASE_EXPIRED",
    "IDEMPOTENCY_CONFLICT",
    "LEASE_CONFLICT",
    "API_OPERATION_FAILED",
    "API_INVALID_RESPONSE",
    "API_UNAVAILABLE",
}


class ResolverApiError(RuntimeError):
    """A bounded API failure. The response body is intentionally not exposed."""


class ResolverApiClient:
    def __init__(
        self,
        api_url: str,
        worker_token: str,
        *,
        timeout_s: int = REQUEST_TIMEOUT_SECONDS,
        request: Callable[..., requests.Response] | None = None,
    ) -> None:
        try:
            parsed = urlsplit(api_url)
            port = parsed.port
            host = (parsed.hostname or "").lower()
        except ValueError as exc:
            raise ValueError("INVALID_RESOLVER_API_URL") from exc
        if (
            parsed.scheme != "https"
            or not host.endswith(".supabase.co")
            or host.count(".") < 2
            or port not in (None, 443)
            or parsed.username
            or parsed.password
            or parsed.path.rstrip("/") != "/functions/v1/gnews-resolver-api"
            or parsed.query
            or parsed.fragment
            or len(api_url) > 2_000
        ):
            raise ValueError("INVALID_RESOLVER_API_URL")
        if not worker_token or len(worker_token) > 512:
            raise ValueError("INVALID_RESOLVER_WORKER_TOKEN")
        self.api_url = api_url.rstrip("/")
        self.worker_token = worker_token
        self.timeout_s = max(1, min(60, int(timeout_s)))
        self.request = request or requests.post

    def _post(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) > MAX_WORKER_API_BODY_BYTES:
            raise ValueError("RESOLVER_API_REQUEST_TOO_LARGE")
        try:
            response = self.request(
                self.api_url,
                data=body,
                headers={
                    "authorization": f"Bearer {self.worker_token}",
                    "accept": "application/json",
                    "content-type": "application/json",
                },
                timeout=self.timeout_s,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise ResolverApiError("RESOLVER_API_NETWORK_ERROR") from exc
        if response.status_code == 429:
            raise ResolverApiError("RESOLVER_API_RATE_LIMITED")
        if not response.ok:
            error_code = None
            try:
                error_payload = response.json()
            except ValueError:
                error_payload = None
            if isinstance(error_payload, dict):
                candidate = error_payload.get("error")
                if isinstance(candidate, str) and candidate in RESOLVER_API_ERROR_CODES:
                    error_code = candidate
            category = (
                f"RESOLVER_API_REJECTED:{error_code}"
                if error_code
                else "RESOLVER_API_REJECTED"
            )
            raise ResolverApiError(category)
        try:
            value = response.json()
        except ValueError as exc:
            raise ResolverApiError("RESOLVER_API_INVALID_RESPONSE") from exc
        if not isinstance(value, dict):
            raise ResolverApiError("RESOLVER_API_INVALID_RESPONSE")
        return value

    def claim(
        self,
        request_id: str,
        batch_size: int = MAX_BATCH_SIZE,
        mode: str = "recent",
    ) -> dict[str, Any]:
        if not 1 <= batch_size <= MAX_BATCH_SIZE:
            raise ValueError("INVALID_BATCH_SIZE")
        if mode not in {"recent", "backfill"}:
            raise ValueError("INVALID_RESOLVER_MODE")
        return self._post({
            "action": "claim",
            "request_id": request_id,
            "batch_size": batch_size,
            "mode": mode,
        })

    def complete(
        self,
        request_id: str,
        lease_id: str,
        results: Sequence[Mapping[str, Any]],
        unprocessed_ids: Sequence[str],
        global_cooldown_seconds: int = 0,
    ) -> dict[str, Any]:
        if len(results) > MAX_BATCH_SIZE or len(unprocessed_ids) > MAX_BATCH_SIZE:
            raise ValueError("INVALID_BATCH_SIZE")
        cooldown = max(0, min(MAX_GLOBAL_COOLDOWN_SECONDS, int(global_cooldown_seconds)))
        return self._post({
            "action": "complete",
            "request_id": request_id,
            "lease_id": lease_id,
            "results": list(results),
            "unprocessed_ids": list(unprocessed_ids),
            "global_cooldown_seconds": cooldown,
        })


def _article_id(item: Mapping[str, Any]) -> str | None:
    article_id = item.get("google_article_id")
    if isinstance(article_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,2000}", article_id):
        return article_id
    url = item.get("original_google_news_url")
    if not isinstance(url, str) or not is_google_news_article_url(url):
        return None
    return GOOGLE_ARTICLE_ID.fullmatch(urlsplit(url).path).group(1)  # type: ignore[union-attr]


def _video_url(value: str) -> bool:
    host = (urlsplit(value).hostname or "").lower().rstrip(".")
    return host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com") or host == "youtube-nocookie.com" or host.endswith(".youtube-nocookie.com")


def _empty_result(item_id: str) -> dict[str, Any]:
    return {
        "id": item_id,
        "url_resolution_status": "FAILED",
        "resolved_publisher_url": None,
        "article_fetch_status": "NOT_ATTEMPTED",
        "article_extraction_status": "NOT_ATTEMPTED",
        "article_final_url": None,
        "article_content_excerpt": None,
        "safe_error_category": None,
    }


def _article_page_result(item_id: str, publisher_url: str, page: Mapping[str, Any]) -> dict[str, Any]:
    result = _empty_result(item_id)
    result.update({
        "url_resolution_status": "RESOLVED",
        "resolved_publisher_url": publisher_url,
        "article_final_url": validate_publisher_url(page.get("final_url")) or None,
    })
    status = page.get("status")
    http_status = page.get("http_status")
    if status == "ARTICLE_BODY_EXTRACTED" and page.get("body_extraction_success") is True:
        result.update({
            "article_fetch_status": "FETCHED",
            "article_extraction_status": "EXTRACTED",
            "article_content_excerpt": str(page.get("article_excerpt") or "")[:MAX_ARTICLE_EXCERPT_CHARS] or None,
        })
    elif status == "TITLE_NOT_RELEVANT":
        result.update({
            "article_fetch_status": "FETCHED",
            "article_extraction_status": "TITLE_NOT_RELEVANT",
            "safe_error_category": "TITLE_NOT_RELEVANT",
        })
    elif status == "HTTP_ACCESS_SUCCESS_BODY_NOT_EXTRACTED":
        result.update({
            "article_fetch_status": "FETCHED",
            "article_extraction_status": "EMPTY_BODY",
            "safe_error_category": "NO_ARTICLE_BODY",
        })
    elif status == "BODY_TOO_LARGE":
        result.update({
            "article_fetch_status": "BODY_TOO_LARGE",
            "safe_error_category": "PUBLISHER_BODY_TOO_LARGE",
        })
    elif status == "ACCESS_RESTRICTED_OR_PAYWALL":
        if http_status == 429:
            result.update({
                "article_fetch_status": "RATE_LIMITED",
                "safe_error_category": "PUBLISHER_HTTP_429",
            })
        else:
            result.update({
                "article_fetch_status": "ACCESS_RESTRICTED",
                "safe_error_category": "PUBLISHER_HTTP_403" if http_status == 403 else "PUBLISHER_PAYWALL",
            })
    elif status == "HTTP_ACCESS_SUCCESS_NON_HTML":
        result.update({
            "article_fetch_status": "UNSUPPORTED_CONTENT",
            "safe_error_category": "UNSUPPORTED_CONTENT_TYPE",
        })
    elif status in {"UNSAFE_REDIRECT", "REDIRECT_LIMIT", "REDIRECT_WITHOUT_LOCATION", "UNSAFE_URL", "UNSAFE_OR_UNRESOLVABLE_HOST"}:
        result.update({
            "article_fetch_status": "REDIRECT_REJECTED",
            "safe_error_category": "PUBLISHER_REDIRECT_REJECTED",
        })
    else:
        result.update({
            "article_fetch_status": "FAILED",
            "safe_error_category": "PUBLISHER_NETWORK_ERROR" if str(status).startswith("NETWORK_ERROR") else "PUBLISHER_HTTP_ERROR",
        })
    if isinstance(http_status, int) and http_status in {401, 402, 403, 407, 429, 451}:
        result["safe_error_category"] = f"PUBLISHER_HTTP_{http_status}"
    return result


def process_claimed_batch(
    claim: Mapping[str, Any],
    *,
    decoder: Callable[[Sequence[Mapping[str, Any]]], Mapping[str, Any]] = run_decoder,
    article_fetcher: Callable[..., Mapping[str, Any]] = fetch_article_page,
) -> dict[str, Any]:
    """Resolve and fetch one leased batch. One Google batch, two decoder requests max in flight."""
    raw_items = claim.get("items")
    if not isinstance(raw_items, list) or len(raw_items) > MAX_BATCH_SIZE:
        raise ValueError("INVALID_CLAIM_BATCH")

    unique_items: list[Mapping[str, Any]] = []
    aliases: dict[str, list[Mapping[str, Any]]] = {}
    results: list[dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        original_url = item.get("original_google_news_url")
        article_id = _article_id(item)
        if not isinstance(original_url, str) or not is_google_news_article_url(original_url) or not article_id:
            invalid = _empty_result(item["id"])
            invalid["safe_error_category"] = "INVALID_GOOGLE_NEWS_URL"
            results.append(invalid)
            continue
        if article_id in aliases:
            aliases[article_id].append(item)
            continue
        aliases[article_id] = []
        unique_items.append(item)

    records = [{
        "canonical_url": item["original_google_news_url"],
        "title": str(item.get("title") or "")[:500],
        "source_canonical_name": str(item.get("source_canonical_name") or "")[:160],
        "published_at": item.get("published_at"),
    } for item in unique_items]
    decoded: Mapping[str, Any] = {"articles": [], "fatal_error": None, "google_http_429_observed": False}
    if records:
        decoded = decoder(records)
    decoded_rows = decoded.get("articles") if isinstance(decoded, Mapping) else None
    resolution_by_url = {
        str(row.get("google_url")): row
        for row in decoded_rows or []
        if isinstance(row, Mapping) and isinstance(row.get("google_url"), str)
    }
    google_429 = decoded.get("google_http_429_observed") is True or decoded.get("fatal_error") == "GOOGLE_HTTP_429"
    cooldown = 0
    if google_429:
        try:
            cooldown = int(decoded.get("retry_after_seconds") or DEFAULT_GLOBAL_COOLDOWN_SECONDS)
        except (TypeError, ValueError):
            cooldown = DEFAULT_GLOBAL_COOLDOWN_SECONDS
        cooldown = max(60, min(MAX_GLOBAL_COOLDOWN_SECONDS, cooldown))

    stopped_for_publisher_429 = False
    resolved_by_article_id: dict[str, dict[str, Any]] = {}
    processed_ids = {row["id"] for row in results}
    unprocessed_ids: list[str] = []
    for item in unique_items:
        item_id = str(item["id"])
        original_url = str(item["original_google_news_url"])
        article_id = _article_id(item)
        row = resolution_by_url.get(original_url)
        if row is None:
            unprocessed_ids.append(item_id)
            continue
        if row.get("conversion_success") is not True:
            reason = str(row.get("failure_reason") or "")
            if reason == "NOT_ATTEMPTED_AFTER_GOOGLE_429":
                unprocessed_ids.append(item_id)
                continue
            result = _empty_result(item_id)
            if "429" in reason:
                result["url_resolution_status"] = "RATE_LIMITED"
                result["safe_error_category"] = "GOOGLE_HTTP_429"
                google_429 = True
                if cooldown == 0:
                    cooldown = DEFAULT_GLOBAL_COOLDOWN_SECONDS
            else:
                result["safe_error_category"] = "GOOGLE_DECODER_FAILURE"
            results.append(result)
            processed_ids.add(item_id)
            if article_id:
                resolved_by_article_id[article_id] = result
            continue

        publisher_url = validate_publisher_url(row.get("publisher_url"))
        if publisher_url is None:
            result = _empty_result(item_id)
            result["safe_error_category"] = "INVALID_PUBLISHER_URL"
            results.append(result)
            processed_ids.add(item_id)
            if article_id:
                resolved_by_article_id[article_id] = result
            continue
        if _video_url(publisher_url):
            result = _empty_result(item_id)
            result["url_resolution_status"] = "EXCLUDED"
            result["safe_error_category"] = "NON_ARTICLE_VIDEO"
            results.append(result)
            processed_ids.add(item_id)
            if article_id:
                resolved_by_article_id[article_id] = result
            continue

        if google_429:
            result = _empty_result(item_id)
            result.update({
                "url_resolution_status": "RESOLVED",
                "resolved_publisher_url": publisher_url,
                "safe_error_category": "GOOGLE_HTTP_429",
            })
        elif stopped_for_publisher_429:
            result = _empty_result(item_id)
            result.update({
                "url_resolution_status": "RESOLVED",
                "resolved_publisher_url": publisher_url,
            })
        else:
            title = str(item.get("title") or "")[:500]
            try:
                page = article_fetcher(
                    publisher_url,
                    expected_title=title,
                    max_bytes=MAX_BODY_EXPERIMENT_BYTES,
                    max_excerpt_chars=MAX_ARTICLE_EXCERPT_CHARS,
                )
                result = _article_page_result(item_id, publisher_url, page)
            except Exception:
                result = _empty_result(item_id)
                result.update({
                    "url_resolution_status": "RESOLVED",
                    "resolved_publisher_url": publisher_url,
                    "article_fetch_status": "FAILED",
                    "safe_error_category": "PUBLISHER_NETWORK_ERROR",
                })
            if result["article_fetch_status"] == "RATE_LIMITED":
                stopped_for_publisher_429 = True
                if cooldown == 0:
                    cooldown = DEFAULT_GLOBAL_COOLDOWN_SECONDS
        results.append(result)
        processed_ids.add(item_id)
        if article_id:
            resolved_by_article_id[article_id] = result

    # Defensive dedupe: if a bad claim repeats an article ID, reuse the first URL/body result.
    for article_id, duplicate_items in aliases.items():
        first_result = resolved_by_article_id.get(article_id)
        if first_result is None:
            continue
        for item in duplicate_items:
            duplicate = dict(first_result)
            duplicate["id"] = str(item["id"])
            results.append(duplicate)
            processed_ids.add(duplicate["id"])

    claimed_ids = [str(item["id"]) for item in raw_items if isinstance(item, dict) and isinstance(item.get("id"), str)]
    for item_id in claimed_ids:
        if item_id not in processed_ids and item_id not in unprocessed_ids:
            unprocessed_ids.append(item_id)
    return {
        "results": results,
        "unprocessed_ids": unprocessed_ids,
        "global_cooldown_seconds": cooldown,
        "google_http_429_observed": google_429,
    }


def run_once(
    api: ResolverApiClient,
    idempotency_key: str,
    *,
    batch_size: int = MAX_BATCH_SIZE,
    mode: str = "recent",
    decoder: Callable[[Sequence[Mapping[str, Any]]], Mapping[str, Any]] = run_decoder,
    article_fetcher: Callable[..., Mapping[str, Any]] = fetch_article_page,
) -> dict[str, Any]:
    if mode not in {"recent", "backfill"}:
        raise ValueError("INVALID_RESOLVER_MODE")
    claim = api.claim(f"{idempotency_key}:claim", batch_size, mode)
    items = claim.get("items")
    if not isinstance(items, list) or not items:
        return {"status": "NOOP", "claimed": 0, "processed": 0}
    lease_id = claim.get("lease_id") or claim.get("leaseId")
    if not isinstance(lease_id, str) or not lease_id:
        raise ResolverApiError("RESOLVER_API_INVALID_LEASE")
    batch = process_claimed_batch(
        claim,
        decoder=decoder,
        article_fetcher=article_fetcher,
    )
    response = api.complete(
        f"{idempotency_key}:complete",
        lease_id,
        batch["results"],
        batch["unprocessed_ids"],
        batch["global_cooldown_seconds"],
    )
    return {
        "status": "COMPLETED",
        "claimed": len(items),
        "processed": len(batch["results"]),
        "unprocessed": len(batch["unprocessed_ids"]),
        "google_http_429_observed": batch["google_http_429_observed"],
        "complete_status": response.get("status", "ACCEPTED"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--idempotency-key", required=True)
    parser.add_argument("--batch-size", type=int, default=MAX_BATCH_SIZE)
    parser.add_argument("--mode", choices=("recent", "backfill"), default="recent")
    args = parser.parse_args()
    if not 1 <= args.batch_size <= MAX_BATCH_SIZE:
        parser.error("--batch-size must be between 1 and 30")
    if os.environ.get("GNEWS_RESOLVER_ENABLED", "false").strip().lower() != "true":
        print(json.dumps({"status": "DISABLED"}))
        return 0
    api_url = os.environ.get("GNEWS_RESOLVER_API_URL", "")
    worker_token = os.environ.get("GNEWS_RESOLVER_WORKER_TOKEN", "")
    if not api_url or not worker_token:
        print(json.dumps({"status": "CONFIGURATION_ERROR"}))
        return 2
    try:
        result = run_once(
            ResolverApiClient(api_url, worker_token),
            args.idempotency_key,
            batch_size=args.batch_size,
            mode=args.mode,
        )
    except (ResolverApiError, ValueError) as exc:
        # Exceptions contain only fixed categories; tokens and URLs are never printed.
        print(json.dumps({"status": "FAILED", "error": str(exc)}))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
