# M8.5 Trend Discovery Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, observable Manchester United trend discovery that feeds canonical stories into existing M8 grounding/ranking and Telegram editorial workflows.

**Architecture:** Add pure discovery contracts, query expansion, relevance, scoring, provider isolation, and clustering helpers under `supabase/functions/trend-discovery`. Persist additive run/query/observation/snapshot records in `app_private`, then extend the existing console and worker chain without replacing M8 contracts.

**Tech Stack:** Deno 2 Edge Functions, TypeScript, Supabase Postgres migrations/Data API, existing M8 repositories and Telegram console.

**Spec:** `docs/superpowers/specs/2026-09-27-milestone-8-5-trend-discovery-design.md` and the user-provided M8.5 request.

## Global Constraints

- Preserve existing M7 orchestration, M8 grounding, editorial ranking, morning brief, Telegram console, creative generation, slash commands, and unrelated natural-language behavior.
- Keep Trend Score separate from Editorial Score; use versioned deterministic weights.
- Community, competitor, and video popularity is discovery evidence only; only fact roles may ground claims.
- Use bounded providers and safe per-provider failure isolation; do not add brittle scraping or download copyrighted footage.
- Preserve nullable `published_at`; use `observed_at` conservatively when publication time is unavailable.
- Do not deploy remote production changes.

## Review Focus

- Repeated provider items must not inflate mentions or create duplicate canonical stories — tests in Tasks 1 and 3.
- Missing engagement and missing publication time must remain explicit/conservative — tests in Task 2.
- Secondary Manchester United mentions must be rejected using existing anchoring behavior — tests in Task 2.
- Discovery evidence must never become factual grounding — tests in Tasks 3 and 5.
- A partial provider failure must preserve successful results and deterministic status — tests in Tasks 3 and 4.

---

### Task 1: Discovery contracts, query expansion, and migration

**Files:**
- Create: `supabase/functions/trend-discovery/types.ts`
- Create: `supabase/functions/trend-discovery/query_expansion.ts`
- Test: `supabase/functions/tests/trend-discovery/query_expansion_test.ts`
- Modify: `supabase/migrations/20260927230000_m8_5_trend_discovery.sql`

**Interfaces:**
- Produces `DiscoveryMode`, `DiscoveryQuery`, `DiscoveryObservation`, `TrendSnapshot`, `DiscoveryProvider`, and `expandDiscoveryQueries(input)`.

- [ ] **Step 1: Write failing tests** for the bounded topic families, dynamic entity context, mode windows, and stable query IDs.
- [ ] **Step 2: Run `deno test supabase/functions/tests/trend-discovery/query_expansion_test.ts -v` and observe missing-module failure.**
- [ ] **Step 3: Implement strict contracts and deterministic query expansion; add additive private tables with RLS, service-role-only grants, provider/query/fingerprint indexes, and trend columns needed by later tasks.**
- [ ] **Step 4: Run the focused test and verify it passes.**
- [ ] **Step 5: Commit `feat: add m8.5 discovery contracts and query expansion`.**

### Task 2: Trend scoring, states, relevance, and clustering helpers

**Files:**
- Create: `supabase/functions/trend-discovery/scoring.ts`
- Create: `supabase/functions/trend-discovery/relevance.ts`
- Create: `supabase/functions/trend-discovery/clustering.ts`
- Test: `supabase/functions/tests/trend-discovery/scoring_test.ts`
- Test: `supabase/functions/tests/trend-discovery/clustering_test.ts`

**Interfaces:**
- Consumes Task 1 observation contracts and existing M8 relevance semantics.
- Produces `calculateTrendScore`, `deriveTrendState`, `deriveOpportunityLabels`, `clusterObservations`, and separate `trend_score`/`editorial_score` fields.

- [ ] **Step 1: Write failing tests** for score weights, acceleration/decline, source diversity, unavailable engagement, novelty saturation, all six states, relevance rejection, and duplicate clustering.
- [ ] **Step 2: Run both focused tests and observe missing-module failure.**
- [ ] **Step 3: Implement normalized deterministic scoring, conservative freshness, source/platform diversity, novelty penalties, bounded state thresholds, and fingerprint/title-token clustering.**
- [ ] **Step 4: Run focused tests and verify they pass.**
- [ ] **Step 5: Commit `feat: add deterministic m8.5 trend scoring`.**

### Task 3: Provider abstraction, normalization, and discovery run orchestration

**Files:**
- Create: `supabase/functions/trend-discovery/providers.ts`
- Create: `supabase/functions/trend-discovery/normalization.ts`
- Create: `supabase/functions/trend-discovery/orchestrator.ts`
- Create: `supabase/functions/trend-discovery/repository.ts`
- Create: `supabase/functions/trend-discovery/handler.ts`
- Create: `supabase/functions/trend-discovery/index.ts`
- Test: `supabase/functions/tests/trend-discovery/orchestrator_test.ts`
- Test: `supabase/functions/tests/trend-discovery/handler_test.ts`

