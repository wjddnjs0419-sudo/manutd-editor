# M8.6.4 Grounding Resource Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal M8.6 discovery grounding bounded, story-scoped, incrementally resumable, idempotent, and observable without changing grounding semantics or deploying production.

**Architecture:** PROMOTE_DISCOVERY returns the canonical story IDs it created or updated. The orchestration worker forwards only those IDs, a fixed `as_of`, and a bounded grounding limit to GROUND_CLAIMS; empty promotion scope ends that branch without a global scan. GROUND_CLAIMS reads a bounded keyset page from both existing claim sources, classifies prepared matcher inputs, writes through the existing upserts, and returns a continuation cursor until the page is complete. The worker uses a unique cursor-specific dedupe key while preserving the root `chain_key`.

**Tech Stack:** Supabase Edge Functions, TypeScript, Deno tests, PostgREST, existing editorial job queue and upsert contracts.

**Spec:** `/Users/jeongwonkim/.codex/attachments/8de676a4-a3c8-4f89-8de9-e68a6defece1/pasted-text-1.txt`

## Global Constraints

- Do NOT deploy to production.
- Do NOT disable M8.6 discovery cron.
- Do NOT increase retries as the primary fix.
- Do NOT redesign grounding semantics or editorial scoring/ranking semantics.
- Do NOT create a parallel grounding system or move grounding logic into SQL.
- Preserve the existing canonical M8 pipeline and DEAD alert idempotency.
- Default grounding batch limit is 25; safe maximum is 100.
- A successful empty promotion must not trigger a global GROUND_CLAIMS scan.
- `chain_key` remains the original discovery chain identity on every continuation.

## Review Focus

- Mixed extracted and discovery claims must not skip or duplicate work across a cursor; cover with a two-source pagination fixture and retry tests.
- A cursor tied to a fixed `as_of` must exclude later rows while retaining historical observations; cover both boundaries in repository tests.
- Invalid or oversized grounding input must fail safely without falling back to an unbounded scan; cover handler validation and empty-scope behavior.
- Successful downstream responses with empty or invalid bodies must not become worker failures; cover boundary parsing and promotion routing.
- Logging must expose phase timing without article contents, credentials, or full payloads; cover event order and redaction assertions.

---

### Task 1: Establish branch, baseline, and executable test seams

**Files:**
- Modify: `docs/superpowers/plans/2026-09-30-grounding-resource-hardening.md`
- Test: existing suites under `supabase/functions/tests/ground-claims`, `promote-discovery`, `orchestration-worker`, and `telegram-alerts`

**Interfaces:**
- Consumes: current M8.6 production code and test doubles.
- Produces: a clean feature branch, baseline test evidence, and disjoint test targets for the following tasks.

- [ ] **Step 1: Verify repository state and branch**

Run `git status --short --branch` and confirm the requested branch is `feat/m8-6-4-grounding-resource-hardening` with no pre-existing user changes.

- [ ] **Step 2: Run the current focused suites**

From `supabase/functions`, run `deno test --allow-env --allow-net tests/ground-claims tests/promote-discovery tests/orchestration-worker tests/telegram-alerts`. Record any baseline failures before changing implementation.

- [ ] **Step 3: Commit only the plan if the repository requires commits during execution**

Use a focused commit such as `docs: plan grounding resource hardening`; do not mix production changes into this step.

### Task 2: Promotion scope and safe boundary transport

**Files:**
- Modify: `supabase/functions/promote-discovery/types.ts`
- Modify: `supabase/functions/promote-discovery/orchestrator.ts`
- Modify: `supabase/functions/orchestration-worker/types.ts`
- Modify: `supabase/functions/orchestration-worker/boundary_client.ts`
- Test: `supabase/functions/tests/promote-discovery/orchestrator_test.ts`
- Test: `supabase/functions/tests/orchestration-worker/boundary_client_test.ts`

**Interfaces:**
- Consumes: existing promotion result counters, `BoundaryInvoker`, and job payloads.
- Produces: `PromotionSummary.affectedStoryIds: readonly string[]`; `BoundaryResult.body?: unknown` for parsed successful responses; canonical promotion-to-grounding payload fields.

- [ ] **Step 1: Add failing promotion tests**

Assert created and updated story IDs are unique, deterministic, and included in the summary; assert an empty promotion returns `affectedStoryIds: []` while all existing counters remain unchanged.

- [ ] **Step 2: Run the promotion tests and confirm the new assertions fail**

Run `deno test --allow-env --allow-net tests/promote-discovery/orchestrator_test.ts`; failure must identify the missing affected-story metadata.

- [ ] **Step 3: Implement additive promotion metadata**

Collect the returned canonical story ID once per clustered story in cluster order and include it in both the non-empty and empty `PromotionSummary` results. Do not alter counters or clustering.

- [ ] **Step 4: Add failing boundary parsing tests**

Assert successful JSON responses preserve `body`, empty bodies produce no body, and invalid JSON on a successful response returns status without throwing. Keep failed-response bodies status-only so secrets are not retained.

