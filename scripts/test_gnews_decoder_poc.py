import unittest

from scripts.gnews_decoder_poc import (
    classify_conversion,
    dedupe_records,
    extract_article_content,
    extract_article_excerpt,
    fetch_article_page,
    run_body_limit_experiment,
    GoogleRateLimitStop,
    GoogleRunStopped,
    GuardedGoogleSession,
    is_google_news_article_url,
    validate_publisher_url,
)


class GNewsDecoderPocTests(unittest.TestCase):
    def test_only_google_news_rss_article_urls_are_accepted(self):
        self.assertTrue(
            is_google_news_article_url(
                "https://news.google.com/rss/articles/CBMi-test?oc=5"
            )
        )
        self.assertFalse(
            is_google_news_article_url(
                "https://news.google.com.evil.example/rss/articles/CBMi-test"
            )
        )
        self.assertFalse(
            is_google_news_article_url(
                "http://news.google.com/rss/articles/CBMi-test"
            )
        )

    def test_duplicate_and_invalid_google_urls_are_removed_before_network_use(self):
        first = {
            "title": "First headline",
            "canonical_url": "https://news.google.com/rss/articles/first",
        }
        duplicate = {**first, "title": "Duplicate headline"}
        invalid = {
            "title": "Not Google",
            "canonical_url": "https://example.com/story",
        }

        self.assertEqual(dedupe_records([first, duplicate, invalid]), [first])

    def test_only_public_non_google_https_urls_count_as_publishers(self):
        self.assertEqual(
            validate_publisher_url("https://www.bbc.com/sport/football/story"),
            "https://www.bbc.com/sport/football/story",
        )
        for unsafe in (
            "http://www.bbc.com/story",
            "https://news.google.com/rss/articles/id",
            "https://google.com/story",
            "https://127.0.0.1/story",
            "https://localhost/story",
            "https://user:pass@publisher.example/story",
            "https://publisher.example:8443/story",
            "https://bad_domain.example/story",
        ):
            with self.subTest(url=unsafe):
                self.assertIsNone(validate_publisher_url(unsafe))

    def test_conversion_status_does_not_accept_google_url_as_publisher(self):
        original = "https://news.google.com/rss/articles/id"
        self.assertEqual(
            classify_conversion(original, "https://www.espn.com/story"),
            {
                "success": True,
                "publisher_url": "https://www.espn.com/story",
                "final_domain": "www.espn.com",
                "failure_reason": None,
            },
        )
        failed = classify_conversion(
            original, "https://news.google.com/articles/id"
        )
        self.assertFalse(failed["success"])
        self.assertIsNone(failed["publisher_url"])

    def test_article_excerpt_ignores_navigation_and_scripts(self):
        html = (
            "<nav><p>Navigation text that should never be article evidence.</p></nav>"
            "<script><p>Script text that should never be article evidence.</p></script>"
            "<article><p>Manchester United reported a meaningful team update "
            "with enough words to pass the existing paragraph length threshold.</p>"
            "<p>Manchester United reported a meaningful team update "
            "with enough words to pass the existing paragraph length threshold.</p></article>"
        )
        excerpt = extract_article_excerpt(html, 200)
        self.assertEqual(
            excerpt,
            "Manchester United reported a meaningful team update with enough words "
            "to pass the existing paragraph length threshold.",
        )

    def test_improved_extractor_selects_article_and_excludes_menus_ads_and_related(self):
        story = (
            "Manchester United confirmed an important squad update before the next "
            "Premier League match, with the manager describing the player's return "
            "as a decision that depends on the final training session."
        )
        html = (
            "<nav><p>Menu text that should not be confused with the article body "
            "even though this sentence is deliberately longer than forty chars.</p></nav>"
            "<main><div class='advertisement'><p>Advertisement text that is long "
            "enough to pass the old paragraph length rule but must be excluded.</p></div>"
            f"<article><h1>Manchester United team news</h1><p>{story}</p>"
            "<section class='related-stories'><p>Related story text should not be "
            "included in the main report because it belongs to another article.</p>"
            "</section></article></main>"
            "<footer><p>Footer text should not appear in the extracted story.</p></footer>"
        )

        result = extract_article_content(html)

        self.assertEqual(result["container"], "article")
        self.assertEqual(result["paragraph_count"], 1)
        self.assertEqual(result["excerpt"], story)
        self.assertNotIn("Advertisement", result["excerpt"])
        self.assertNotIn("Related story", result["excerpt"])

    def test_improved_extractor_rejects_page_furniture_that_does_not_match_headline(self):
        html = (
            "<html><body><p>Be respectful and read the community guidelines before "
            "joining the conversation on this sports website.</p></body></html>"
        )

        result = extract_article_content(
            html,
            expected_title=(
                "Worst in 40 years! Manchester United script unwanted record after "
                "draw against 10-man Tottenham Hotspur"
            ),
        )

        self.assertIsNone(result["excerpt"])
        self.assertEqual(result["rejection_reason"], "TITLE_NOT_RELEVANT")

    def test_body_limit_matrix_fetches_each_article_once_and_never_returns_html(self):
        article_text = (
            "Manchester United reported a meaningful team update with enough words "
            "to pass the existing paragraph length threshold and provide a useful "
            "bounded article excerpt for the test."
        )
        padding = "x" * 260_000
        html = (
            f"<article><p>{article_text}</p></article><!--{padding}-->"
        ).encode()
        calls = []
        run = {
            "articles": [{
                "title": "Manchester United team update",
                "google_url": "https://news.google.com/rss/articles/test-id",
                "publisher_url": "https://www.bbc.com/sport/football/test-story",
                "conversion_success": True,
            }]
        }

        def public_dns(host, port, type):
            return [(None, None, None, None, ("8.8.8.8", port or 443))]

        def fetcher(url, ip_address, timeout_s, max_bytes):
            calls.append((url, max_bytes))
            return 200, {
                "content-type": "text/html; charset=utf-8",
                "content-length": str(len(html)),
            }, html[: max_bytes + 1]

        result = run_body_limit_experiment(
            run["articles"],
            body_limit=1,
            dns_resolver=public_dns,
            request_impl=fetcher,
        )

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], 800_000)
        article = result["articles"][0]
        limits = {item["limit_bytes"]: item for item in article["limits"]}
        self.assertEqual(limits[200_000]["existing_status"], "BODY_TOO_LARGE")
        self.assertEqual(limits[200_000]["improved_status"], "BODY_TOO_LARGE")
        self.assertTrue(limits[500_000]["existing_extraction_success"])
        self.assertTrue(limits[500_000]["improved_extraction_success"])
        self.assertTrue(limits[800_000]["improved_extraction_success"])
        self.assertNotIn("body_html", str(result))
        self.assertNotIn(padding, str(result))

    def test_body_limit_matrix_stops_publisher_requests_after_429(self):
        calls = []
        articles = [
            {
                "title": f"Manchester United article {index}",
                "google_url": f"https://news.google.com/rss/articles/test-{index}",
                "publisher_url": f"https://publisher.example/article-{index}",
                "conversion_success": True,
            }
            for index in range(3)
        ]

        def public_dns(host, port, type):
            return [(None, None, None, None, ("8.8.8.8", port or 443))]

        def fetcher(url, ip_address, timeout_s, max_bytes):
            calls.append(url)
            return 429, {"retry-after": "60"}, b""

        result = run_body_limit_experiment(
            articles,
            dns_resolver=public_dns,
            request_impl=fetcher,
        )

        self.assertEqual(len(calls), 1)
        self.assertTrue(result["publisher_http_429_observed"])
        self.assertEqual(result["articles"][1]["fetch_status"], "NOT_ATTEMPTED_AFTER_PUBLISHER_429")
        self.assertEqual(result["articles"][2]["fetch_status"], "NOT_ATTEMPTED_AFTER_PUBLISHER_429")

    def test_publisher_redirect_to_private_address_is_blocked(self):
        requests = []

        def public_dns(host, port, type):
            return [(None, None, None, None, ("8.8.8.8", port or 443))]

        def fetcher(url, ip_address, timeout_s, max_bytes):
            requests.append((url, ip_address))
            return 302, {"location": "http://127.0.0.1/private"}, b""

        result = fetch_article_page(
            "https://www.bbc.com/sport/story",
            dns_resolver=public_dns,
            request_impl=fetcher,
        )
        self.assertEqual(result["status"], "UNSAFE_REDIRECT")
        self.assertEqual(len(requests), 1)

    def test_http_success_and_body_extraction_are_reported_separately(self):
        body = (
            "<article><p>Manchester United reported a meaningful team update "
            "with enough words to pass the existing paragraph length threshold.</p></article>"
        ).encode()

        def public_dns(host, port, type):
            return [(None, None, None, None, ("8.8.8.8", port or 443))]

        def fetcher(url, ip_address, timeout_s, max_bytes):
            return 200, {"content-type": "text/html; charset=utf-8"}, body

        result = fetch_article_page(
            "https://www.espn.com/story",
            dns_resolver=public_dns,
            request_impl=fetcher,
        )
        self.assertTrue(result["http_access_success"])
        self.assertTrue(result["body_extraction_success"])
        self.assertEqual(result["status"], "ARTICLE_BODY_EXTRACTED")

    def test_http_success_without_article_paragraphs_is_not_body_success(self):
        def public_dns(host, port, type):
            return [(None, None, None, None, ("8.8.8.8", port or 443))]

        def fetcher(url, ip_address, timeout_s, max_bytes):
            return (
                200,
                {"content-type": "text/html; charset=utf-8"},
                b"<html><body><p>Short consent page.</p></body></html>",
            )

        result = fetch_article_page(
            "https://www.espn.com/story",
            dns_resolver=public_dns,
            request_impl=fetcher,
        )
        self.assertTrue(result["http_access_success"])
        self.assertFalse(result["body_extraction_success"])
        self.assertEqual(result["status"], "HTTP_ACCESS_SUCCESS_BODY_NOT_EXTRACTED")

    def test_google_429_stops_later_requests_without_retry(self):
        import requests
        from unittest.mock import patch

        class FakeResponse:
            status_code = 429
            headers = {}

            def close(self):
                pass

        first = "https://news.google.com/rss/articles/first"
        second = "https://news.google.com/rss/articles/second"
        with patch.object(requests.Session, "request", return_value=FakeResponse()) as send:
            session = GuardedGoogleSession()
            with self.assertRaises(GoogleRateLimitStop):
                session.get(first, timeout=1)
            with self.assertRaises(GoogleRunStopped):
                session.get(second, timeout=1)
        self.assertEqual(send.call_count, 1)
        session.close()

    def test_google_session_rejects_non_google_host_before_network_call(self):
        import requests
        from unittest.mock import patch

        with patch.object(requests.Session, "request") as send:
            session = GuardedGoogleSession()
            with self.assertRaises(ValueError):
                session.get("https://127.0.0.1/private", timeout=1)
            send.assert_not_called()
            session.close()

    def test_google_redirect_metrics_record_host_without_following_location(self):
        import requests
        from unittest.mock import patch

        class FakeResponse:
            status_code = 302
            headers = {"location": "https://consent.google.com/m?next=secret"}

            def close(self):
                pass

        with patch.object(requests.Session, "request", return_value=FakeResponse()) as send:
            session = GuardedGoogleSession()
            session.get("https://news.google.com/rss/articles/article-id", timeout=1)
            self.assertEqual(send.call_count, 1)
            self.assertEqual(session.request_metrics[0]["redirect_host"], "consent.google.com")
            self.assertEqual(session.request_metrics[0]["redirect_path"], "/m")
            self.assertEqual(session.request_metrics[0]["redirect_query_keys"], ["next"])
            self.assertNotIn("secret", str(session.request_metrics[0]))
            session.close()

    def test_google_session_follows_at_most_one_same_origin_redirect(self):
        import requests
        from unittest.mock import patch

        class FakeResponse:
            def __init__(self, status_code, location=None):
                self.status_code = status_code
                self.headers = {"location": location} if location else {}
                self.closed = False

            def close(self):
                self.closed = True

        article = "https://news.google.com/rss/articles/article-id?oc=5"
        localized = (
            "https://news.google.com/rss/articles/article-id?oc=5"
            "&hl=en-US&gl=US&ceid=US%3Aen"
        )
        first = FakeResponse(302, localized)
        second = FakeResponse(302, localized)
        with patch.object(
            requests.Session,
            "request",
            side_effect=[first, second],
        ) as send:
            session = GuardedGoogleSession()
            final = session.get(article, timeout=1)
            self.assertIs(final, second)
            self.assertEqual(send.call_count, 2)
            self.assertTrue(first.closed)
            self.assertEqual(session.request_metrics[0]["status"], 302)
            self.assertEqual(session.request_metrics[1]["status"], 302)
            self.assertEqual(session.request_metrics[0]["article_origin_url"], article)
            self.assertEqual(session.request_metrics[1]["article_origin_url"], article)
            session.close()

    def test_runtime_article_fetch_is_bounded_to_800kb(self):
        html = b"<article><p>Manchester United reported a meaningful team update " + b"x" * 810_000
        calls = []

        def public_dns(host, port, type):
            return [(None, None, None, None, ("8.8.8.8", port or 443))]

        def fetcher(url, ip_address, timeout_s, max_bytes):
            calls.append(max_bytes)
            return 200, {
                "content-type": "text/html; charset=utf-8",
                "content-length": str(len(html)),
            }, b""

        page = fetch_article_page(
            "https://www.bbc.com/sport/football/test-story",
            max_bytes=800_000,
            dns_resolver=public_dns,
            request_impl=fetcher,
        )

        self.assertEqual(calls, [800_000])
        self.assertEqual(page["status"], "BODY_TOO_LARGE")
        self.assertFalse(page["body_extraction_success"])

    def test_article_fetch_preserves_forbidden_status_without_bypass(self):
        def public_dns(host, port, type):
            return [(None, None, None, None, ("8.8.8.8", port or 443))]

        page = fetch_article_page(
            "https://www.nytimes.com/2026/10/12/sports/soccer/united.html",
            dns_resolver=public_dns,
            request_impl=lambda *_: (403, {"content-type": "text/html"}, b""),
        )

        self.assertEqual(page["http_status"], 403)
        self.assertEqual(page["status"], "ACCESS_RESTRICTED_OR_PAYWALL")
        self.assertFalse(page["http_access_success"])
        self.assertFalse(page["body_extraction_success"])

    def test_article_fetch_rejects_title_mismatch(self):
        html = (
            "<html><body><article><p>Join the community and read these guidelines "
            "before posting on the sports website. This message contains no story "
            "about the transfer reported in the headline.</p></article></body></html>"
        ).encode()

        page = fetch_article_page(
            "https://publisher.example/article",
            expected_title="Manchester United sign the striker after medical",
            dns_resolver=lambda *_args, **_kwargs: [
                (None, None, None, None, ("8.8.8.8", 443))
            ],
            request_impl=lambda *_args: (
                200,
                {"content-type": "text/html; charset=utf-8"},
                html,
            ),
        )

        self.assertEqual(page["status"], "TITLE_NOT_RELEVANT")
        self.assertTrue(page["http_access_success"])
        self.assertFalse(page["body_extraction_success"])


if __name__ == "__main__":
    unittest.main()
