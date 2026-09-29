# M8.6 Personal Editorial Assistant Implementation Plan

> **For agentic workers:** Coordinator-led execution with parallel Round 1 workers. Shared orchestration files remain coordinator-owned.

**Goal:** Extend the existing M7/M8/M8.5 ManUtd Editor pipeline into an additive personal editorial assistant without replacing existing discovery, grounding, ranking, fixture, or Notion contracts.

**Architecture:** Round 1 implements independent Instagram monitoring, tracked-entity context/cadence, free news providers, and match-assistant helpers in disjoint files. The coordinator then integrates their contracts through Supabase migrations, seed data, discovery/worker scheduling, promotion, alerts, and documentation. Promotion is stabilized before proactive alerting; full regression runs only after integration.

**Tech Stack:** Supabase SQL migrations/RLS, Deno TypeScript Edge Functions, deterministic fixtures, Node architecture validators, shell smoke scripts.

**Spec:** `/Users/jeongwonkim/.codex/attachments/13b30431-72bb-42ce-92cf-12b3af489422/pasted-text-1.txt`

## Global Constraints

- Preserve M7, M8, and M8.5 behavior and tests; extend additively.
- Work only on `feat/m8-6-editorial-assistant`; do not modify or deploy `main` or production.
- Supabase remains canonical state; Notion is optional projection/archive.
- No new paid API, secrets, arbitrary crawling, media downloads, or automatic social publishing.
- Provider calls are fixed-host HTTPS, bounded, timed out, and failure-isolated.
- Discovery-only evidence must never become `VERIFIED` or pass the existing creative evidence gate.
- Shared orchestration files are coordinator-owned: `supabase/functions/trend-discovery/orchestrator.ts`, `handler.ts`, `repository.ts`, `index.ts`; `supabase/functions/orchestration-worker/*`; scheduling/editorial-job migrations; `supabase/seed.sql`; README; validators and milestone smoke scripts.

## Review Focus

- Repeated discovery runs must not duplicate observations, canonical stories, or alerts.
- Official `@manutd` must never inflate competitor saturation.
- `api_supported=false` accounts must stop being retried while `NULL` remains probeable.
- Missing provider timestamps must remain `published_at = null`, not be replaced with observation time.
- Discovery-only claims, stale/missing match context, and Notion failures must fail safe without blocking canonical workflows.

### Task 1: Round 1 — Instagram monitoring pool

**Owner:** Agent A

**Write scope:** `supabase/migrations/20260929*_m8_6_instagram_monitoring.sql`, `supabase/functions/collect-instagram/repository.ts`, and focused collect-instagram repository tests only. Do not edit shared orchestration, seed, README, validators, or schedules.

**Deliverable:** Additive monitor-role migration and account-selection behavior that skips known unsupported accounts after a probe while preserving historical rows. Return the exact migration/seed contract and focused test command.

### Task 2: Round 1 — tracked entity context and cadence

**Owner:** Agent B

**Write scope:** `supabase/migrations/20260929*_m8_6_tracked_entities.sql`, `supabase/functions/trend-discovery/entity_context.ts`, `query_expansion.ts`, `types.ts`, and focused trend-discovery entity/query tests only. Do not edit trend-discovery orchestration/repository/handler/index, scheduling, seed, README, validators, or worker files.

**Deliverable:** Canonical resolver contract, first-team/manager data shape, FAST/PLAYER_SWEEP/MANUAL query profiles, bounded HOT expansion, and hot expiry/extension logic. Avoid hard-coding seed SQL in shared files; report seed rows for coordinator integration.

### Task 3: Round 1 — free search providers

**Owner:** Agent C

**Write scope:** `supabase/functions/trend-discovery/google_news_provider.ts`, `gdelt_provider.ts`, `provider_router.ts`, provider-local config/helpers, and focused provider tests only. Do not edit trend-discovery types/orchestrator/repository/handler/index, scheduling, seed, README, validators, or worker files.

**Deliverable:** Bounded Google News RSS and GDELT providers plus routing and failure isolation. Preserve missing publication timestamps and never fetch arbitrary hosts.

### Task 4: Round 1 — match personal assistant helpers

**Owner:** Agent F

**Write scope:** new `supabase/functions/_shared/m6/match_assistant.ts`, focused m6 match-assistant tests, and only additive changes inside `supabase/functions/_shared/m6/match_calendar.ts` if required for the projection contract. Do not edit worker orchestration, fixture-sync scheduling, seed, README, validators, or shared alert migrations.

**Deliverable:** Asia/Seoul D-1/D-DAY phase helper, complete match context shape, once-only/kickoff-change decision helpers, and non-critical Notion projection wrapper contract.

### Task 5: Coordinator integration — contracts, discovery scheduling, and promotion (D)

**Owner:** Coordinator

**Deliverable:** Integrate Round 1 contracts; add seed and migrations; wire independent FAST/PLAYER_SWEEP roots and worker chain; implement `PROMOTE_DISCOVERY` with idempotent attach/create, conservative signature, non-verified claims, and editorial representation; add focused promotion/architecture tests.

### Task 6: Proactive Telegram assistant (E)

**Owner:** Coordinator

**Deliverable:** Add deterministic BREAKING/RISING/VERIFIED transition alerts, fingerprints/cooldowns, grounded Telegram actions, and tests after the promotion contract is stable.

### Task 7: Documentation and final verification

**Owner:** Coordinator

**Deliverable:** Update README and add M8.6 validator/smoke. Run focused Round 1 tests after each agent returns, integration tests after D/E, then full Deno regression, architecture validators, DB tests, smoke scripts, and `git diff --check`.