- [ ] **Step 5: Implement safe response-body preservation**

Read the response body once; parse only when non-empty and return parsed JSON when valid. Swallow JSON parse failures while preserving the HTTP status and existing authorization behavior.

- [ ] **Step 6: Run both focused test files**

Run the promotion orchestrator and boundary tests and confirm they pass before moving to worker routing.

### Task 3: Worker scope routing, empty-scope skip, and continuation semantics

**Files:**
- Modify: `supabase/functions/orchestration-worker/worker.ts`
- Test: `supabase/functions/tests/orchestration-worker/worker_test.ts`

**Interfaces:**
- Consumes: Task 2 `PromotionSummary` body and Task 4 `GroundingSummary` response shape.
- Produces: promotion payload `{ as_of, story_cluster_ids, limit, cursor }`, cursor-specific continuation dedupe keys, and root-chain-preserving downstream jobs.

- [ ] **Step 1: Add failing worker tests**

Cover: promotion IDs flow only into GROUND_CLAIMS; empty/absent promotion scope enqueues nothing; `PARTIAL` does not enqueue ranking and enqueues GROUND_CLAIMS with the same scope/as-of/limit and `next_cursor`; continuation dedupe keys include the cursor; the root `chain_key` is unchanged; `COMPLETED` with `has_more: false` enqueues RANK_EDITORIAL.

- [ ] **Step 2: Run worker tests and confirm the new assertions fail**

Run `deno test --allow-env --allow-net tests/orchestration-worker/worker_test.ts`; confirm failures are due to missing routing behavior rather than test setup.

- [ ] **Step 3: Implement explicit transition handling**

Keep existing transitions unchanged except PROMOTE_DISCOVERY and GROUND_CLAIMS. Use only known response fields, accept the existing camel-case response and a compatibility snake-case alias, and treat missing/empty promotion IDs as no-op. For grounding, require a cursor when more work remains and derive `root:GROUND_CLAIMS:initial` or `root:GROUND_CLAIMS:<cursor>` without mutating `payload.chain_key`.

- [ ] **Step 4: Run the complete worker suite**

Run `deno test --allow-env --allow-net tests/orchestration-worker`; update only expectations that intentionally reflect the new empty-promotion behavior.

### Task 4: Grounding request contract and stable bounded claim pages

**Files:**
- Modify: `supabase/functions/ground-claims/types.ts`
- Modify: `supabase/functions/ground-claims/handler.ts`
- Modify: `supabase/functions/ground-claims/repository.ts`
- Test: `supabase/functions/tests/ground-claims/handler_test.ts`
- Test: `supabase/functions/tests/ground-claims/repository_test.ts`

**Interfaces:**
- Consumes: optional `asOf`, optional `storyClusterIds`, bounded `limit`, and opaque `cursor`.
- Produces: `GroundingClaimPage { claims, hasMore, nextCursor }`, additive `GroundingSummary` fields `{ status: PARTIAL|COMPLETED, hasMore, nextCursor }`, and repository queries scoped by story IDs/as-of.

- [ ] **Step 1: Add failing handler validation tests**

Assert the default limit is 25, the maximum accepted limit is 100, invalid limits/IDs/cursors are rejected, and the response includes snake-case `has_more`/`next_cursor` fields for both partial and completed summaries.

- [ ] **Step 2: Add failing repository page tests**

Assert story IDs appear in the PostgREST filters, unrelated clusters are not requested, the returned page never exceeds the requested limit, `id > cursor` is used for discovery claims, and `created_at <= as_of` is present for snapshot-scoped rows.

- [ ] **Step 3: Run the new handler/repository tests and confirm they fail**

Run `deno test --allow-env --allow-net tests/ground-claims/handler_test.ts tests/ground-claims/repository_test.ts` and verify the failures are contract failures.

- [ ] **Step 4: Implement strict additive input parsing**

Allow only `as_of`, `story_cluster_ids`, `limit`, and `cursor`; use a conservative default of 25, maximum 100, bounded safe ID strings, and an explicit empty array as an empty scope rather than a global-scan signal. Preserve omitted fields for legacy direct callers.

- [ ] **Step 5: Implement the normalized two-source page**

Scope `story_cluster_posts` and `story_claims` with `story_cluster_id=in.(...)`; scope extracted content understandings through the scoped raw post IDs; apply `created_at <= as_of`; preserve all existing claim fields; sort normalized work keys deterministically (`a:<raw_post_id>:<fingerprint>` and `d:<story_claim_id>`); encode the last key in an opaque cursor; and fetch only a page-plus-one of discovery rows to detect continuation.

- [ ] **Step 6: Preserve idempotent persistence contracts**

Leave the existing claim conflict key and evidence conflict key unchanged. Do not delete prior evidence or change grounding versions, relation semantics, or source roles.

- [ ] **Step 7: Run focused grounding handler/repository tests**

Run the two files again and confirm validation, scope, keyset, as-of, and response-shape tests pass.

