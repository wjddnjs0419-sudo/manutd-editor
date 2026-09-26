# Milestone 7 Phase 3 Decoupling, Observability, and Legacy Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Supabase the complete M7 runtime by decoupling creative generation from Notion, exposing editorial-job health and dead-letter alerts, proving M1–M6 parity without n8n, and marking n8n as legacy.

**Architecture:** `creative_briefs.status = READY` remains the canonical creative-generation success boundary. A database trigger idempotently enqueues a new `PROJECT_NOTION` editorial job; a separate `project-notion` Edge Function consumes it and owns all Notion credentials and projection behavior. Editorial-job observability is exposed through a compact service-role-only view/RPC, while a DEAD transition writes a durable outbox that materializes into the existing `telegram_alert_events` contract exactly once.

**Tech Stack:** Supabase Postgres 17, pgTAP, Supabase Edge Functions on Deno 2.1.4, TypeScript, REST/PostgREST, shell smoke tests, and Markdown documentation.

**Spec:** User-provided M7-09 through M7-12 requirements in the active conversation.

## Global Constraints

- n8n can be completely disabled for the required production path.
- Supabase is the canonical database, orchestration layer, scheduler, and Edge Function runtime.
- Telegram uses the direct `telegram-agent` webhook; n8n is legacy and not required.
- Creative generation success is determined by the canonical READY brief and does not require Notion availability.
- Notion projection remains independent and retryable; Figma is not implemented.
- No production deployment, webhook registration, or secret value is permitted.
- No secrets are committed, logged, returned, or persisted in payloads/error bodies.
- Existing M1–M6 behavior and test suites remain passing.
- Existing n8n workflow files and useful validators/fixtures are retained as historical artifacts.

## Review Focus

- Notion is unavailable at creative-generation startup or during projection; the READY result must still succeed and projection must retry independently.
- A READY brief is inserted twice or a projection job is retried; only one logical `PROJECT_NOTION` job and one alert event may exist.
- A DEAD job has no Telegram thread yet; the dead state must not roll back and the durable outbox must later materialize into the existing alert table.
- A failed/retried job, a running lease, and a pending job with an old timestamp must all appear in the compact status contract with correct counts and age.
- Legacy n8n validation is retained for history but must not be required by the main M7 smoke/production path.

---

### Task 1: Decouple Creative Generation and Add the Notion Projection Consumer

**Files:**
- Create: `supabase/functions/project-notion/handler.ts`
- Create: `supabase/functions/project-notion/index.ts`
- Create: `supabase/functions/project-notion/orchestrator.ts`
- Create: `supabase/functions/tests/project-notion/handler_test.ts`
- Create: `supabase/functions/tests/project-notion/orchestrator_test.ts`
- Modify: `supabase/functions/creative-generation/index.ts`
- Modify: `supabase/functions/creative-generation/repository.ts`
- Modify: `supabase/functions/orchestration-worker/types.ts`
- Modify: `supabase/functions/orchestration-worker/boundary_client.ts`
- Modify: `supabase/functions/orchestration-worker/worker.ts` only if the new consumer requires an explicit stage map entry
- Modify: `supabase/config.toml`
- Test: `supabase/functions/tests/creative-generation/orchestrator_test.ts`

**Interfaces:**
- `PROJECT_NOTION` is an `EditorialJobType` and maps to `/functions/v1/project-notion` with the collector invoke secret.
- `project-notion` accepts an authenticated POST body `{ "creative_brief_id": string }` and returns only safe projection metadata.
- Creative generation no longer imports or constructs a Notion client and never calls Notion during its READY transaction.
- The READY-brief database trigger in Task 2 supplies `PROJECT_NOTION` work for direct, priority, and selected generation paths.

