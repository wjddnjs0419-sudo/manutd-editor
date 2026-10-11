# Google News publisher URL resolution runbook

This pipeline is an opt-in, manually invoked resolver for existing discovery observations. It does not change the production environment or apply its migration. Google News remains a discovery provider; it is never treated as a verified source.

## Flow and state

1. The existing RSS discovery provider stores `provider_id=google-news`, its Google RSS canonical URL, provider identity, title, RSS excerpt, fingerprint, and story-cluster references. Search is disabled unless `DISCOVERY_GOOGLE_NEWS_ENABLED=true`.
2. The Edge function `gnews-resolver-api` accepts an authenticated claim or completion request. Its PostgreSQL functions claim up to 30 unique Google article IDs, lease rows for 20 minutes, rate-limit the worker, and persist idempotency and cooldown state.
3. The manually dispatched GitHub Actions worker runs `gnews-decoder==0.1.1` with two concurrent signature reads, one batch RPC, and no automatic retry. Google HTTP 429 immediately stops that run and sets a global cooldown.
4. Each safe publisher URL is fetched sequentially with DNS pinning, bounded redirects, and an 800,000-byte HTML cap. Existing shared search/RSS response limits and non-Google article enrichment limits remain unchanged. Access restrictions, fetch failures, and extraction failures remain separate statuses. Only a relevant extracted excerpt (up to 2,000 characters) is stored; HTML is discarded.
5. M8 promotes only resolved Google observations that pass its existing ManUtd relevance filter. The canonical source observation uses the publisher URL and retains Google URL/provider identity in metadata. Promotion remains `DISCOVERY_ONLY`; the resolver does not verify claims or relax grounding/editorial eligibility.
6. M9 receives publisher URLs for image discovery and carries the original Google URL as provenance. Google wrapper URLs and YouTube URLs are rejected at the M9 boundary.

URL resolution and article extraction have independent fields. A resolved publisher URL with a 403, paywall, empty body, or irrelevant article can never be interpreted as a successful extraction.

## Feature flags

Keep these independent and default them to off:

| Flag | Location | Effect |
| --- | --- | --- |
| `DISCOVERY_GOOGLE_NEWS_ENABLED` | `trend-discovery` Edge environment | Adds Google News RSS search to discovery. Must be the literal string `true`. |
| `GNEWS_RESOLVER_ENABLED` | `gnews-resolver-api` Edge environment | Enables the narrow resolver API. Defaults off. |
| `GNEWS_RESOLVER_ENABLED` | Worker process environment | Allows the worker to make one batch. The workflow sets it only after manual opt-in. |

GDELT keeps its existing setting and routing. BBC and other trusted RSS providers are unchanged. There is no cron/schedule trigger in the resolver workflow.

## Manual setup after review

Complete these steps in a non-production project/repository first. This branch must not be used to deploy or activate production settings without a separate operations approval.

1. Apply the migration to a disposable/staging Supabase project, run the SQL test below, and deploy `gnews-resolver-api` with `GNEWS_RESOLVER_ENABLED=false`.
2. Configure `GNEWS_RESOLVER_WORKER_TOKEN` as the same randomly generated high-entropy secret in the Edge environment and the GitHub `gnews-resolver` environment. Rotate both values together. The service-role key stays in Supabase only.
3. Add `GNEWS_RESOLVER_API_URL` to the GitHub environment. Restrict the environment to the intended branch and configure required reviewers before setting the two Actions secrets.
4. Run the resolver workflow with `run_resolver=false` to exercise its offline checks. Verify the Edge API is disabled and rejects missing/incorrect worker credentials.
5. In staging only, enable the API and dispatch once with `run_resolver=true`. Inspect request counts, status transitions, provenance, cooldown, and lease expiry. Enable Google search separately only when testing discovery input.
6. Before any production rollout, verify every item in the production checklist below and approve the migration/deployment/flag changes as distinct operations.

No service-role key, database URL, or Supabase admin credential belongs in GitHub Actions. The API has an 800 KB request cap, a 30-row batch cap, fixed RPC names, a 10-request-per-minute database limit, request-id idempotency, strict result validation, and 20-minute leases. Worker errors and API errors are reduced to safe categories.

## Failure handling and rollback

