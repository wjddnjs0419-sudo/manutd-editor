# Milestone 8 Phase B/C Grounding and Editorial Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate source-role-aware discovery, factual claim grounding, and deterministic editorial ranking into the M7 pipeline and verify the linked production path at 09:00 Asia/Seoul.

**Architecture:** Add server-only observation, claim, evidence, and ranking projections. Three authenticated Edge Functions own source discovery, claim grounding, and ranking; the existing M7 worker chains them after intelligence. The existing 09:00 morning brief consumes the latest same-date ranking opportunistically and falls back to the canonical M4 candidate ordering.

**Tech Stack:** Supabase Postgres/pgTAP/pg_cron, Supabase Edge Functions on Deno 2.1.4, TypeScript, RSS/Atom over bounded `fetch`, existing M6 ESPN match tables, shell smoke scripts, and Node repository validators.

**Spec:** `docs/superpowers/specs/2026-09-27-milestone-8-phase-b-c-grounding-ranking-design.md`

## Global Constraints

- Discovery sources may create a lead and may be linked to a claim as `DISCOVERY_ONLY`, but they can never make a claim `VERIFIED`.
- Repost count, engagement, repeated community discussion, and source frequency are never converted into factual confidence.
- `published_posts` and `performance_metrics` are not queried by grounding or ranking.
- `content_candidates.priority_score`, M4 score weights, readiness semantics, and the canonical match provider remain unchanged.
- Raw upstream bodies, authorization headers, API keys, signed URLs, and model secrets are never logged or persisted.
- Missing feed configuration is a successful `NOOP` with an empty observation set.
- Existing M7 retries, dead-letter alerts, and 09:00 ALREADY_SENT behavior are preserved.
- All implementation and commits stay on `main`; remote production rollout is the final post-verification operation.

## Review Focus

- Discovery-only claims must remain non-news-eligible even when multiple community/video/competitor observations repeat the same claim — owned by Tasks 2–4 tests.
- A contradictory fact observation must not produce a verified or news-eligible claim — owned by Task 3 tests.
- A missing or late enrichment run must not prevent the 09:00 briefing — owned by Task 6 tests.
- The M7 chain must enqueue each new stage once and preserve retry/dead-letter behavior — owned by Task 5 tests.
- Remote verification must prove the linked migration, functions, Cron, worker, and 09:00 briefing state rather than infer deployment from CLI output — owned by Task 8 checks.

### Task 1: Add source-role and Phase B/C database contracts

**Files:**
- Create: `supabase/migrations/20260927193000_milestone_8_phase_b_c_grounding_ranking.sql`
- Create: `supabase/tests/database/020_m8_phase_b_c_grounding_ranking_test.sql`
- Modify: `supabase/seed.sql`

**Interfaces:**
- Produces `public.editorial_source_role`, role metadata on `public.information_sources`, server-only `source_observations`, `story_claims`, `claim_evidence`, and `editorial_rankings` tables.
- Produces service-role-only uniqueness and JSON/check constraints used by Tasks 2–4.

- [ ] **Step 1: Write the failing pgTAP contract test**

  Assert all seven roles, source role columns, server-only tables, RLS/privileges, observation/claim/ranking identity keys, `is_grounding` role restriction, score ranges, and the absence of any `published_posts`/`performance_metrics` foreign key or dependency.

