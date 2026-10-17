# Fact-grounding recovery runbook

## Why Telegram shows "출처 확인 중" or blocks carousel generation

- Google News intentionally has the `DISCOVERY_COMMUNITY` role. Discovery is not fact verification.
- `source-discovery` returns a safe `NOOP` if `SOURCE_DISCOVERY_FEEDS_JSON` is unset. This is not the same as "checking in progress".
- Only official (`FACT_PRIMARY`) or independent (`FACT_INDEPENDENT`) observations can ground a claim.
- Editorial approval still requires `VERIFIED`, at least one verified claim, zero contradictory claims and `fact_grounding_score >= 70`.

## Configure a fact source (production setup, **not** done by this PR)

In Supabase Dashboard > Edge Functions > Secrets, configure the single-line JSON value below.
Keep the variable empty in environments where automatic fact collection is intentionally disabled.

```text
SOURCE_DISCOVERY_FEEDS_JSON=[{"canonical_name":"BBC Sport Football","editorial_role":"FACT_INDEPENDENT","entity_type":"MEDIA_OUTLET","url":"https://feeds.bbci.co.uk/sport/football/rss.xml","format":"RSS","include_terms":["manchester united","man utd","man united"]}]
```

A news feed is a source of attributed reporting, not independent confirmation of all claims in the feed. Do not whitelist search aggregators as `FACT_INDEPENDENT` just because they link to credible articles. Keep domain/source-role provenance and the existing anti-cross-story matching rules. Verify upstream access, item timestamps and feed terms in the deployed environment.

## What the bounded refresh fixes

If `DISCOVER_SOURCES` newly saves one or more observations from a `FACT_PRIMARY` / `FACT_INDEPENDENT` feed, the worker passes `refresh_existing_grounding=true` through `DISCOVER_TRENDS` to `PROMOTE_DISCOVERY`. The promotion handler may include recently active existing canonical stories in `affectedStoryIds` even when there are **no newly promoted observations**.

Guardrails:

- Existing story recency: **48 hours** (relative to the promotion's fixed `as_of`)
- Recheck cap: **25 existing stories per promotion**, always respecting the existing max of 100 story IDs
- No new FACT observations / no feed configured: original empty-promotion no-grounding behavior remains
- Scoped, cursor-paginated `GROUND_CLAIMS` remains unchanged
- No relaxation of `VERIFIED`, `news_eligible` or contradictory-evidence conditions
- New fact feed rows trigger this refresh; changed existing feed rows are **not** considered newly observed by this implementation

## Read-only production diagnostics

Run in **the ManUtd Editor Supabase project** (not a different personal project).

```sql
-- 1. Find the actual stage that fails, stalls or dies
SELECT job_type, status, last_error_category, COUNT(*) AS jobs,
       MAX(created_at) AS latest_created
FROM app_private.editorial_jobs
WHERE created_at >= now() - interval '48 hours'
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- 2. Check fact observation presence, not just discovered headlines
SELECT editorial_role, COUNT(*) AS recent,
       MAX(observed_at) AS last_seen
FROM app_private.source_observations
WHERE observed_at >= now() - interval '72 hours'
GROUP BY editorial_role
ORDER BY recent DESC;

-- 3. Verify the newest story rankings and eligibility
SELECT ranking_date, grounding_status, news_eligible,
       COUNT(*) AS stories
FROM app_private.editorial_rankings
WHERE ranking_date >= (now() AT TIME ZONE 'Asia/Seoul')::date - 1
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;
```

Check Edge Function logs for `source-discovery` (JSON response `fact_observed`), `promote-discovery` (response `affectedStoryIds`), `ground-claims` (`ground_claims_match_complete.verified` and `ground_claims_failed`) and `rank-editorial` (`newsEligible`). Avoid logging keys, article bodies or private Telegram data.

## Post-deployment acceptance checks

1. Confirm the deployed migration, `orchestration-worker` and the updated functions (`source-discovery`, `promote-discovery`, `telegram-agent`) match the intended commit.
2. Verify the `SOURCE_DISCOVERY_FEEDS_JSON` value has at least one working trusted FACT feed. Do not paste secrets into chat or commit an environment file.
3. Wait for the next normal cycle or trigger a valid authorized dry-run/test; confirm `fact_observed > 0` when a genuinely new fact article is ingested.
4. When there are no new trend observations, confirm the promotion still supplies a bounded existing-story ID list and `GROUND_CLAIMS` completes.
5. Confirm a previously unverified but supported story becomes `news_eligible=true` only after real evidence exists.
6. If not, inspect match anchors, extraction quality and `last_error_category` rather than weakening the safety gate.

**Scope:** This change is code-only and does not install secrets, migrate a live project, deploy Edge Functions, or guarantee carousel generation for previously unsupported stories.
