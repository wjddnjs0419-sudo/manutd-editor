# Google News Existing Observation Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update already-linked Google News source observations with safe resolver results while prioritizing recent Manchester United coverage and keeping historical work bounded.

**Architecture:** The resolver completion transaction updates discovery status and, through the existing `source_observation_id`, only resolver-owned URL/body metadata on an already-linked source row. Claim mode is explicit: normal runs cover the latest 72 hours with the latest 24 hours first; a manual backfill claims older rows in one capped batch. M8 keeps its existing promotion path for fresh unassigned observations, and M9 reads the publisher URL already stored on the source observation.

**Tech Stack:** Supabase Postgres migration, pgTAP, Supabase Edge Functions (Deno/TypeScript), Python worker tests, existing M9 source request builder.

**Spec:** `docs/gnews-resolution-pipeline-runbook.md` plus the user request in this task.

## Global Constraints

- Never run DDL or writes against the production Supabase project.
- Preserve Google News wrapper URL, provider identity, `story_cluster_id`, `source_observation_id`, source identity, claim/evidence links, and publication state.
- Never create a story or source observation during resolver completion.
- Body extraction is successful only with a non-empty validated excerpt; resolver completion never upgrades a claim to `VERIFIED`.
- Normal resolver mode is limited to 72 hours and orders the latest 24 hours first; backfill is explicit and claims at most one batch of 30.
- Keep PR #10 Draft and based on PR #9 until PR #9 merges. Do not alter PR #8 Telegram automation or activate Google News, schedules, or production deployment.

## Review Focus

- A resolved already-assigned observation with an existing source ID updates the same source row and leaves story/evidence state unchanged (Task 1 pgTAP).
- A missing/empty body cannot set extraction success or replace the existing excerpt with null/empty data (Task 1 pgTAP).
- Replaying claim and completion requests is idempotent and does not add stories or source rows (Task 1 pgTAP).
- A 429 cooldown and 403 response preserve their separate status semantics, while expired leases can be reclaimed (Task 1 pgTAP).
- M9 receives only the publisher URL after refresh and retains the Google URL as provenance (Task 3 M9 tests and staging check).

---

### Task 1: Database refresh, freshness modes, and pgTAP

**Files:**
- Modify: existing unpublished PR #10 migration `supabase/migrations/20261011174908_gnews_resolution_pipeline.sql`
- Modify: `supabase/tests/database/024_gnews_resolver_pipeline_test.sql`

**Interfaces:**
- Resolver claim RPC accepts a required mode: `recent` or `backfill`.
- Recent claims use an effective publication/first-observed timestamp in `[now() - 72 hours, now()]`, ordering the most recent 24 hours first and then newest-first.
- Backfill claims older rows, oldest-first, with the existing 30-row maximum and one batch per invocation.
- Completion refreshes only the linked source row found through the existing source ID; no inserts or relationship/status changes.

- [x] Add pgTAP cases for linked-source refresh, non-empty-body success, no-body/403 preservation, Google 429 cooldown, idempotency, recent ordering, backfill selection, and expired-lease recovery.
- [x] Update the existing unpublished migration with mode-aware claims and transactional linked-source refresh.
- [x] Apply all migrations to isolated local Docker Supabase `gnews_staging_release_20261012`; run all 70 assertions in 024 pgTAP.

### Task 2: Worker and API mode contract

**Files:**
- Modify: `supabase/functions/gnews-resolver-api/handler.ts`
- Modify: `supabase/functions/tests/gnews-resolver-api/handler_test.ts`
- Modify: `scripts/gnews_resolver_worker.py`
- Modify: `scripts/test_gnews_resolver_worker.py`
- Modify: `.github/workflows/gnews-resolver-worker.yml`

- [x] Add tests for default `recent`, explicit `backfill`, invalid modes, and one-batch limits.
- [x] Add the request mode contract and manual workflow choice with default `recent`.
- [x] Run focused Deno and Python tests (13 Deno, 39 Python passed).

### Task 3: M8 freshness and M9 publisher handoff

**Files:**
- Modify: `supabase/functions/promote-discovery/repository.ts`
- Modify: `supabase/functions/tests/promote-discovery/repository_test.ts`
- Modify: `scripts/tests/test_m9_source_request_from_brief.py`
- Modify: `supabase/tests/database/024_gnews_resolver_pipeline_test.sql`

- [x] Add assertions that M8 returns newest fresh unassigned articles first and leaves already-assigned rows to the resolver refresh path.
- [x] Add an M9 request assertion using the refreshed source row, with the publisher URL in article input and the Google wrapper only in provenance.
- [x] Verify actual unassigned-observation promotion on disposable/staging via PostgREST, then build M9 input from the persisted source row. Existing linked-row refresh is covered by pgTAP.
- [x] Run the focused M8/M9 suites (13 Deno and 39 Python tests passed, including 9 M9 cases).

### Task 4: Runbook, PR stack, and final verification

**Files:**
- Modify: `docs/gnews-resolution-pipeline-runbook.md`
- Modify: `docs/google-news-publisher-extraction.md`

- [x] Document the 24/72-hour priority, one-batch backfill mode, linked-source update behavior, and explicit PR #9 → #10 merge/rebase sequence.
- [x] Run requested tests and migration/pgTAP verification; inspect the diff. PR #10 remains Draft on the PR #9 base.
