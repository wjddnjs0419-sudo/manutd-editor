#!/usr/bin/env python3
"""Bounded, read-only PoC for resolving Google News URLs and checking article HTML."""

from __future__ import annotations

import argparse
import http.client
from html.parser import HTMLParser
import ipaddress
import json
import re
import ssl
import socket
import threading
import time
from datetime import datetime
from html import unescape
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit

import requests
from gnews_decoder import CONSENT_COOKIE, DecodeError, __version__, decode_many


GOOGLE_HOST = "news.google.com"
GOOGLE_ARTICLE_PATH = re.compile(r"^/rss/articles/[A-Za-z0-9_-]{1,2000}/?$")
GOOGLE_RPC_PATH = "/_/DotsSplashUi/data/batchexecute"
MAX_ARTICLE_BODY_BYTES = 200_000
MAX_BODY_EXPERIMENT_BYTES = 800_000
BODY_EXPERIMENT_LIMITS = (200_000, 500_000, 800_000)
MAX_ARTICLE_REDIRECTS = 3
GOOGLE_TIMEOUT_SECONDS = 8.0
PUBLISHER_TIMEOUT_SECONDS = 8.0
NOISE_HTML = re.compile(
    r"<(script|style|nav|footer|header|aside)\b[^>]*>[\s\S]*?</\1>",
    re.IGNORECASE,
)
PARAGRAPH_HTML = re.compile(r"<p\b[^>]*>([\s\S]*?)</p>", re.IGNORECASE)
HTML_TAG = re.compile(r"<[^>]+>")
RESTRICTED_HTTP_STATUSES = {401, 402, 403, 407, 429, 451}
NOISE_TAGS = {
    "aside", "button", "footer", "form", "header", "iframe", "nav",
    "noscript", "script", "style", "svg",
}
NOISE_MARKER = re.compile(
    r"(?:^|[\s_-])(?:ad|ads|advert|advertisement|promo|promoted|related|"
    r"recommend(?:ation|ations|ed)?|also-read|popular|trending|menu|navigation|"
    r"sidebar|social|newsletter|cookie|consent)(?:$|[\s_-])",
    re.IGNORECASE,
)
TITLE_STOPWORDS = {
    "about", "after", "against", "amid", "among", "another", "before",
    "being", "could", "from", "have", "into", "just", "latest", "more",
    "news", "over", "paper", "report", "reports", "said", "says", "some",
    "sports", "than", "that", "their", "there", "these", "they", "this",
    "those", "through", "times", "today", "transfer", "transfers", "under",
    "what", "when", "where", "which", "while", "with", "would", "yahoo",
    "football", "live", "united", "manchester", "man", "utd", "team",
    "club", "premier", "league", "match", "hotspur", "goal", "sky",
}
VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}


class GoogleRateLimitStop(RuntimeError):
    """A Google request returned 429; do not issue more requests in this run."""


class GoogleRunStopped(RuntimeError):
    """A prior Google 429 stopped queued requests before they reached the network."""


def is_google_news_article_url(value: str) -> bool:
    try:
        url = urlsplit(value)
        port = url.port
    except (TypeError, ValueError):
        return False
    return (
        url.scheme == "https"
        and url.hostname == GOOGLE_HOST
        and url.username is None
        and url.password is None
        and port in (None, 443)
        and GOOGLE_ARTICLE_PATH.fullmatch(url.path) is not None
    )