- [x] **Step 1: Write failing tests**

  Assert the creative-generation entrypoint has no Notion dependency, the generation orchestrator returns READY when the projection consumer is absent, the project-notion handler validates/authenticates its brief payload, and the project-notion orchestrator projects an existing READY brief while saving pipeline state. Add a boundary-client assertion for the new job type and a retry-safe projection failure assertion.

- [x] **Step 2: Run focused tests and verify RED**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/creative-generation/orchestrator_test.ts functions/tests/project-notion functions/tests/orchestration-worker/boundary_client_test.ts`

  Expected: FAIL because the independent consumer and `PROJECT_NOTION` contract do not exist and creative-generation still constructs Notion at startup.

- [x] **Step 3: Implement the independent consumer**

  Move the existing Content Pipeline projection composition into the `project-notion` boundary, add a focused brief lookup to the generation repository, keep Notion state persistence in that consumer, and remove `projectReady`/Notion construction from `creative-generation/index.ts`. Add the worker boundary mapping without changing the existing intelligence/selected-poll chain.

- [x] **Step 4: Run focused tests and verify GREEN**

  Rerun the focused command and confirm the READY path succeeds without `NOTION_TOKEN` or Notion API calls, while projection errors are returned as safe downstream failures for the editorial queue to retry.

- [x] **Step 5: Commit the decoupling task**

  Run: `git add supabase/functions/creative-generation supabase/functions/project-notion supabase/functions/orchestration-worker supabase/functions/tests/project-notion supabase/functions/tests/creative-generation/orchestrator_test.ts supabase/config.toml && git commit -m "feat: decouple creative generation from notion"`

---

### Task 2: READY Consumer Enqueue, Editorial Observability, and DEAD Telegram Alerts

**Files:**
- Create: `supabase/migrations/<generated>_milestone_7_phase_3_observability.sql`
- Create: `supabase/tests/database/017_m7_phase_3_observability_test.sql`
- Modify: `supabase/functions/orchestration-worker/types.ts`
- Modify: `supabase/functions/orchestration-worker/queue_client.ts` if materialization needs a queue adapter
- Modify: `supabase/functions/telegram-alerts/index.ts`
- Test: `supabase/functions/tests/telegram-alerts/handler_test.ts` if the materialization boundary is isolated there

**Interfaces:**
- READY briefs enqueue one `PROJECT_NOTION` job with dedupe key `creative-brief:<brief_id>:PROJECT_NOTION` and payload containing only canonical IDs/stage metadata.
- `public.editorial_job_status` exposes `pending_count`, `running_count`, `failed_retry_count`, `dead_count`, `oldest_pending_age_seconds`, `last_successful_instagram_pipeline`, `last_successful_intelligence_run`, and `last_morning_brief`.
- `public.get_editorial_job_status()` returns the same one-row status contract and is executable only by `service_role`.
- A transition to DEAD creates one durable dead-alert outbox record and, when a Telegram owner thread exists, one existing-compatible `app_private.telegram_alert_events` row with event type `EDITORIAL_JOB_DEAD` and fingerprint `EDITORIAL_JOB_DEAD:<job_id>`.
- If no thread exists at the DEAD transition, `telegram-alerts` materializes the outbox later using `TELEGRAM_OWNER_THREAD_ID`; the DEAD job remains DEAD and is never re-alerted under the same fingerprint.

- [x] **Step 1: Write failing pgTAP and alert tests**

  Assert the new job type/trigger/idempotency, status view/RPC columns and values, service-role-only access, DEAD transition/outbox behavior, existing alert event compatibility, no duplicate event on repeated DEAD updates, and later materialization into the configured owner thread. Add a focused TypeScript test for safe materialization and no repeated insert.

- [x] **Step 2: Run database tests and verify RED**

  Run: `supabase db reset --local && supabase test db --local supabase/tests/database/017_m7_phase_3_observability_test.sql`

  Expected: FAIL because `PROJECT_NOTION`, the READY trigger, status contract, and dead-alert outbox do not exist.

- [x] **Step 3: Implement the migration**

  Extend the editorial-job constraint, add the READY enqueue trigger, add the compact status view and RPC with bounded timestamps/counts, extend the Telegram event type constraint, add the durable dead-alert outbox/materialization RPC, and register only service-role execution. Keep all trigger/RPC search paths explicit and avoid secrets in SQL.

- [x] **Step 4: Implement alert materialization**

  Make `telegram-alerts` call the materialization RPC before reading pending events. Use the existing `telegram_alert_events` dispatcher for delivery and the unique fingerprint as the non-repeating boundary. Persist only safe job identifiers, type, attempt count, and error category/message bounds.

- [x] **Step 5: Run focused tests and verify GREEN**

  Run: `supabase db reset --local && supabase test db --local supabase/tests/database/017_m7_phase_3_observability_test.sql` and the focused Deno alert tests. Confirm all status fields and one-time DEAD alert assertions pass.

- [x] **Step 6: Commit the observability task**

  Run: `git add supabase/migrations supabase/tests/database/017_m7_phase_3_observability_test.sql supabase/functions/telegram-alerts supabase/functions/tests/telegram-alerts supabase/functions/orchestration-worker && git commit -m "feat: add editorial job observability"`

---

### Task 3: Full M1–M6 Parity Integration Without n8n

**Files:**
- Create: `supabase/tests/integration/milestone_7_phase_3_parity_test.ts`
- Modify: `scripts/run-milestone-7-smoke.sh`
- Modify: `supabase/tests/integration/milestone_7_phase_2_parity_test.ts` only if shared setup is extracted
- Test: existing M1–M6 Deno and pgTAP suites

**Interfaces:**
- The parity test runs entirely against the local Supabase queue/RPCs with deterministic fake downstream boundaries and no Meta, OpenAI, Notion, Telegram, n8n, or remote Supabase calls.
- It exercises collection orchestration, intelligence, creative READY trigger, independent Notion failure/recovery, Telegram alert dispatch, fixture sync, 09:00 brief, direct webhook, dedupe, retry, and recovery.

- [x] **Step 1: Write the failing parity test**

  Build one deterministic scenario that enqueues the schedule roots, drains the worker chain, inserts a READY brief, observes `PROJECT_NOTION`, forces one Notion failure and a later success, forces one retry and recovery, verifies fixture success creates alert dispatch, verifies morning brief is terminal, sends a direct Telegram update twice, and asserts the second update is short-circuited before agent execution. Assert the status RPC reflects the final successful runs and no DEAD alert duplicates.

- [x] **Step 2: Run the parity test and verify RED**

  Run: `supabase db reset --local && docker run --rm --add-host=host.docker.internal:host-gateway -e SUPABASE_URL="$LOCAL_SUPABASE_URL" -e SUPABASE_SECRET_KEY="$LOCAL_SUPABASE_SECRET_KEY" -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env --allow-net tests/integration/milestone_7_phase_3_parity_test.ts`

  Expected: FAIL because the new consumer/observability path is not wired.

- [x] **Step 3: Implement the smallest parity fixture and smoke changes**

  Use injected boundary results and existing local REST queue helpers; keep the test deterministic and avoid production-only credentials. Remove n8n validation from the required M7 smoke path while retaining the standalone validator and fixture scripts for historical checks.

- [x] **Step 4: Run the parity test and full local smoke**

  Run the focused parity test, then `./scripts/run-milestone-7-smoke.sh`. Confirm the smoke script resets only local state and the test output contains no secret-like values.

- [x] **Step 5: Commit the parity task**

  Run: `git add supabase/tests/integration/milestone_7_phase_3_parity_test.ts scripts/run-milestone-7-smoke.sh && git commit -m "test: prove n8n-free milestone parity"`

---

### Task 4: Mark n8n Legacy and Update Architecture Documentation

**Files:**
- Modify: `n8n/README.md`
- Modify: `README.md`
- Modify: `.env.example` if any new non-secret operational variable is documented
- Test: `scripts/validate-n8n-workflow.test.mjs` and existing workflow fixtures remain unchanged and runnable

**Interfaces:**
- Root architecture explicitly states: Supabase is canonical database, orchestration layer, scheduler, and Edge Function runtime; Telegram uses direct webhook; n8n is legacy/not required.
- `n8n/README.md` explains why n8n existed, the M7 replacement for every historical workflow, and the temporary rollback/import path without suggesting it is required.
- Main required production verification no longer invokes n8n validation; historical validation remains an optional compatibility check.

- [x] **Step 1: Write documentation contract checks**

  Add shell/Node assertions for the required architecture phrases, legacy marker, workflow-to-M7 replacement map, rollback guidance, no production deployment claim, and removal of n8n validation from the required smoke command.

- [x] **Step 2: Run checks and verify RED**

  Run the documentation checks and confirm they fail against the current wording, which still presents historical n8n paths as active in places.

- [x] **Step 3: Update both READMEs**

  Add the M7 final architecture and acceptance checklist to the root README. Mark `n8n/README.md` as LEGACY, preserve all exports, describe rollback as a temporary operational choice, and point required operators to Supabase Cron, the worker, direct Telegram webhook, and status/dead-letter observability.

- [x] **Step 4: Run checks and historical validator tests**

  Run the documentation contract checks and `node --test scripts/validate-n8n-workflow.test.mjs`. Confirm historical fixtures still validate while the main smoke path does not depend on them.

- [x] **Step 5: Commit the legacy transition task**

  Run: `git add README.md n8n/README.md scripts/validate-n8n-workflow.test.mjs && git commit -m "docs: mark n8n workflows as legacy"`

---

### Task 5: Full Verification and Acceptance Ledger

**Files:**
- Modify: `docs/superpowers/plans/2026-09-27-milestone-7-phase-3-decoupling-observability-legacy.md` with checked evidence only after commands pass

- [x] **Step 1: Run the full Deno suite**

  Run the repository’s complete `deno test --allow-env --allow-net functions/tests` command in the pinned Deno 2.1.4 environment and record the exact pass count/failures.

- [x] **Step 2: Run all database tests and lint**

  Run `supabase db reset --local && supabase test db --local` and `supabase db lint --local --schema public,app_private --level warning`.

- [x] **Step 3: Run parity/smoke and historical checks**

  Run `./scripts/run-milestone-7-smoke.sh`, `node --test scripts/validate-n8n-workflow.test.mjs`, `git diff --check`, and a repository secret scan that excludes only documented placeholders and test fixture markers.

- [x] **Step 4: Verify the final acceptance criteria line by line**

  Confirm n8n-disabled operation, schedules, direct Telegram path, Notion isolation, status/dead behavior, deterministic tests, and no deployment. Report changed files, migrations, functions, cron schedules, total pass count, known limitations, and the production deployment commands required without executing them.

## Verification evidence

- Full Deno suite: 272 passed, 0 failed under Deno 2.1.4. The disposable local Supabase stack required a compatibility-only `storage.objects(name, bucket_id)` unique index because the cached Storage image otherwise fails uploads with PostgreSQL 42P10; this index was not committed and is not a production migration.
- Database suite: 17 files, 369 assertions passed.
- M7 smoke: 4 integration tests passed; includes Phase 1/2 orchestration and Phase 3 parity.
- Database lint: no schema errors in `public` or `app_private`.
- Historical n8n validator: 18 tests passed; architecture contract: 2 tests passed.
- Stabilized the pre-existing M4 intelligence fixture clock so 30-minute metric buckets cannot collide at particular wall-clock minutes; the focused regression test passed all 45 assertions and the full database suite remained green.
- `git diff --check` and repository secret scan passed. No deployment, webhook registration, push, or merge was performed.