### Task 5: Bounded orchestrator, prepared matcher, and structured observability

**Files:**
- Modify: `supabase/functions/ground-claims/orchestrator.ts`
- Modify: `supabase/functions/ground-claims/matcher.ts`
- Modify: `supabase/functions/ground-claims/index.ts`
- Test: `supabase/functions/tests/ground-claims/orchestrator_test.ts`
- Test: `supabase/functions/tests/ground-claims/matcher_test.ts`

**Interfaces:**
- Consumes: Task 4 page/query contracts.
- Produces: bounded per-invocation processing, unchanged matcher statuses/confidence/evidence, monotonic phase logs, and logical event ordering.

- [ ] **Step 1: Add failing orchestrator tests**

Assert at most 25 claims are classified/written by default, partial pages return a cursor, completed pages return `next_cursor: null`, retrying a page preserves claim/evidence upsert idempotency, and structured events appear in start/load/match/write/complete order with timing fields.

- [ ] **Step 2: Add matcher equivalence tests**

Assert prepared claim/observation classification matches representative current outputs for verified, discovery-only, contradicted, ignored-role, and unrelated-entity cases.

- [ ] **Step 3: Run grounding orchestrator and matcher tests and confirm failures**

Run `deno test --allow-env --allow-net tests/ground-claims/orchestrator_test.ts tests/ground-claims/matcher_test.ts` before adding production implementation.

- [ ] **Step 4: Implement bounded orchestration**

Load one `GroundingClaimPage` and the observation set, prepare observations once, classify only that page, write each claim/evidence through existing upserts, aggregate counters, and return `PARTIAL` exactly when `hasMore` is true. Track `LOAD`, `MATCH`, and `WRITE` phases with `performance.now()` and emit safe fields only.

- [ ] **Step 5: Implement matcher preprocessing**

Add prepared claim/observation representations containing normalized haystacks, token sets, and strong anchors. Reuse the exact existing thresholds, aliases, ignored roles, FACT roles, confidence rounding, evidence filtering, and contradiction precedence.

- [ ] **Step 6: Wire request IDs and safe logs through the Edge handler**

Pass the handler request ID into the run, emit `ground_claims_failed` with phase/error code on failure, and keep logs free of secrets and article bodies.

- [ ] **Step 7: Run all ground-claims tests**

Run `deno test --allow-env --allow-net tests/ground-claims`; inspect output for failures, warnings, and accidental sensitive payloads.

### Task 6: Regression fixture, alert invariants, and full validation

**Files:**
- Modify: `supabase/functions/tests/telegram-alerts/dead_alerts_test.ts` only if coverage is missing
- Modify: relevant focused test files for the deterministic 350-claim/120-observation fixture
- No production changes to `supabase/functions/telegram-alerts/dead_alerts.ts`

**Interfaces:**
- Consumes: all completed implementation tasks.
- Produces: regression evidence for resource bounds, DEAD alert identity, M8.6 smoke, architecture checks, and whitespace correctness.

- [ ] **Step 1: Add the synthetic bounded fixture**

Create deterministic claims across multiple stories and observations; request two story clusters with limit 25; assert unrelated claims are untouched, no page processes over 25 claims, and partial continuation is reported.

- [ ] **Step 2: Add or retain DEAD alert identity tests**

Assert two different DEAD job IDs materialize as two alerts and repeating the same job ID materializes no second alert. Do not modify the idempotency implementation.

- [ ] **Step 3: Run the requested focused test command**

From `supabase/functions`, run `deno test --allow-env --allow-net tests/ground-claims tests/promote-discovery tests/orchestration-worker tests/telegram-alerts` and record exact results.

- [ ] **Step 4: Run the M8.6 smoke script**

Run `./scripts/run-milestone-8-6-smoke.sh` and record exact results without changing cron definitions.

- [ ] **Step 5: Run architecture tests**

Run the five requested `node --test scripts/validate-*.test.mjs` files and record exact results.

- [ ] **Step 6: Run `git diff --check` and inspect the final diff**

Confirm no production deployment, retry increase, cron disablement, DEAD alert weakening, unrelated ranking changes, or secret/full-content logging is present.

### Task 7: Final production verification plan (documentation only)

**Files:**
- Modify: final report only; no deployment or production-state changes

**Interfaces:**
- Consumes: exact local test output and code diff.
- Produces: a report stating the root cause, files changed, batch/cursor design, scope flow, continuation/dedupe behavior, idempotency, matcher optimization, as-of semantics, logs, tests, and explicit non-deployment status.

- [ ] **Step 1: State whether the HTTP 546 subtype is proven**

Do not claim CPU, memory, or wall-clock termination without correlating production `function_edge_logs` and `function_logs` by `execution_id`.

- [ ] **Step 2: Include the post-deploy verification checklist without executing it**

Document normal deployment, unchanged discovery cadence, successful batch/continuation/ranking sequence, no 546/DEAD alert, correct `/current` and alert behavior, phase metrics, and p50/p95 observation plan.