- Google HTTP 429: the current batch stops; no more publisher pages are fetched. The API writes a global cooldown (60 seconds to 6 hours, using the response hint where available). Do not rerun immediately; inspect status and wait for cooldown.
- Publisher 429: the current worker stops fetching further publisher pages. Already resolved URLs remain resolved; the affected article fetch is marked rate limited.
- Worker termination: the lease expires after 20 minutes. A later, separately dispatched run gets a fresh attempt. No loop or automatic retry is configured. Expired leases count toward the three-attempt cap; the third expiry becomes a terminal `FAILED/WORKER_LEASE_EXPIRED` state.
- Unsafe URL, YouTube, malformed URL, inaccessible page, and title mismatch are stored as excluded/failure states with bounded safe categories. Do not retry by bypassing a publisher restriction.
- Roll back new intake by setting `DISCOVERY_GOOGLE_NEWS_ENABLED=false`. Stop resolver activity by setting the Edge `GNEWS_RESOLVER_ENABLED=false` and removing/withholding GitHub environment secrets; already claimed rows will expire. Existing GDELT and trusted RSS settings are unchanged.
- The migration is additive and must not be reverted by dropping provenance/cache columns while observations refer to them. If a schema correction is required, write a forward migration after preserving status/provenance data.

## Request and cost estimate

For a full batch of 30 *unique, uncached* article IDs:

- Google resolver: 30 signature-page GETs, at most one same-host redirect per GET, and one batch RPC. The theoretical bound is 61 Google requests; the PoC observed 61 for 30 URLs without a 429. Reads run with concurrency 2. Cached IDs require no Google conversion request.
- Publisher pages: at most 30 GETs, sequentially (concurrency 1), each capped at 800 KB. A single worker run claims one batch and never loops.
- Supabase Edge: 2 invocations per batch (claim and result write). At the current published rate of $2 per million invocations above plan quota, 1,000 batches (2,000 invocations) are about $0.004 in invocation overage, before any plan quota. See [Supabase Edge invocation billing](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations).
- GitHub Actions: two Linux jobs (offline checks and the opted-in worker). Public-repository standard runner usage is free. For a private repository beyond included minutes, the current Linux 2-core listed rate is $0.006/minute and GitHub rounds each job up to a minute; if each job takes under one billed minute, budget about $0.012 per dispatch. Verify the account allowance and live rate before rollout: [GitHub runner rates](https://docs.github.com/en/billing/reference/actions-runner-pricing) and [included usage](https://docs.github.com/en/billing/reference/product-usage-included).
- No paid Google/GDELT API is added. Publisher network access and database compute/storage are governed by their current provider plans. The excerpt limit keeps each successful body write at or below 2,000 characters; no source HTML is stored.

The figures are request/cost bounds, not a recurring monthly forecast. A future schedule must be separately approved and would multiply batches, function invocations, and hosted-runner time by its actual cadence.

## Production activation checklist

- [ ] PR reviewed and merged by an authorized maintainer; no auto-merge configured.
- [ ] Migration reviewed, backed up, and applied through the approved release process; cache/backfill counts and constraints checked.
- [ ] SQL and Edge tests pass in staging; migration has not been applied by this implementation task.
- [ ] Supabase service-role secret exists only in the Edge environment; worker token is rotated, shared only between the Edge function and protected GitHub environment.
- [ ] GitHub `gnews-resolver` environment restricts branches and requires an operator reviewer; secrets are not repository-wide.
- [ ] Resolver API is deployed with `GNEWS_RESOLVER_ENABLED=false`; unauthenticated, disabled, oversized, unsafe-result, stale-lease, and rate-limit behavior verified.
- [ ] `DISCOVERY_GOOGLE_NEWS_ENABLED` and resolver flag have separate owners and change records; both remain off until separately approved.
- [ ] One manually approved staging batch confirms at most 30 claims, two concurrent Google reads, one publisher fetch at a time, correct cooldown, and no retries.
- [ ] 403/paywall, body limit, title mismatch, no-body, and YouTube cases remain excluded from body/claim verification.
- [ ] M8 promotion, source attribution, cluster identity, claim grounding, editorial eligibility, and M9 publisher-photo inputs verified on staging.
- [ ] Cost allowance, logs/retention, 429 response, lease recovery, rollback owners, and incident escalation documented.
- [ ] No cron, schedule, production deployment, GDELT removal, or Google News activation is included in this PR.

## Tests

Offline Python and Deno tests use mocked HTTP responses. `supabase/tests/database/024_gnews_resolver_pipeline_test.sql` covers URL validation, duplicate article IDs, cache propagation, original URL provenance, and expired-lease rejection. Do not use `supabase db reset`, `supabase db push`, or a remote migration command just to run it; execute the pgTAP file only against a disposable local/staging database after the migration is intentionally applied there.
