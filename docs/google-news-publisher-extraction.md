# Google News publisher article extraction

This page previously described resolving Google URLs inside the Supabase Edge discovery function. That design has been replaced by the leased GitHub Actions worker because the Edge egress path encountered Google 429s. The earlier Google endpoint notes remain historical: the signed `Fbv4je` format is unofficial and can change.

## Current flow

1. Google News RSS stores its original wrapper URL, provider identity, headline, and RSS excerpt. Google observations remain `DISCOVERY_COMMUNITY`.
2. The `gnews-resolver-api` Edge function exposes bounded claim and result operations. It is disabled by default and keeps the Supabase service-role key inside Edge runtime.
3. The manual-only GitHub Actions worker runs `gnews-decoder==0.1.1` against up to 30 unique article IDs, with two concurrent Google signature requests and no automatic retries.
4. Safe publisher URLs are fetched one at a time with DNS pinning, bounded redirects, an 800 KB cap, and title relevance checking. The shared search/RSS limits remain unchanged. The resolver stores only a short extracted excerpt, never full HTML. Recent mode defaults to the latest 72 hours, with the latest 24 hours first; historical rows require a manual one-batch backfill choice.
5. `url_resolution_status`, `article_fetch_status`, and `article_extraction_status` are independent. A URL may resolve while a page remains paywalled, inaccessible, too large, empty, or irrelevant.
6. M8 promotes only relevant, unassigned, recent resolved observations as discovery evidence. Already-assigned rows update their existing source observation through its foreign key; this pipeline never inserts a duplicate source or changes story/publication state. Publisher attribution and the original Google URL are both retained. The resolver never marks a claim `VERIFIED`.

See [the resolver runbook](gnews-resolution-pipeline-runbook.md) for flags, deployment steps, rollback, request volume, costs, and the production checklist.

## Safety and verification

- No browser automation, paywall bypass, or guarantee of full article text.
- No relaxation of claim grounding, editorial eligibility, `news_eligible`, or human review.
- Google News search and publisher URL resolution are separate flags. Search is enabled explicitly; trusted RSS routing remains enabled as configured.
- Offline tests use mocked network responses. Run the pgTAP migration test only against an explicitly isolated disposable or staging database; production remains untouched.
- The migration and pgTAP suite were applied to an isolated local Docker Supabase project. This implementation has not changed production Supabase settings, deployed the Edge function, enabled a schedule, or made live Google requests.
