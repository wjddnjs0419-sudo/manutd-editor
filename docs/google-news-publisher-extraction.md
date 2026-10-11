# Google News publisher article extraction

Google News RSS returns headlines and publisher names, but its `/rss/articles/...` URLs frequently lead to an HTML/JavaScript wrapper rather than article HTML. This means the old `extractArticleExcerpt` step could neither read the publisher story nor distinguish the wrapper from readable content.

## New behavior

1. `google_news_provider.ts` preserves the publisher name from the RSS `<source>` tag. All such rows remain `DISCOVERY_COMMUNITY` (never fact-verified merely because a publisher is named).
2. `enrichObservations` ranks high-ManUtd-relevance articles first and attempts at most four Google wrapper resolutions per run. Other direct publisher URLs remain eligible for enrichment.
3. For the selected Google rows, `google_news_resolution.ts` tries to fetch Google's signed article parameters and resolve the publisher link using Google's currently observed `Fbv4je` response. This endpoint is **unofficial/unstable**, may fail or rate-limit, and is **not** a guaranteed resolver.
4. A successful resolution replaces the `canonicalUrl` used for the article, retaining the Google RSS URL in `metadata.google_news_url`. Then the system fetches publicly accessible article HTML and extracts up to 6,000 characters from `<article>`, `<main>`, or page paragraphs.
5. A failed Google resolution retains the original RSS link/title/summary. A successfully resolved but paywalled or inaccessible page keeps the real article URL but retains the RSS synopsis.
6. `metadata.article_enrichment=EXTRACTED` is only applied if accessible publisher paragraphs have really been extracted.

## Out of scope

- No browser automation, paywall bypass or guarantees of full article text.
- No bypass/removal of `GROUND_CLAIMS`, `VERIFIED`, `news_eligible`, or human editorial approval.
- No production deployment or environment/secret changes.
- Direct publisher pages that use ordinary 301/302 redirects may still be unavailable under the existing security policy (`redirect: manual`). The Google wrapper resolver is not a general-purpose URL redirector.
- The external Google signed endpoint may change without notice; production monitoring is required.

## Tests

New tests use mocked Google responses (no live requests) and cover publisher URL resolution, unsafe destinations, failed links, article extraction, and preservation of the RSS fallback.

```bash
cd supabase/functions
deno test --allow-env --allow-net \
  tests/trend-discovery/google_news_resolution_test.ts \
  tests/trend-discovery/article_enrichment_test.ts \
  tests/trend-discovery/orchestrator_test.ts \
  tests/source-discovery/article_extractor_test.ts \
  tests/source-discovery/feed_parser_test.ts
```

After deploying to a **staging** Supabase project, check the fraction of Google observations whose `metadata.publisher_url_resolved` and `metadata.article_enrichment` are true. These are separate fields on purpose. Confirm the cost and average runtime before merging production.

Example read-only SQL for the ManUtd Editor Supabase project:

```sql
SELECT provider_id, source_canonical_name,
       COUNT(*) AS observations,
       COUNT(*) FILTER (WHERE metadata->>'publisher_url_resolved' = 'true') AS resolved_urls,
       COUNT(*) FILTER (WHERE metadata->>'article_enrichment' = 'EXTRACTED') AS extracted_articles
FROM app_private.discovery_observations
WHERE last_observed_at >= now() - interval '24 hours'
GROUP BY provider_id, source_canonical_name
ORDER BY observations DESC;
```

**Validation status:** Code and mock-based tests have been added; tests have **not been executed** in the connected environment (Deno unavailable), and the actual Google link resolution success rate is unknown.