def dedupe_records(records: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Keep the first record for each valid Google News RSS article URL."""
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for record in records:
        url = record.get("canonical_url")
        if not isinstance(url, str) or not is_google_news_article_url(url):
            continue
        if url in seen:
            continue
        seen.add(url)
        result.append(dict(record))
    return result


def validate_publisher_url(value: object) -> str | None:
    """Return a canonical HTTPS publisher URL, excluding Google and local hosts."""
    if not isinstance(value, str) or not value or len(value) > 2_000:
        return None
    try:
        url = urlsplit(value)
        host = (url.hostname or "").lower().rstrip(".")
        port = url.port
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
        try:
            url = urlsplit(value)
            host = (url.hostname or "").lower().rstrip(".")
            port = url.port
        except ValueError:
            return None
    if (
        url.scheme != "https"
        or not host
        or "." not in host
        or url.username is not None
        or url.password is not None
        or port not in (None, 443)
        or address is not None
        or host == "localhost"
        or host.endswith((".localhost", ".local", ".internal", ".invalid", ".test"))
        or host == "google.com"
        or host.endswith(".google.com")
        or host.startswith(("google.", "www.google."))
        or host.startswith("news.google.")
    ):
        return None
    return urlunsplit((url.scheme, url.netloc, url.path, url.query, ""))


def classify_conversion(
    original_url: str,
    resolved_url: object,
    failure_reason: str | None = None,
) -> dict[str, Any]:
    if not is_google_news_article_url(original_url):
        return {
            "success": False,
            "publisher_url": None,
            "final_domain": None,
            "failure_reason": "INVALID_GOOGLE_NEWS_URL",
        }
    publisher_url = validate_publisher_url(resolved_url)
    if publisher_url is None:
        return {
            "success": False,
            "publisher_url": None,
            "final_domain": None,
            "failure_reason": failure_reason or (
                "UNRESOLVED_BY_DECODER"
                if resolved_url is None
                else "NOT_VALID_HTTPS_PUBLISHER_URL"
            ),
        }
    return {
        "success": True,
        "publisher_url": publisher_url,
        "final_domain": urlsplit(publisher_url).hostname,
        "failure_reason": None,
    }


def extract_article_excerpt(html: str, max_chars: int = 600) -> str | None:
    if not isinstance(html, str) or max_chars < 1:
        return None
    without_noise = NOISE_HTML.sub(" ", html)
    paragraphs = []
    for raw_paragraph in PARAGRAPH_HTML.findall(without_noise):
        text = unescape(HTML_TAG.sub(" ", raw_paragraph))
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) >= 40:
            paragraphs.append(text)
    paragraphs = list(dict.fromkeys(paragraphs))
    if not paragraphs:
        return None
    text = " ".join(paragraphs)
    if len(text) <= max_chars:
        return text
    boundary = text.rfind(" ", 0, max_chars + 1)
    return f"{text[:boundary if boundary > 0 else max_chars].strip()}…"


class _ArticleContentParser(HTMLParser):
    """Collect paragraphs from article/main and exclude common page furniture."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool, str]] = []
        self.paragraphs: list[tuple[str, str]] = []
        self.paragraph_parts: list[str] | None = None
        self.paragraph_container = "document"
        self.excluded_blocks = 0

    def _parent_state(self) -> tuple[bool, str]:
        if not self.stack:
            return False, "document"
        _tag, blocked, container = self.stack[-1]
        return blocked, container

    @staticmethod
    def _is_noise(tag: str, attrs: Mapping[str, str | None]) -> bool:
        role = (attrs.get("role") or "").strip().lower()
        if tag in NOISE_TAGS or role in {
            "navigation", "contentinfo", "complementary", "advertisement",
        }:
            return True
        if (attrs.get("aria-hidden") or "").strip().lower() == "true":
            return True
        markers = " ".join(
            str(attrs.get(key) or "")
            for key in ("class", "id", "data-testid", "data-component")
        )
        return NOISE_MARKER.search(markers) is not None

    def _finish_paragraph(self) -> None:
        if self.paragraph_parts is None:
            return
        text = re.sub(r"\s+", " ", " ".join(self.paragraph_parts)).strip()
        if len(text) >= 40:
            self.paragraphs.append((text, self.paragraph_container))
        self.paragraph_parts = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "p" and self.paragraph_parts is not None:
            self._finish_paragraph()
        attr_map = {key.lower(): value for key, value in attrs}
        parent_blocked, parent_container = self._parent_state()
        own_noise = self._is_noise(tag, attr_map)
        blocked = parent_blocked or own_noise
        if own_noise and not parent_blocked:
            self.excluded_blocks += 1
        if tag == "article" and not blocked:
            container = "article"
        elif tag == "main" and parent_container != "article" and not blocked:
            container = "main"
        else:
            container = parent_container
        if tag not in VOID_TAGS:
            self.stack.append((tag, blocked, container))
        if tag == "p" and not blocked:
            self.paragraph_parts = []
            self.paragraph_container = container

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self.paragraph_parts is None:
            return
        if self.stack and self.stack[-1][1]:
            return
        self.paragraph_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "p":
            self._finish_paragraph()
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break


def extract_article_content(
    html: str,
    max_chars: int = 6_000,
    expected_title: str | None = None,
) -> dict[str, Any]:
    """Prefer article/main paragraphs and filter common menus, ads and related links."""
    if not isinstance(html, str) or max_chars < 1:
        return {
            "excerpt": None,
            "container": None,
            "paragraph_count": 0,
            "excluded_blocks": 0,
            "rejection_reason": None,
        }
    parser = _ArticleContentParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        pass
    article = [text for text, container in parser.paragraphs if container == "article"]
    main = [text for text, container in parser.paragraphs if container == "main"]
    document = [text for text, _container in parser.paragraphs]
    chosen = article or main or document
    container = "article" if article else "main" if main else "document"
    unique = list(dict.fromkeys(chosen))
    if not unique:
        excerpt = None
    else:
        text = " ".join(unique)
        if len(text) <= max_chars:
            excerpt = text
        else:
            boundary = text.rfind(" ", 0, max_chars + 1)
            excerpt = f"{text[:boundary if boundary > 0 else max_chars].strip()}…"
    rejection_reason = None
    if excerpt is not None and expected_title:
        title_terms = {
            token
            for token in re.findall(r"[\w]+", expected_title.lower())
            if len(token) >= 4 and token not in TITLE_STOPWORDS
        }
        body_terms = set(re.findall(r"[\w]+", " ".join(unique).lower()))
        if title_terms:
            overlap = title_terms & body_terms
            if not overlap or len(overlap) / len(title_terms) < 0.1:
                excerpt = None
                rejection_reason = "TITLE_NOT_RELEVANT"
    return {
        "excerpt": excerpt,
        "container": container if excerpt is not None else None,
        "paragraph_count": len(unique),
        "excluded_blocks": parser.excluded_blocks,
        "rejection_reason": rejection_reason,
    }


def _public_addresses(
    host: str,
    dns_resolver: Callable[..., list[tuple[Any, ...]]] | None = None,
) -> list[str] | None:
    resolver = dns_resolver or socket.getaddrinfo
    try:
        answers = resolver(host, 443, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(answer[4][0] for answer in answers))
        if not addresses or any(
            not ipaddress.ip_address(address).is_global for address in addresses
        ):
            return None
        return addresses
    except (OSError, ValueError, IndexError, TypeError):
        return None


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to a previously checked IP while keeping TLS SNI on the hostname."""

    def __init__(self, hostname: str, address: str, timeout_s: float) -> None:
        super().__init__(
            host=hostname,
            port=443,
            timeout=timeout_s,
            context=ssl.create_default_context(),
        )
        self.pinned_address = address

    def connect(self) -> None:
        raw_socket = socket.create_connection(
            (self.pinned_address, self.port),
            self.timeout,
            self.source_address,
        )
        self.sock = self._context.wrap_socket(
            raw_socket,
            server_hostname=self.host,
        )


def _pinned_https_get(
    url: str,
    address: str,
    timeout_s: float,
    max_bytes: int,
) -> tuple[int, dict[str, str], bytes]:
    parsed = urlsplit(url)
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    connection = _PinnedHTTPSConnection(parsed.hostname or "", address, timeout_s)
    try:
        connection.request(
            "GET",
            target,
            headers={
                "accept": "text/html,application/xhtml+xml",
                "accept-encoding": "identity",
                "user-agent": "ManUtdEditor-GNewsDecoder-PoC/1.0",
            },
        )
        response = connection.getresponse()
        headers = {key.lower(): value for key, value in response.getheaders()}
        content_type = headers.get("content-type", "").lower()
        content_length = headers.get("content-length")
        declared_too_large = False
        try:
            declared_too_large = content_length is not None and int(content_length) > max_bytes
        except ValueError:
            pass
        is_html = content_type.startswith(("text/html", "application/xhtml+xml"))
        body = (
            response.read(max_bytes + 1)
            if response.status == 200 and is_html and not declared_too_large
            else b""
        )
        return response.status, headers, body
    finally:
        connection.close()


def fetch_article_page(
    publisher_url: str,
    *,
    timeout_s: float = PUBLISHER_TIMEOUT_SECONDS,
    max_bytes: int = MAX_ARTICLE_BODY_BYTES,
    max_redirects: int = MAX_ARTICLE_REDIRECTS,
    capture_body: bool = False,
    dns_resolver: Callable[..., list[tuple[Any, ...]]] | None = None,
    request_impl: Callable[
        [str, str, float, int], tuple[int, dict[str, str], bytes]
    ] | None = None,
) -> dict[str, Any]:
    """Fetch one public HTTPS publisher page with explicit, checked redirects."""
    started = time.perf_counter()
    current_url = validate_publisher_url(publisher_url)
    max_bytes = max(1, min(MAX_BODY_EXPERIMENT_BYTES, int(max_bytes)))
    observed_content_length: int | None = None
    observed_bytes = 0
    observed_content_type: str | None = None
    captured_body = b""

    def result(
        status: str,
        *,
        http_status: int | None = None,
        final_url: str | None = None,
        excerpt: str | None = None,
        http_success: bool = False,
    ) -> dict[str, Any]:
        value = {
            "status": status,
            "http_status": http_status,
            "final_url": final_url,
            "http_access_success": http_success,
            "body_extraction_success": excerpt is not None,
            "article_excerpt": excerpt,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "content_length_bytes": observed_content_length,
            "bytes_received": observed_bytes,
            "content_type": observed_content_type,
        }
        if capture_body:
            value["_body_bytes"] = captured_body
        return value

    if current_url is None:
        return result("UNSAFE_URL")

    get_page = request_impl or _pinned_https_get
    for redirect_count in range(max_redirects + 1):
        parsed = urlsplit(current_url)
        addresses = _public_addresses(parsed.hostname or "", dns_resolver)
        if not addresses:
            return result("UNSAFE_OR_UNRESOLVABLE_HOST", final_url=current_url)
        try:
            status_code, headers, body = get_page(
                current_url,
                addresses[0],
                timeout_s,
                max_bytes,
            )
        except (OSError, ssl.SSLError, http.client.HTTPException, TimeoutError) as exc:
            return result(
                f"NETWORK_ERROR_{type(exc).__name__.upper()}",
                final_url=current_url,
            )

        observed_content_length = None
        try:
            raw_content_length = headers.get("content-length")
            if raw_content_length is not None:
                observed_content_length = max(0, int(raw_content_length))
        except ValueError:
            pass
        observed_content_type = headers.get("content-type", "").lower() or None
        observed_bytes = len(body)
        captured_body = body

        if 300 <= status_code < 400:
            location = headers.get("location")
            if not location:
                return result(
                    "REDIRECT_WITHOUT_LOCATION",
                    http_status=status_code,
                    final_url=current_url,
                )
            if redirect_count >= max_redirects:
                return result(
                    "REDIRECT_LIMIT",
                    http_status=status_code,
                    final_url=current_url,
                )
            redirected = validate_publisher_url(urljoin(current_url, location))
            if redirected is None:
                return result(
                    "UNSAFE_REDIRECT",
                    http_status=status_code,
                    final_url=current_url,
                )
            current_url = redirected
            continue

        if status_code in RESTRICTED_HTTP_STATUSES:
            return result(
                "ACCESS_RESTRICTED_OR_PAYWALL",
                http_status=status_code,
                final_url=current_url,
            )
        if status_code != 200:
            return result(
                f"HTTP_ERROR_{status_code}",
                http_status=status_code,
                final_url=current_url,
            )

        content_type = headers.get("content-type", "").lower()
        if not (
            content_type.startswith("text/html")
            or content_type.startswith("application/xhtml+xml")
        ):
            return result(
                "HTTP_ACCESS_SUCCESS_NON_HTML",
                http_status=status_code,
                final_url=current_url,
                http_success=True,
            )
        indicated_length = headers.get("content-length")
        try:
            if indicated_length and int(indicated_length) > max_bytes:
                return result(
                    "BODY_TOO_LARGE",
                    http_status=status_code,
                    final_url=current_url,
                    http_success=True,
                )
        except ValueError:
            pass
        if len(body) > max_bytes:
            return result(
                "BODY_TOO_LARGE",
                http_status=status_code,
                final_url=current_url,
                http_success=True,
            )
        charset = re.search(r"charset=([A-Za-z0-9._-]+)", content_type)
        encoding = charset.group(1) if charset else "utf-8"
        html = body.decode(encoding, errors="replace")
        excerpt = extract_article_excerpt(html, max_chars=6_000)
        if excerpt is None:
            return result(
                "HTTP_ACCESS_SUCCESS_BODY_NOT_EXTRACTED",
                http_status=status_code,
                final_url=current_url,
                http_success=True,
            )
        return result(
            "ARTICLE_BODY_EXTRACTED",
            http_status=status_code,
            final_url=current_url,
            excerpt=excerpt,
            http_success=True,
        )
    return result("REDIRECT_LIMIT", final_url=current_url)


class GuardedGoogleSession(requests.Session):
    """Allow Google News calls and at most one explicit same-origin article redirect."""

    def __init__(self) -> None:
        super().__init__()
        self.rate_limited = threading.Event()
        self.request_metrics: list[dict[str, Any]] = []
        self._metrics_lock = threading.Lock()
        self.headers.update({"accept-language": "en-US,en;q=0.9"})
        self.cookies.set("SOCS", CONSENT_COOKIE, domain=".google.com")

    @staticmethod
    def _allowed_request(method: str, url: str) -> bool:
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except (TypeError, ValueError):
            return False
        if (
            parsed.scheme != "https"
            or parsed.hostname != GOOGLE_HOST
            or parsed.username is not None
            or parsed.password is not None
            or port not in (None, 443)
        ):
            return False
        if method.upper() == "GET":
            return GOOGLE_ARTICLE_PATH.fullmatch(parsed.path) is not None
        return method.upper() == "POST" and parsed.path == GOOGLE_RPC_PATH

    def _request_once(
        self,
        method: str,
        url: str,
        kwargs: Mapping[str, Any],
        article_origin_url: str | None,
    ) -> requests.Response:
        if self.rate_limited.is_set():
            raise GoogleRunStopped("A previous Google request returned HTTP 429")
        started = time.perf_counter()
        request_kwargs = dict(kwargs)
        request_kwargs["allow_redirects"] = False
        response = super().request(method, url, **request_kwargs)
        redirect_host = None
        redirect_path = None
        redirect_query_keys: list[str] = []
        if 300 <= response.status_code < 400:
            location = response.headers.get("location")
            if location:
                target = urlsplit(urljoin(url, location))
                redirect_host = target.hostname
                redirect_path = target.path
                redirect_query_keys = sorted(
                    {key for key, _value in parse_qsl(target.query, keep_blank_values=True)}
                )
        metric = {
            "method": method.upper(),
            "url": url,
            "article_origin_url": article_origin_url,
            "status": response.status_code,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "retry_after": response.headers.get("retry-after"),
            "redirect_host": redirect_host,
            "redirect_path": redirect_path,
            "redirect_query_keys": redirect_query_keys,
        }
        with self._metrics_lock:
            self.request_metrics.append(metric)
        if response.status_code == 429:
            self.rate_limited.set()
            response.close()
            raise GoogleRateLimitStop("Google News returned HTTP 429")
        return response

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        if self.rate_limited.is_set():
            raise GoogleRunStopped("A previous Google request returned HTTP 429")
        if not self._allowed_request(method, url):
            raise ValueError("Blocked non-Google-News URL or unexpected request path")
        article_origin_url = url if method.upper() == "GET" else None
        response = self._request_once(method, url, kwargs, article_origin_url)
        if method.upper() != "GET" or not 300 <= response.status_code < 400:
            return response

        location = response.headers.get("location")
        if not location:
            response.close()
            return response
        redirected_url = urljoin(url, location)
        current = urlsplit(url)
        redirected = urlsplit(redirected_url)
        same_origin = (
            redirected.scheme == current.scheme == "https"
            and redirected.hostname == current.hostname == GOOGLE_HOST
            and redirected.port in (None, 443)
        )
        if not same_origin or not self._allowed_request("GET", redirected_url):
            response.close()
            return response

        response.close()
        redirected_response = self._request_once(
            "GET",
            redirected_url,
            kwargs,
            article_origin_url,
        )
        if 300 <= redirected_response.status_code < 400:
            redirected_response.close()
        return redirected_response


def _google_failure_reason(
    original_url: str,
    request_metrics: Sequence[Mapping[str, Any]],
    fatal_error: str | None,
) -> str:
    article_requests = [
        item
        for item in request_metrics
        if item.get("method") == "GET"
        and (
            item.get("article_origin_url") == original_url
            or item.get("url") == original_url
        )
    ]
    if any(item.get("status") == 429 for item in article_requests):
        return "GOOGLE_HTTP_429"
    rpc_metrics = [
        item for item in request_metrics if item.get("method") == "POST"
    ]
    if any(item.get("status") == 429 for item in rpc_metrics):
        return "GOOGLE_BATCH_RPC_HTTP_429"
    if not article_requests and fatal_error == "GOOGLE_HTTP_429":
        return "NOT_ATTEMPTED_AFTER_GOOGLE_429"
    if article_requests:
        status = article_requests[-1].get("status")
        if isinstance(status, int) and 300 <= status < 400:
            return "GOOGLE_REDIRECT_NOT_FOLLOWED"
        if isinstance(status, int) and status != 200:
            return f"GOOGLE_HTTP_STATUS_{status}"
        if status == 200:
            return "SIGNATURE_OR_BATCH_RETURNED_NO_PUBLISHER_URL"
    if fatal_error:
        return fatal_error
    return "UNRESOLVED_BY_DECODER"


def run_decoder(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    unique_records = dedupe_records(records)
    urls = [str(record["canonical_url"]) for record in unique_records]
    session = GuardedGoogleSession()
    started = time.perf_counter()
    fatal_error: str | None = None
    decoded: Mapping[str, str | None] = {}
    try:
        decoded = decode_many(
            urls,
            concurrency=2,
            timeout=GOOGLE_TIMEOUT_SECONDS,
            session=session,
        )
    except GoogleRateLimitStop:
        fatal_error = "GOOGLE_HTTP_429"
    except GoogleRunStopped:
        fatal_error = "GOOGLE_HTTP_429"
    except DecodeError as exc:
        fatal_error = f"GOOGLE_BATCH_DECODE_ERROR_{type(exc).__name__.upper()}"
    except Exception as exc:
        fatal_error = f"DECODER_ERROR_{type(exc).__name__.upper()}"
    finally:
        batch_elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        metrics = list(session.request_metrics)
        session.close()

    request_by_url: dict[str, list[Mapping[str, Any]]] = {}
    for metric in metrics:
        if metric.get("method") == "GET":
            article_origin_url = metric.get("article_origin_url") or metric.get("url")
            request_by_url.setdefault(str(article_origin_url), []).append(metric)

    article_results: list[dict[str, Any]] = []
    for record in unique_records:
        original_url = str(record["canonical_url"])
        candidate = decoded.get(original_url)
        conversion = classify_conversion(
            original_url,
            candidate,
            _google_failure_reason(original_url, metrics, fatal_error)
            if candidate is None
            else None,
        )
        article_metrics = request_by_url.get(original_url, [])
        article_results.append(
            {
                "title": str(record.get("title") or ""),
                "source": str(record.get("source_canonical_name") or ""),
                "published_at": record.get("published_at"),
                "google_url": original_url,
                "conversion_success": conversion["success"],
                "publisher_url": conversion["publisher_url"],
                "final_domain": conversion["final_domain"],
                "resolution_elapsed_ms": (
                    round(
                        sum(float(metric.get("elapsed_ms") or 0) for metric in article_metrics),
                        2,
                    )
                    if article_metrics
                    else None
                ),
                "google_http_status": (
                    article_metrics[-1].get("status") if article_metrics else None
                ),
                "failure_reason": conversion["failure_reason"],
                "body_status": "NOT_RUN_URL_CONVERSION_FAILED",
                "article_http_status": None,
                "article_http_access_success": False,
                "article_body_extraction_success": False,
                "article_final_url": None,
                "article_excerpt": None,
                "article_fetch_elapsed_ms": None,
            }
        )

    success_count = sum(item["conversion_success"] for item in article_results)
    get_metrics = [item for item in metrics if item.get("method") == "GET"]
    rpc_metrics = [item for item in metrics if item.get("method") == "POST"]
    return {
        "decoder_version": __version__,
        "selected_article_count": len(records),
        "unique_valid_article_count": len(unique_records),
        "conversion_success_count": success_count,
        "conversion_success_rate_pct": round(
            success_count * 100 / len(unique_records), 2
        )
        if unique_records
        else 0.0,
        "batch_elapsed_ms": batch_elapsed_ms,
        "amortized_elapsed_ms_per_article": round(
            batch_elapsed_ms / len(unique_records), 2
        )
        if unique_records
        else 0.0,
        "average_google_signature_get_ms": round(
            sum(float(item["elapsed_ms"]) for item in get_metrics)
            / len(get_metrics),
            2,
        )
        if get_metrics
        else None,
        "batch_rpc_elapsed_ms": (
            rpc_metrics[-1].get("elapsed_ms") if rpc_metrics else None
        ),
        "google_http_429_observed": any(item.get("status") == 429 for item in metrics),
        "request_count": len(metrics),
        "request_metrics": metrics,
        "fatal_error": fatal_error,
        "articles": article_results,
    }


def run_body_checks(
    run: dict[str, Any],
    *,
    body_limit: int = 10,
    dns_resolver: Callable[..., list[tuple[Any, ...]]] | None = None,
    request_impl: Callable[
        [str, str, float, int], tuple[int, dict[str, str], bytes]
    ] | None = None,
) -> None:
    candidates = [
        item for item in run["articles"] if item["conversion_success"]
    ][: max(0, min(10, body_limit))]
    run["body_test_limit"] = max(0, min(10, body_limit))
    run["body_test_count"] = len(candidates)
    rate_limited = False
    for item in candidates:
        if rate_limited:
            item["body_status"] = "NOT_ATTEMPTED_AFTER_PUBLISHER_429"
            continue
        page = fetch_article_page(
            str(item["publisher_url"]),
            dns_resolver=dns_resolver,
            request_impl=request_impl,
        )
        item["body_status"] = page["status"]
        item["article_http_status"] = page["http_status"]
        item["article_http_access_success"] = page["http_access_success"]
        item["article_body_extraction_success"] = page[
            "body_extraction_success"
        ]
        item["article_final_url"] = page["final_url"]
        item["article_excerpt"] = page["article_excerpt"]
        item["article_fetch_elapsed_ms"] = page["elapsed_ms"]
        rate_limited = page["http_status"] == 429


def run_body_limit_experiment(
    articles: Sequence[Mapping[str, Any]],
    *,
    body_limit: int = 10,
    byte_limits: Sequence[int] = BODY_EXPERIMENT_LIMITS,
    dns_resolver: Callable[..., list[tuple[Any, ...]]] | None = None,
    request_impl: Callable[
        [str, str, float, int], tuple[int, dict[str, str], bytes]
    ] | None = None,
) -> dict[str, Any]:
    """Fetch each page once, bounded at 800 KB, then compare smaller caps in memory."""
    bounded_limit = max(0, min(10, int(body_limit)))
    normalized_limits = tuple(
        sorted(
            {
                max(1, min(MAX_BODY_EXPERIMENT_BYTES, int(value)))
                for value in byte_limits
            }
        )
    )
    seen: set[str] = set()
    candidates: list[Mapping[str, Any]] = []
    for article in articles:
        publisher_url = validate_publisher_url(article.get("publisher_url"))
        if not article.get("conversion_success", True) or publisher_url is None:
            continue
        if publisher_url in seen:
            continue
        seen.add(publisher_url)
        candidates.append(article)
        if len(candidates) >= bounded_limit:
            break

    result: dict[str, Any] = {
        "body_test_limit": bounded_limit,
        "body_test_count": len(candidates),
        "fetch_limit_bytes": MAX_BODY_EXPERIMENT_BYTES,
        "byte_limits": list(normalized_limits),
        "http_request_count": 0,
        "publisher_http_429_observed": False,
        "articles": [],
    }
    stopped_by_429 = False
    for article in candidates:
        base = {
            "title": str(article.get("title") or ""),
            "google_url": article.get("google_url"),
            "publisher_url": article.get("publisher_url"),
        }
        if stopped_by_429:
            result["articles"].append({
                **base,
                "fetch_status": "NOT_ATTEMPTED_AFTER_PUBLISHER_429",
                "http_status": None,
                "content_length_bytes": None,
                "bytes_received": 0,
                "elapsed_ms": None,
                "limits": [
                    {
                        "limit_bytes": limit,
                        "existing_status": "NOT_ATTEMPTED_AFTER_PUBLISHER_429",
                        "existing_extraction_success": False,
                        "improved_status": "NOT_ATTEMPTED_AFTER_PUBLISHER_429",
                        "improved_extraction_success": False,
                    }
                    for limit in normalized_limits
                ],
            })
            continue

        page = fetch_article_page(
            str(article["publisher_url"]),
            max_bytes=MAX_BODY_EXPERIMENT_BYTES,
            capture_body=True,
            dns_resolver=dns_resolver,
            request_impl=request_impl,
        )
        result["http_request_count"] += 1
        body = page.pop("_body_bytes", b"")
        content_type = str(page.get("content_type") or "")
        restricted = page.get("status") == "ACCESS_RESTRICTED_OR_PAYWALL"
        non_html = page.get("status") == "HTTP_ACCESS_SUCCESS_NON_HTML"
        http_status = page.get("http_status")
        charset = re.search(r"charset=([A-Za-z0-9._-]+)", content_type)
        encoding = charset.group(1) if charset else "utf-8"
        html = body.decode(encoding, errors="replace") if body else ""
        page_too_large = page.get("status") == "BODY_TOO_LARGE"
        scenarios: list[dict[str, Any]] = []
        for limit in normalized_limits:
            if restricted:
                existing_status = improved_status = "ACCESS_RESTRICTED_OR_PAYWALL"
                existing = None
                improved = {"excerpt": None, "container": None, "paragraph_count": 0, "excluded_blocks": 0}
            elif non_html:
                existing_status = improved_status = "HTTP_ACCESS_SUCCESS_NON_HTML"
                existing = None
                improved = {"excerpt": None, "container": None, "paragraph_count": 0, "excluded_blocks": 0}
            elif http_status != 200:
                existing_status = improved_status = str(page.get("status") or "HTTP_ERROR")
                existing = None
                improved = {"excerpt": None, "container": None, "paragraph_count": 0, "excluded_blocks": 0}
            elif (
                page_too_large
                or int(page.get("content_length_bytes") or 0) > limit
                or int(page.get("bytes_received") or 0) > limit
            ):
                existing_status = improved_status = "BODY_TOO_LARGE"
                existing = None
                improved = {"excerpt": None, "container": None, "paragraph_count": 0, "excluded_blocks": 0}
            else:
                existing = extract_article_excerpt(html, max_chars=6_000)
                improved = extract_article_content(
                    html,
                    max_chars=6_000,
                    expected_title=str(article.get("title") or "") or None,
                )
                existing_status = (
                    "ARTICLE_BODY_EXTRACTED"
                    if existing is not None
                    else "HTTP_ACCESS_SUCCESS_BODY_NOT_EXTRACTED"
                )
                improved_status = (
                    "ARTICLE_BODY_EXTRACTED"
                    if improved["excerpt"] is not None
                    else "HTTP_ACCESS_SUCCESS_BODY_NOT_EXTRACTED"
                )
            scenarios.append(
                {
                    "limit_bytes": limit,
                    "existing_status": existing_status,
                    "existing_extraction_success": existing is not None,
                    "existing_excerpt_chars": len(existing) if existing else 0,
                    "existing_excerpt_preview": existing[:500] if existing else None,
                    "improved_status": improved_status,
                    "improved_extraction_success": improved["excerpt"] is not None,
                    "improved_rejection_reason": improved.get("rejection_reason"),
                    "improved_excerpt_chars": len(improved["excerpt"] or ""),
                    "improved_excerpt_preview": (
                        improved["excerpt"][:500] if improved["excerpt"] else None
                    ),
                    "improved_container": improved["container"],
                    "improved_paragraph_count": improved["paragraph_count"],
                    "noise_blocks_excluded": improved["excluded_blocks"],
                }
            )
        result["articles"].append(
            {
                **base,
                "fetch_status": page.get("status"),
                "http_status": http_status,
                "content_length_bytes": page.get("content_length_bytes"),
                "bytes_received": page.get("bytes_received"),
                "content_type": content_type or None,
                "final_url": page.get("final_url"),
                "elapsed_ms": page.get("elapsed_ms"),
                "limits": scenarios,
            }
        )
        stopped_by_429 = http_status == 429
        if stopped_by_429:
            result["publisher_http_429_observed"] = True
    return result


def load_records(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("Input JSON must be a list of observation records")
    if not all(isinstance(item, dict) for item in data):
        raise ValueError("Every observation record must be a JSON object")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("scripts/fixtures/gnews-decoder-input.json"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/tmp/manutd-gnews-decoder-poc-results.json"),
    )
    parser.add_argument("--body-limit", type=int, default=10)
    parser.add_argument("--skip-body", action="store_true")
    args = parser.parse_args()

    records = load_records(args.input)
    run = run_decoder(records)
    if not args.skip_body:
        run_body_checks(run, body_limit=args.body_limit)
    run["tested_at"] = datetime.now().astimezone().isoformat()
    run["input_file"] = str(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(run, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "selected": run["selected_article_count"],
                "unique_valid": run["unique_valid_article_count"],
                "conversion_success": run["conversion_success_count"],
                "conversion_success_rate_pct": run[
                    "conversion_success_rate_pct"
                ],
                "batch_elapsed_ms": run["batch_elapsed_ms"],
                "request_count": run["request_count"],
                "google_http_429_observed": run["google_http_429_observed"],
                "body_test_count": run.get("body_test_count", 0),
                "body_extraction_success_count": sum(
                    item["article_body_extraction_success"]
                    for item in run["articles"]
                ),
                "fatal_error": run["fatal_error"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