**Interfaces:**
- Consumes Tasks 1–2 contracts and existing `source-discovery` feed parser/repository patterns.
- Produces `runTrendDiscovery(options)` with per-provider statuses and safe counts, plus authenticated `trend-discovery` Edge Function boundary.

- [ ] **Step 1: Write failing tests** for normalization, provider failure isolation, idempotent observation persistence, run observability, and safe empty/partial results.
- [ ] **Step 2: Run focused tests and observe missing-module failure.**
- [ ] **Step 3: Implement providers as injected modular adapters, reuse bounded feed collection for the first RSS/Atom/HTML adapter, normalize without raw payloads, persist run/query/observation metadata, and never fail the run for one provider.**
- [ ] **Step 4: Run focused tests and verify they pass.**
- [ ] **Step 5: Commit `feat: add isolated m8.5 discovery runs`.**

### Task 4: M8.5 worker boundary and orchestration integration

**Files:**
- Modify: `supabase/functions/orchestration-worker/types.ts`
- Modify: `supabase/functions/orchestration-worker/worker.ts`
- Modify: `supabase/functions/orchestration-worker/boundary_client.ts`
- Modify: `supabase/migrations/20260927230000_m8_5_trend_discovery.sql`
- Test: `supabase/functions/tests/orchestration-worker/worker_test.ts`
- Test: `supabase/functions/tests/orchestration-worker/boundary_client_test.ts`

**Interfaces:**
- Consumes Task 3 `trend-discovery` boundary.
- Produces `DISCOVER_TRENDS` job support while preserving existing `DISCOVER_SOURCES` and downstream M8 stages.

- [ ] **Step 1: Write failing tests** for job type validation, boundary routing, exactly-once dedupe, and failure/dead-letter preservation.
- [ ] **Step 2: Run focused tests and observe failure.**
- [ ] **Step 3: Add the additive `DISCOVER_TRENDS` stage, route it after source discovery before grounding/ranking, and retain current stage behavior for existing jobs.**
- [ ] **Step 4: Run focused tests and verify they pass.**
- [ ] **Step 5: Commit `feat: enqueue m8.5 trend discovery in worker chain`.**

### Task 5: Trend-ranked canonical repository and Telegram console actions

**Files:**
- Modify: `supabase/functions/_shared/m6/editorial_console.ts`
- Modify: `supabase/functions/_shared/m6/editorial_console_actions.ts`
- Modify: `supabase/functions/telegram-agent/index.ts`
- Test: `supabase/functions/tests/m6/editorial_console_test.ts`
- Test: `supabase/functions/tests/m6/editorial_console_actions_test.ts`
- Test: `supabase/functions/tests/m6/commands_test.ts`

**Interfaces:**
- Consumes persisted trend snapshots and existing canonical/editorial rows.
- Produces `OPEN_TRENDING`, `DISCOVER_MORE`, `REFRESH_DISCOVERY`, trend pagination, transparent discovery/fact detail sections, and deterministic Korean natural-language mappings.

- [ ] **Step 1: Write failing tests** for trend ordering independent of editorial rank, five-item pagination, trend detail copy, callback parsing, discover-more invocation/status, and natural-language intents.
- [ ] **Step 2: Run focused tests and observe failure.**
- [ ] **Step 3: Extend state/actions/repository rendering additively; invoke the trend discovery boundary for `DISCOVER_MORE`, store run status, and keep creative actions unchanged.**
- [ ] **Step 4: Run focused tests and verify they pass.**
- [ ] **Step 5: Commit `feat: expose m8.5 trends in telegram console`.**

### Task 6: Architecture documentation, smoke checks, and full verification

**Files:**
- Modify: `README.md`
- Create: `scripts/validate-m8-5-trend-discovery-architecture.test.mjs`
- Create: `scripts/run-milestone-8-5-smoke.sh`
- Test: `supabase/functions/tests/trend-discovery/*.ts`

- [ ] **Step 1: Add docs for discovery vs grounding, provider status, scoring, rollout, and disabled providers.**
- [ ] **Step 2: Add architecture assertions for migration, function, worker, console, and no-secret/no-footage-download constraints.**
- [ ] **Step 3: Run all focused M8.5 tests, all existing Deno tests, architecture validators, and smoke checks; fix failures with RED→GREEN tests.**
- [ ] **Step 4: Run `git diff --check`, inspect migration/RLS and changed-file diff, and report provider implementations/disabled adapters separately.**
- [ ] **Step 5: Commit `docs: document m8.5 trend discovery rollout`.**