- [ ] **Step 2: Run the focused database test to verify it fails**

  Run: `supabase db reset --local && psql ... -f supabase/tests/database/020_m8_phase_b_c_grounding_ranking_test.sql` (or the repository's standard `supabase test db --local` once the test is registered).

  Expected: FAIL because the M8 B/C role and projection contracts do not exist.

- [ ] **Step 3: Implement the migration and role-aware seed registry**

  Add the role enum/checks, role metadata to existing factual registry rows, discovery source registry rows for configured feed identities, bounded JSON checks, service-role-only grants, indexes, and idempotent seed updates. Keep `information_sources.reliability_score` as fact-source reliability; discovery roles must not gain factual reliability by repetition.

- [ ] **Step 4: Run the focused database test and full database suite**

  Run: `supabase test db --local`

  Expected: all existing database contracts plus `020_m8_phase_b_c_grounding_ranking_test.sql` pass.

- [ ] **Step 5: Commit the database contract**

  ```bash
  git add supabase/migrations/20260927193000_milestone_8_phase_b_c_grounding_ranking.sql supabase/tests/database/020_m8_phase_b_c_grounding_ranking_test.sql supabase/seed.sql
  git commit -m "feat: add M8 source grounding and ranking contracts"
  ```

### Task 2: Implement bounded source discovery

**Files:**
- Create: `supabase/functions/source-discovery/types.ts`
- Create: `supabase/functions/source-discovery/config.ts`
- Create: `supabase/functions/source-discovery/feed_parser.ts`
- Create: `supabase/functions/source-discovery/repository.ts`
- Create: `supabase/functions/source-discovery/orchestrator.ts`
- Create: `supabase/functions/source-discovery/handler.ts`
- Create: `supabase/functions/source-discovery/index.ts`
- Create: `supabase/functions/tests/source-discovery/feed_parser_test.ts`
- Create: `supabase/functions/tests/source-discovery/orchestrator_test.ts`
- Create: `supabase/functions/tests/source-discovery/handler_test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces `parseFeedDocument(xml, feed): readonly SourceObservationInput[]`.
- Produces `runSourceDiscovery({repository, feeds, fetch, now, asOf, limit}) -> SourceDiscoverySummary`.
- The handler accepts only POST and optional `{as_of, limit}` and returns safe counts/categories.

- [ ] **Step 1: Write failing parser/orchestrator/handler tests**

  Cover RSS and Atom title/link/date extraction, canonical URL and excerpt bounds, malformed/oversized items, missing config `NOOP`, one-feed failure isolation, duplicate observation keys, HTTPS-only feed validation, method/auth/body validation, and absence of raw body/error text in the response/log.

- [ ] **Step 2: Run the focused Deno tests to verify they fail**

  Run: `deno test --allow-env --allow-net supabase/functions/tests/source-discovery`

  Expected: FAIL because the source discovery modules do not exist.

- [ ] **Step 3: Implement the smallest pure parser and repository contract**

  Support public RSS/Atom metadata only, decode a bounded safe text excerpt, hash stable identity, and persist only normalized observation fields. Read `SOURCE_DISCOVERY_FEEDS_JSON`, `SOURCE_DISCOVERY_TIMEOUT_MS`, `SOURCE_DISCOVERY_MAX_BYTES`, and `SOURCE_DISCOVERY_MAX_ITEMS`; use an empty feed list as a successful `NOOP`.

- [ ] **Step 4: Implement the authenticated Edge Function boundary**

  Reuse the existing timing-safe collector secret pattern. Bound every request with an abort timeout and body limit; isolate per-feed failures; return only request id, status, counts, and safe error categories.

- [ ] **Step 5: Run focused tests and the full Deno suite**

  Run: `deno test --allow-env --allow-net supabase/functions/tests/source-discovery supabase/functions/tests`

  Expected: PASS with no secret-like values or raw upstream bodies in output.

- [ ] **Step 6: Commit source discovery**

  ```bash
  git add supabase/functions/source-discovery supabase/functions/tests/source-discovery .env.example
  git commit -m "feat: add bounded source discovery"
  ```

### Task 3: Implement claim grounding with source-role enforcement

**Files:**
- Create: `supabase/functions/ground-claims/types.ts`
- Create: `supabase/functions/ground-claims/matcher.ts`
- Create: `supabase/functions/ground-claims/repository.ts`
- Create: `supabase/functions/ground-claims/orchestrator.ts`
- Create: `supabase/functions/ground-claims/handler.ts`
- Create: `supabase/functions/ground-claims/index.ts`
- Create: `supabase/functions/tests/ground-claims/matcher_test.ts`
- Create: `supabase/functions/tests/ground-claims/orchestrator_test.ts`
- Create: `supabase/functions/tests/ground-claims/handler_test.ts`

**Interfaces:**
- Produces `classifyClaimEvidence(claim, observations) -> {status, confidence, evidence}`.
- Produces `runClaimGrounding({repository, asOf, version}) -> GroundingSummary`.
- The handler accepts only POST and optional `{as_of}` and returns safe grounding counts.

- [ ] **Step 1: Write failing grounding tests**

  Assert official/independent evidence can produce `VERIFIED`, competitor Instagram/Reddit/YouTube evidence produces `DISCOVERY_ONLY`, match context and own performance are ignored, contradictory fact observations produce `CONTRADICTED`, no evidence produces `INSUFFICIENT`, and repeated runs upsert one claim/evidence identity.

- [ ] **Step 2: Run the focused tests to verify they fail**

  Run: `deno test --allow-env --allow-net supabase/functions/tests/ground-claims`

  Expected: FAIL because the grounding modules do not exist.

- [ ] **Step 3: Implement deterministic normalized-token matching and role gate**

  Read M8-A claims and current cluster membership, match bounded normalized claim terms against observation title/excerpt/metadata, copy the source role into evidence, and allow `is_grounding` only for `FACT_PRIMARY` or `FACT_INDEPENDENT` with supporting relation. Never use observation count as factual confidence.

- [ ] **Step 4: Implement repository upserts and safe handler**

  Persist claim/evidence snapshots with bounded text and JSON; keep raw upstream payloads out of persistence; use service-role profile and timing-safe collector auth.

- [ ] **Step 5: Run focused, full Deno, and database tests**

  Run: `deno test --allow-env --allow-net supabase/functions/tests/ground-claims supabase/functions/tests` and `supabase test db --local`

  Expected: PASS.

- [ ] **Step 6: Commit claim grounding**

  ```bash
  git add supabase/functions/ground-claims supabase/functions/tests/ground-claims
  git commit -m "feat: ground claims by source role"
  ```

### Task 4: Implement deterministic editorial ranking

**Files:**
- Create: `supabase/functions/rank-editorial/types.ts`
- Create: `supabase/functions/rank-editorial/scoring.ts`
- Create: `supabase/functions/rank-editorial/repository.ts`
- Create: `supabase/functions/rank-editorial/orchestrator.ts`
- Create: `supabase/functions/rank-editorial/handler.ts`
- Create: `supabase/functions/rank-editorial/index.ts`
- Create: `supabase/functions/tests/rank-editorial/scoring_test.ts`
- Create: `supabase/functions/tests/rank-editorial/orchestrator_test.ts`
- Create: `supabase/functions/tests/rank-editorial/handler_test.ts`

**Interfaces:**
- Produces `calculateEditorialScore(input) -> EditorialRankingInput` with the versioned weights `35/30/15/10/10`.
- Produces `runEditorialRanking({repository, asOf, rankingDate, version}) -> EditorialRankingSummary`.
- Ranking input explicitly contains grounding, discovery, match context, and freshness; it has no performance fields.

- [ ] **Step 1: Write failing score/orchestrator/handler tests**

  Assert score normalization, verified-vs-discovery-only behavior, match context isolation, stable ties, `news_eligible` gating, persisted input snapshot contents, idempotent reruns, and no `published_posts`/`performance_metrics` references in code or snapshots.

- [ ] **Step 2: Run focused tests to verify they fail**

  Run: `deno test --allow-env --allow-net supabase/functions/tests/rank-editorial`

  Expected: FAIL because the ranking modules do not exist.

- [ ] **Step 3: Implement the pure scoring contract**

  Use the exact spec weights, cap each component to 0–100 before combining, rank by score then grounding confidence then freshness then cluster id, and set `news_eligible` only when a current claim is verified and not contradicted.

- [ ] **Step 4: Implement repository reads/writes and safe handler**

  Read only clusters, claims/evidence, discovery observations, and the existing `matches` provider data; upsert `editorial_rankings` by `(cluster, date, version)` and never query own-performance tables.

- [ ] **Step 5: Run focused, full Deno, and database tests**

  Run: `deno test --allow-env --allow-net supabase/functions/tests/rank-editorial supabase/functions/tests` and `supabase test db --local`

  Expected: PASS.

- [ ] **Step 6: Commit editorial ranking**

  ```bash
  git add supabase/functions/rank-editorial supabase/functions/tests/rank-editorial
  git commit -m "feat: add deterministic editorial ranking"
  ```

### Task 5: Connect Phase B/C to the M7 worker chain

**Files:**
- Modify: `supabase/functions/orchestration-worker/types.ts`
- Modify: `supabase/functions/orchestration-worker/worker.ts`
- Modify: `supabase/functions/orchestration-worker/boundary_client.ts`
- Modify: `supabase/migrations/20260927193000_milestone_8_phase_b_c_grounding_ranking.sql`
- Modify: `supabase/tests/database/015_m7_editorial_jobs_test.sql`
- Modify: `supabase/tests/integration/milestone_7_orchestration_integration_test.ts`
- Create: `supabase/tests/integration/milestone_8_phase_b_c_integration_test.ts`

**Interfaces:**
- Adds `DISCOVER_SOURCES`, `GROUND_CLAIMS`, and `RANK_EDITORIAL` to `EditorialJobType` and boundary map.
- Extends the downstream map exactly: `RUN_INTELLIGENCE -> DISCOVER_SOURCES -> GROUND_CLAIMS -> RANK_EDITORIAL -> GENERATE_PRIORITY`.

- [ ] **Step 1: Write failing chain/database integration tests**

  Assert all new job types are accepted by the RPC, the exact chain is enqueued once, payload chain keys/parent ids are preserved, 2xx output advances, non-2xx retries, and DEAD jobs still materialize the existing alert.

- [ ] **Step 2: Run focused tests to verify they fail**

  Run: `deno test --allow-env --allow-net supabase/tests/integration/milestone_8_phase_b_c_integration_test.ts` and `supabase test db --local`

  Expected: FAIL because the worker and SQL allowlist do not know the new stages.

- [ ] **Step 3: Implement the worker/boundary/migration changes**

  Add exact function paths, bounded request bodies, collector-secret routing, and migration allowlists. Do not add a second worker poller or alter unrelated M7 semantics.

- [ ] **Step 4: Run the full queue/worker, M7 parity, and M8 integration tests**

  Run: `deno test --allow-env --allow-net supabase/tests/integration/milestone_7_orchestration_integration_test.ts supabase/tests/integration/milestone_7_phase_2_parity_test.ts supabase/tests/integration/milestone_7_phase_3_parity_test.ts supabase/tests/integration/milestone_8_phase_b_c_integration_test.ts` and `supabase test db --local`

  Expected: PASS.

- [ ] **Step 5: Commit M7 integration**

  ```bash
  git add supabase/functions/orchestration-worker supabase/migrations/20260927193000_milestone_8_phase_b_c_grounding_ranking.sql supabase/tests
  git commit -m "feat: chain M8 grounding and ranking"
  ```

### Task 6: Consume enrichment safely in the 09:00 morning brief

**Files:**
- Modify: `supabase/functions/_shared/m6/repository.ts`
- Modify: `supabase/functions/_shared/m6/briefing.ts`
- Modify: `supabase/functions/telegram-morning-brief/index.ts`
- Modify: `supabase/functions/tests/m6/morning_brief_handler_test.ts`
- Modify: `supabase/functions/tests/m6/repository_test.ts`
- Create: `supabase/tests/integration/milestone_8_morning_brief_integration_test.ts`

**Interfaces:**
- `BriefingCandidateRow` gains optional `editorial_rank`, `grounding_status`, and `news_eligible` fields.
- `MorningBriefingSnapshot.items` persists the same safe annotations without any URL/token fields.

- [ ] **Step 1: Write failing briefing tests**

  Assert same-date editorial rankings order/annotate the existing candidates, missing or stale rankings fall back to canonical candidate ordering, 09:00 duplicate delivery remains `ALREADY_SENT`, and briefing snapshots never persist raw source bodies or performance metrics.

- [ ] **Step 2: Run focused tests to verify they fail**

  Run: `deno test --allow-env --allow-net supabase/functions/tests/m6/morning_brief_handler_test.ts supabase/functions/tests/m6/repository_test.ts supabase/tests/integration/milestone_8_morning_brief_integration_test.ts`

  Expected: FAIL because the briefing has no Phase B/C projection fields.

- [ ] **Step 3: Implement optional ranking read and frozen snapshot fields**

  Query `editorial_rankings` separately, join by `story_cluster_id`, sort by editorial rank only when the same business-date projection is complete, and retain exact current fallback behavior. Do not make the briefing wait for discovery or grounding.

- [ ] **Step 4: Run the focused M6/M8 tests and full Deno suite**

  Run: `deno test --allow-env --allow-net supabase/functions/tests/m6 supabase/tests/integration/milestone_8_morning_brief_integration_test.ts supabase/functions/tests`

  Expected: PASS.

- [ ] **Step 5: Commit 09:00 consumption**

  ```bash
  git add supabase/functions/_shared/m6 supabase/functions/telegram-morning-brief supabase/functions/tests/m6 supabase/tests/integration/milestone_8_morning_brief_integration_test.ts
  git commit -m "feat: surface grounded editorial ranking in morning brief"
  ```

### Task 7: Add local smoke, architecture validation, and operator documentation

**Files:**
- Create: `scripts/run-milestone-8-phase-b-c-smoke.sh`
- Create: `scripts/validate-m8-phase-b-c-architecture.test.mjs`
- Modify: `README.md`
- Modify: `n8n/README.md` only if the legacy boundary map needs the M8 note

- [ ] **Step 1: Write failing validator/smoke assertions**

  Require the source-role policy phrases, exact chain, 09:00 Cron ownership, no performance-table grounding, safe feed config, and no secret-like source values.

- [ ] **Step 2: Run the validator to verify it fails**

  Run: `node --test scripts/validate-m8-phase-b-c-architecture.test.mjs`

  Expected: FAIL until the implementation and documentation expose the required contracts.

- [ ] **Step 3: Implement the local smoke runner and operator docs**

  Reset local Supabase, run the full database suite, focused/full Deno tests, M7 parity, architecture validators, `git diff --check`, and explicitly reject remote URLs. Document deployment order, optional feed configuration, rollback/pause behavior, and the 09:00 production verification query.

- [ ] **Step 4: Run the complete local verification**

  Run: `./scripts/run-milestone-8-phase-b-c-smoke.sh`

  Expected: all local database/function/integration/architecture checks pass and no external provider is contacted.

- [ ] **Step 5: Commit local verification and docs**

  ```bash
  git add scripts/run-milestone-8-phase-b-c-smoke.sh scripts/validate-m8-phase-b-c-architecture.test.mjs README.md n8n/README.md
  git commit -m "docs: add M8 B/C production verification"
  ```

### Task 8: Deploy to linked production and prove the 09:00 path

**Files/External state:**
- Deploy: linked Supabase migration and Edge Functions `source-discovery`, `ground-claims`, `rank-editorial`, `orchestration-worker`, and `telegram-morning-brief`.
- Verify: linked `cron.job`, `app_private.editorial_jobs`, `app_private.editorial_rankings`, `app_private.story_claims`, and `app_private.source_observations` through service-role-safe queries.

- [ ] **Step 1: Re-run the full local smoke and inspect clean git state**

  Run: `./scripts/run-milestone-8-phase-b-c-smoke.sh`, `git diff --check`, and `git status --short --branch`.

  Expected: local suite passes; only intentional commits are present; no secrets are staged.

- [ ] **Step 2: Confirm linked production target without printing secrets**

  Run: `supabase link --project-ref <configured-ref>` only if the repository is not already linked; inspect `supabase projects list`/`supabase status` and verify the target is the intended remote project.

  Expected: a confirmed linked production project and migration history; do not deploy to an unconfirmed target.

- [ ] **Step 3: Apply the migration and deploy the five function boundaries**

  Run: `supabase db push --linked` followed by `supabase functions deploy source-discovery`, `supabase functions deploy ground-claims`, `supabase functions deploy rank-editorial`, `supabase functions deploy orchestration-worker`, and `supabase functions deploy telegram-morning-brief`.

  Expected: every command exits 0 and the remote migration history contains the M8 B/C migration.

- [ ] **Step 4: Configure only non-secret feed settings and verify function health**

  Set `SOURCE_DISCOVERY_FEEDS_JSON` and bounded source-discovery settings only when the production operator configuration is present; never print values. Invoke each new boundary with a safe empty/no-op payload using the configured invoke secret through a shell environment variable.

  Expected: authenticated 2xx safe summaries; missing optional feeds return `NOOP`; no upstream body or credential appears in output.

- [ ] **Step 5: Verify the remote 09:00 schedule and one complete chain**

  Query `cron.job` for the existing `m7-morning-brief-0900-asia-seoul`, `m7-orchestration-worker-every-minute`, and `m7-instagram-collector-every-30-minutes`; enqueue a unique Seoul-business-date smoke root through the service-role RPC; poll the job chain until terminal; inspect the same-date ranking and briefing rows.

  Expected: `0 0 * * *` remains the 09:00 Asia/Seoul root, the worker poller is active, the new stages reach `SUCCEEDED` or safe `NOOP` without `DEAD`, the morning brief reaches `SUCCEEDED`/`ALREADY_SENT`, and no performance table is touched by grounding/ranking.

- [ ] **Step 6: Commit only deployment evidence if needed and record the rollout**

  Update `README.md` with the confirmed production migration/function/schedule evidence, run `git diff --check`, and commit the operator record. Do not commit secrets, live response bodies, or identifiers that expose credentials.

