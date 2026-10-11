import unittest
import json

import requests

from scripts.gnews_resolver_worker import (
    ResolverApiClient,
    ResolverApiError,
    process_claimed_batch,
    run_once,
)


GOOGLE_URL = "https://news.google.com/rss/articles/CBMi-test-id"
PUBLISHER_URL = "https://www.bbc.com/sport/football/test-story"


def claim_item(item_id="obs-1", title="Manchester United team update"):
    return {
        "id": item_id,
        "google_article_id": "CBMi-test-id",
        "original_google_news_url": GOOGLE_URL,
        "title": title,
        "published_at": "2026-10-12T08:00:00Z",
    }


class GNewsResolverWorkerTests(unittest.TestCase):
    def test_api_client_rejects_non_supabase_or_unexpected_api_urls(self):
        for url in (
            "https://attacker.example/functions/v1/gnews-resolver-api",
            "https://example.supabase.co/rest/v1/anything",
            "http://example.supabase.co/functions/v1/gnews-resolver-api",
            "https://example.supabase.co:8443/functions/v1/gnews-resolver-api",
        ):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "INVALID_RESOLVER_API_URL"):
                ResolverApiClient(url, "worker-token")

    def test_resolved_url_and_article_extraction_are_separate_results(self):
        article_fetches = []

        def decoder(records):
            self.assertEqual(records[0]["canonical_url"], GOOGLE_URL)
            return {
                "fatal_error": None,
                "google_http_429_observed": False,
                "articles": [{
                    "google_url": GOOGLE_URL,
                    "conversion_success": True,
                    "publisher_url": PUBLISHER_URL,
                    "failure_reason": None,
                }],
            }

        def fetch_article(url, *, expected_title, max_bytes, max_excerpt_chars):
            article_fetches.append((url, expected_title, max_bytes, max_excerpt_chars))
            return {
                "status": "ARTICLE_BODY_EXTRACTED",
                "http_status": 200,
                "http_access_success": True,
                "body_extraction_success": True,
                "article_excerpt": "Manchester United confirmed the squad update.",
            }

        result = process_claimed_batch(
            {"lease_id": "lease-1", "items": [claim_item()]},
            decoder=decoder,
            article_fetcher=fetch_article,
        )

        row = result["results"][0]
        self.assertEqual(row["url_resolution_status"], "RESOLVED")
        self.assertEqual(row["resolved_publisher_url"], PUBLISHER_URL)
        self.assertEqual(row["article_fetch_status"], "FETCHED")
        self.assertEqual(row["article_extraction_status"], "EXTRACTED")
        self.assertEqual(row["article_content_excerpt"], "Manchester United confirmed the squad update.")
        self.assertEqual(article_fetches, [(PUBLISHER_URL, "Manchester United team update", 800_000, 2_000)])

    def test_youtube_resolution_is_excluded_before_publisher_fetch(self):
        fetches = []

        def decoder(_records):
            return {
                "fatal_error": None,
                "google_http_429_observed": False,
                "articles": [{
                    "google_url": GOOGLE_URL,
                    "conversion_success": True,
                    "publisher_url": "https://youtu.be/video-id",
                    "failure_reason": None,
                }],
            }

        result = process_claimed_batch(
            {"lease_id": "lease-2", "items": [claim_item()]},
            decoder=decoder,
            article_fetcher=lambda *args, **kwargs: fetches.append((args, kwargs)),
        )

        row = result["results"][0]
        self.assertEqual(row["url_resolution_status"], "EXCLUDED")
        self.assertEqual(row["safe_error_category"], "NON_ARTICLE_VIDEO")
        self.assertEqual(row["resolved_publisher_url"], None)
        self.assertEqual(fetches, [])

    def test_google_429_sets_global_cooldown_and_leaves_unstarted_claims_unprocessed(self):
        items = [
            {
                **claim_item(f"obs-{index}"),
                "google_article_id": f"article-{index}",
                "original_google_news_url": f"https://news.google.com/rss/articles/article-{index}",
            }
            for index in range(3)
        ]

        def decoder(_records):
            return {
                "fatal_error": "GOOGLE_HTTP_429",
                "google_http_429_observed": True,
                "retry_after_seconds": 900,
                "articles": [
                    {
                        "google_url": items[0]["original_google_news_url"],
                        "conversion_success": True,
                        "publisher_url": PUBLISHER_URL,
                        "failure_reason": None,
                    },
                    {
                        "google_url": items[1]["original_google_news_url"],
                        "conversion_success": False,
                        "publisher_url": None,
                        "failure_reason": "GOOGLE_HTTP_429",
                    },
                ],
            }

        result = process_claimed_batch(
            {"lease_id": "lease-3", "items": items},
            decoder=decoder,
            article_fetcher=lambda *_args, **_kwargs: self.fail("must stop after Google 429"),
        )

        self.assertEqual(result["global_cooldown_seconds"], 900)
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["results"][0]["url_resolution_status"], "RESOLVED")
        self.assertEqual(result["results"][0]["article_fetch_status"], "NOT_ATTEMPTED")
        self.assertEqual(result["results"][1]["url_resolution_status"], "RATE_LIMITED")
        self.assertEqual(result["unprocessed_ids"], ["obs-2"])

    def test_invalid_publisher_urls_are_failed_without_fetching(self):
        fetches = []

        def decoder(_records):
            return {
                "fatal_error": None,
                "google_http_429_observed": False,
                "articles": [{
                    "google_url": GOOGLE_URL,
                    "conversion_success": True,
                    "publisher_url": "https://127.0.0.1/private",
                    "failure_reason": None,
                }],
            }

        result = process_claimed_batch(
            {"lease_id": "lease-4", "items": [claim_item()]},
            decoder=decoder,
            article_fetcher=lambda *args, **kwargs: fetches.append((args, kwargs)),
        )

        self.assertEqual(result["results"][0]["url_resolution_status"], "FAILED")
        self.assertEqual(result["results"][0]["safe_error_category"], "INVALID_PUBLISHER_URL")
        self.assertEqual(fetches, [])

    def test_access_restricted_article_keeps_resolution_success_and_body_failure_separate(self):
        def decoder(_records):
            return {
                "fatal_error": None,
                "google_http_429_observed": False,
                "articles": [{
                    "google_url": GOOGLE_URL,
                    "conversion_success": True,
                    "publisher_url": PUBLISHER_URL,
                    "failure_reason": None,
                }],
            }

        result = process_claimed_batch(
            {"lease_id": "lease-5", "items": [claim_item()]},
            decoder=decoder,
            article_fetcher=lambda *_args, **_kwargs: {
                "status": "ACCESS_RESTRICTED_OR_PAYWALL",
                "http_status": 403,
                "http_access_success": False,
                "body_extraction_success": False,
                "article_excerpt": None,
            },
        )

        row = result["results"][0]
        self.assertEqual(row["url_resolution_status"], "RESOLVED")
        self.assertEqual(row["article_fetch_status"], "ACCESS_RESTRICTED")
        self.assertEqual(row["article_extraction_status"], "NOT_ATTEMPTED")
        self.assertEqual(row["safe_error_category"], "PUBLISHER_HTTP_403")
        self.assertIsNone(row["article_content_excerpt"])

    def test_publisher_429_stops_remaining_page_fetches_and_sets_global_cooldown(self):
        items = [
            {**claim_item(f"obs-pub-{index}"), "google_article_id": f"article-pub-{index}",
             "original_google_news_url": f"https://news.google.com/rss/articles/article-pub-{index}"}
            for index in range(3)
        ]
        calls = []

        def decoder(records):
            return {
                "fatal_error": None,
                "google_http_429_observed": False,
                "articles": [{
                    "google_url": record["canonical_url"],
                    "conversion_success": True,
                    "publisher_url": PUBLISHER_URL,
                    "failure_reason": None,
                } for record in records],
            }

        def fetcher(url, **_kwargs):
            calls.append(url)
            return {
                "status": "ACCESS_RESTRICTED_OR_PAYWALL",
                "http_status": 429,
                "http_access_success": False,
                "body_extraction_success": False,
                "article_excerpt": None,
            }

        result = process_claimed_batch({"lease_id": "lease-pub-429", "items": items},
                                       decoder=decoder, article_fetcher=fetcher)

        self.assertEqual(calls, [PUBLISHER_URL])
        self.assertEqual(result["global_cooldown_seconds"], 900)
        by_id = {row["id"]: row for row in result["results"]}
        self.assertEqual(by_id["obs-pub-0"]["article_fetch_status"], "RATE_LIMITED")
        self.assertEqual(by_id["obs-pub-1"]["article_fetch_status"], "NOT_ATTEMPTED")
        self.assertIsNone(by_id["obs-pub-1"]["safe_error_category"])

    def test_repeated_google_article_id_uses_one_conversion_and_one_publisher_fetch(self):
        items = [claim_item("obs-first"), claim_item("obs-second")]
        decoder_calls = []
        fetch_calls = []

        def decoder(records):
            decoder_calls.append(records)
            return {
                "fatal_error": None,
                "google_http_429_observed": False,
                "articles": [{
                    "google_url": GOOGLE_URL,
                    "conversion_success": True,
                    "publisher_url": PUBLISHER_URL,
                    "failure_reason": None,
                }],
            }

        def fetcher(*_args, **_kwargs):
            fetch_calls.append(True)
            return {
                "status": "ARTICLE_BODY_EXTRACTED",
                "http_status": 200,
                "body_extraction_success": True,
                "article_excerpt": "Manchester United confirmed the squad update.",
            }

        result = process_claimed_batch(
            {"lease_id": "lease-6", "items": items},
            decoder=decoder,
            article_fetcher=fetcher,
        )

        self.assertEqual(len(decoder_calls), 1)
        self.assertEqual(len(decoder_calls[0]), 1)
        self.assertEqual(fetch_calls, [True])
        self.assertEqual([row["id"] for row in result["results"]], ["obs-first", "obs-second"])

    def test_api_client_rejects_batch_over_thirty_and_does_not_retry_http_429(self):
        calls = []

        def request(*_args, **_kwargs):
            calls.append(True)
            response = requests.Response()
            response.status_code = 429
            response._content = b'{"error":"RATE_LIMITED"}'
            return response

        api = ResolverApiClient(
            "https://example.supabase.co/functions/v1/gnews-resolver-api",
            "worker-token",
            request=request,
        )
        with self.assertRaisesRegex(ValueError, "INVALID_BATCH_SIZE"):
            api.claim("workflow-run:attempt-1:claim", 31)
        with self.assertRaisesRegex(ResolverApiError, "RESOLVER_API_RATE_LIMITED"):
            api.claim("workflow-run:attempt-1:claim", 30)
        self.assertEqual(calls, [True])

    def test_restart_attempt_has_separate_idempotency_keys_for_claim_and_result_write(self):
        class FakeApi:
            def __init__(self):
                self.request_ids = []

            def claim(self, request_id, batch_size):
                self.request_ids.append(request_id)
                return {"lease_id": "lease-7", "items": []}

            def complete(self, request_id, lease_id, results, unprocessed_ids, cooldown):
                self.request_ids.append(request_id)
                return {"status": "COMPLETED"}

        api = FakeApi()
        empty_decoder = lambda _records: {"articles": [], "fatal_error": None, "google_http_429_observed": False}
        result = run_once(api, "workflow-77:attempt-2", decoder=empty_decoder)

        self.assertEqual(result["status"], "NOOP")
        self.assertEqual(api.request_ids, ["workflow-77:attempt-2:claim"])


if __name__ == "__main__":
    unittest.main()
