# Milestone 7 Phase 2 Supabase-Native Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four requested n8n runtime responsibilities with Supabase Cron root enqueueing, Phase 1 worker chaining, and a direct Telegram webhook while preserving existing M1-M6 business logic.

**Architecture:** A new migration registers three `pg_cron` jobs and a restricted scheduler RPC that computes deterministic Asia/Seoul buckets before calling the existing idempotent queue RPC. The orchestration worker gains only the fixture-to-alert edge; the existing morning brief and Telegram agent remain business-logic owners. Telegram webhook authentication is extended with a timing-safe secret header while retaining a secured bearer path for internal/test calls.

**Tech Stack:** Supabase Postgres 17, `pg_cron`, SQL/pgTAP, Supabase Edge Functions on Deno 2.1.4, TypeScript, shell, and local Docker-backed Supabase smoke tests.

**Spec:** `docs/superpowers/specs/2026-09-27-milestone-7-phase-2-orchestration-design.md`

## Global Constraints

- Keep all implementation and commits on `main`; do not create an extra branch.
- Do not deploy production or register the production Telegram webhook during this phase.
- Do not delete or modify the existing n8n workflow exports.
- Cron must only enqueue root jobs and must not execute a business pipeline.
- No bot token, webhook secret, service-role key, or project secret key may enter committed source, migration SQL, logs, responses, or test output.
- Preserve `businessDate()`, intelligence readiness, `ALREADY_SENT`, forced fixture refresh, briefing snapshots, Telegram persistence, owner authorization, and `telegram_update_id` dedupe.
- Preserve Phase 1 queue ownership, leases, retries, safe failure metadata, and service-role-only access.
- Use deterministic business buckets compatible with `Asia/Seoul`: 30 minutes for Instagram, 15 minutes for fixtures, and one local business date for the morning brief.
- `FIXTURE_SYNC` may enqueue `DISPATCH_ALERTS` only after a successful boundary invocation.
- The local smoke suite must not contact Meta, OpenAI, Notion, Telegram, n8n, or a linked/remote Supabase project.

## Review Focus

- Scheduler calls at `xx:00`, `xx:29`, `xx:30`, and `xx:59` Asia/Seoul must map to the correct 30-minute bucket; covered by the database boundary test.
- Scheduler calls at `xx:00`, `xx:14`, `xx:15`, and `xx:59` Asia/Seoul must map to the correct 15-minute bucket; covered by the database boundary test.
- A morning schedule invocation around UTC midnight must dedupe by the Seoul business date and not alter the function's own `businessDate()` decision; covered by scheduler and morning-root integration tests.
- A fixture failure, a `RUN_INTELLIGENCE` `already_running` response, and a duplicate worker retry must not create an incorrect downstream job; covered by worker tests.
- A malformed direct Telegram update, wrong header, wrong owner, and duplicate `telegram_update_id` must be rejected or short-circuited before agent logic; covered by webhook and parity tests.

---

### Task 1: Supabase Cron Scheduler and Root Enqueue RPC

**Files:**
- Create: `supabase/migrations/<CLI timestamp>_milestone_7_phase_2_scheduling.sql` using `supabase migration new milestone_7_phase_2_scheduling`
- Create: `supabase/tests/database/016_m7_phase_2_scheduling_test.sql`

**Interfaces:**
- Produces `public.enqueue_scheduled_editorial_job(text, timestamptz) returns uuid`.
- Accepts only `COLLECT_INSTAGRAM`, `FIXTURE_SYNC`, and `MORNING_BRIEF`.
- Produces Cron jobs named `m7-instagram-collector-every-30-minutes`, `m7-fixture-sync-every-15-minutes`, and `m7-morning-brief-0900-asia-seoul`.
- Uses dedupe keys `instagram-pipeline:<YYYYMMDDHHMM>`, `fixture-pipeline:<YYYYMMDDHHMM>`, and `morning-brief:<YYYY-MM-DD>` from Seoul-local time.

- [ ] **Step 1: Write the failing pgTAP test**

  Assert the scheduler RPC signature, return type, service-role-only execute privilege, exactly three Cron jobs, exact schedules, SQL-command invocation of the scheduler RPC, absence of function HTTP URLs/service-key markers in Cron commands, allowed root types, deterministic 30/15-minute and daily Seoul buckets, duplicate invocation idempotency, and rejection of a non-root job type.

- [ ] **Step 2: Run the database test to verify it fails**

  Run: `supabase db reset --local && supabase test db --local supabase/tests/database/016_m7_phase_2_scheduling_test.sql`

  Expected: FAIL because the scheduler RPC and Phase 2 Cron jobs do not exist.

- [ ] **Step 3: Create the migration scaffold through the CLI**

  Run: `supabase migration new milestone_7_phase_2_scheduling`.

  Use the generated migration path; do not invent its timestamp.

- [ ] **Step 4: Implement the scheduler RPC and Cron registration**

  In the generated migration, create or reuse the supported `pg_cron` extension, define the restricted `public.enqueue_scheduled_editorial_job` RPC with an empty search path and safe input validation, convert the supplied timestamp to `Asia/Seoul`, construct the root payload and dedupe key, and call `public.enqueue_editorial_job` with the default three attempts. Revoke access from `public`, `anon`, and `authenticated`; grant only the database scheduler/service-role boundary needed by local/hosted Cron and tests. Register the three Cron jobs through `cron.schedule`: `*/30 * * * *`, `*/15 * * * *`, and `0 0 * * *` for 09:00 Seoul under the database's UTC cron timezone. Do not use `pg_net`, Vault, HTTP, or secrets because the Cron command is an in-database enqueue.

- [ ] **Step 5: Run the focused database test to verify it passes**

  Run: `supabase db reset --local && supabase test db --local supabase/tests/database/016_m7_phase_2_scheduling_test.sql`

  Expected: all scheduler, Cron, boundary, privilege, and idempotency assertions pass.

- [ ] **Step 6: Commit the scheduler task**

  Run: `git add supabase/migrations/<generated-file> supabase/tests/database/016_m7_phase_2_scheduling_test.sql && git commit -m "feat: add native editorial schedules"`.

---

### Task 2: Fixture-to-Alert Worker Chaining

**Files:**
- Modify: `supabase/functions/orchestration-worker/worker.ts`
- Modify: `supabase/functions/tests/orchestration-worker/worker_test.ts`
- Modify: `supabase/functions/tests/orchestration-worker/boundary_client_test.ts` if needed to pin the fixture payload contract

**Interfaces:**
- Extends the worker's existing stage map with `FIXTURE_SYNC -> DISPATCH_ALERTS`.
- Keeps `MORNING_BRIEF` terminal and keeps `RUN_INTELLIGENCE` `already_running` terminal for that invocation.

- [ ] **Step 1: Write the failing worker tests**

  Add tests asserting a successful fixture job enqueues exactly one `DISPATCH_ALERTS` job with the stable `<chain_key>:DISPATCH_ALERTS` dedupe key; a failed fixture boundary does not enqueue alerts; repeated processing does not duplicate the downstream logical job; morning brief remains terminal; and the existing collection/intelligence chain behavior remains unchanged.

- [ ] **Step 2: Run the focused worker tests to verify they fail**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/orchestration-worker/worker_test.ts functions/tests/orchestration-worker/boundary_client_test.ts`

  Expected: FAIL because `FIXTURE_SYNC` is currently terminal.

- [ ] **Step 3: Implement the minimal worker map change**

  Add only the fixture edge to `NEXT_STAGE`; reuse the existing per-job success/failure, enqueue-before-complete, stable dedupe, and safe-error behavior. Do not move fixture or alert business logic into the worker.

- [ ] **Step 4: Run the focused worker tests to verify they pass**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/orchestration-worker/worker_test.ts functions/tests/orchestration-worker/boundary_client_test.ts`

  Expected: all focused worker and boundary tests pass.

- [ ] **Step 5: Commit the worker task**

  Run: `git add supabase/functions/orchestration-worker/worker.ts supabase/functions/tests/orchestration-worker/worker_test.ts supabase/functions/tests/orchestration-worker/boundary_client_test.ts && git commit -m "feat: chain fixture sync alerts"`.

---

### Task 3: Direct Telegram Webhook Authentication and Validation

**Files:**
- Modify: `supabase/functions/telegram-agent/handler.ts`
- Modify: `supabase/functions/telegram-agent/index.ts`
- Modify: `supabase/functions/tests/m6/telegram_agent_handler_test.ts`
- Modify: `.env.example`

**Interfaces:**
- `TelegramAgentHandlerDependencies` gains optional `webhookSecret?: string` while retaining `invokeSecret` for secured internal/test invocation.
- Direct webhook authentication uses `X-Telegram-Bot-Api-Secret-Token` and `TELEGRAM_WEBHOOK_SECRET`.
- Internal compatibility authentication uses `Authorization: Bearer ...` and `TELEGRAM_AGENT_INVOKE_SECRET`.
- Both paths use the existing SHA-256 fixed-length timing-safe comparison pattern and reject when no configured secret validates.

- [ ] **Step 1: Write the failing webhook tests**

  Add tests for a valid Telegram secret header with no bearer header, wrong/missing header rejection, valid internal bearer compatibility, malformed JSON, arrays/strings/missing `update_id`/missing message/from/chat rejection, owner rejection, duplicate `telegram_update_id` short-circuiting before `run`, and preservation of secured single-item/JSON-string normalization only on the bearer path. Assert no run/claim occurs for malformed updates.

- [ ] **Step 2: Run the focused tests to verify they fail**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/m6/telegram_agent_handler_test.ts`

  Expected: FAIL because the handler does not accept the Telegram secret header or enforce the new update shape.

- [ ] **Step 3: Implement timing-safe dual-mode authentication and strict update validation**

  Add the webhook secret dependency, authenticate the Telegram header first and the explicit bearer compatibility path second, require at least one configured secret, normalize old wrappers only for bearer requests, validate the normalized direct update before owner/dedupe processing, and retain the existing owner check and `claimUpdate` call. Keep responses safe and preserve the `ALREADY_PROCESSED` status. Pass `TELEGRAM_WEBHOOK_SECRET` from `index.ts` and add the variable to `.env.example`.

- [ ] **Step 4: Run the focused tests to verify they pass**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/m6/telegram_agent_handler_test.ts`

  Expected: all webhook authentication, shape, owner, compatibility, and dedupe assertions pass.

- [ ] **Step 5: Commit the webhook task**

  Run: `git add supabase/functions/telegram-agent/handler.ts supabase/functions/telegram-agent/index.ts supabase/functions/tests/m6/telegram_agent_handler_test.ts .env.example && git commit -m "feat: authenticate direct Telegram webhooks"`.

---

### Task 4: Webhook Registration Helper and Runtime Documentation

**Files:**
- Create: `scripts/register-telegram-webhook.sh`
- Modify: `README.md`
- Modify: `n8n/README.md` only if needed to document that the export is retained for parity/history and is no longer required by the tested Phase 2 path

**Interfaces:**
- The script requires `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_URL`, and `TELEGRAM_WEBHOOK_SECRET` from the environment.
- It POSTs Telegram `setWebhook` with `url` and `secret_token`, fails on HTTP/API failure, and never prints secret values.

- [ ] **Step 1: Write the failing script contract checks**

  Add shell-level checks in the smoke/validation path for executable status, `bash -n`, required-variable guards, `setWebhook`, `secret_token`, `curl --fail`, and absence of literal secret values. Keep the test offline and do not call Telegram.

- [ ] **Step 2: Run the checks to verify they fail**

  Run: `bash -n scripts/register-telegram-webhook.sh`

  Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the non-secret registration helper and docs**

  Use strict shell settings, validate required variables without echoing them, call `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook` with a JSON body built by `jq` or safe curl form arguments, and print only the API success/result status. Document the command with placeholders and state that production registration is a deliberate post-phase action.

- [ ] **Step 4: Run script checks to verify they pass**

  Run: `bash -n scripts/register-telegram-webhook.sh && test -x scripts/register-telegram-webhook.sh && rg -n "setWebhook|secret_token|TELEGRAM_WEBHOOK_SECRET" scripts/register-telegram-webhook.sh README.md`

  Expected: syntax, executable, and documentation checks pass without any secret-like literal.

- [ ] **Step 5: Commit the helper/docs task**

  Run: `git add scripts/register-telegram-webhook.sh README.md n8n/README.md && git commit -m "docs: add Telegram webhook registration"`.

---

### Task 5: Phase 2 Parity Test and Full Local Smoke

**Files:**
- Create: `supabase/tests/integration/milestone_7_phase_2_parity_test.ts`
- Modify: `scripts/run-milestone-7-phase-1-smoke.sh` into the Phase 2 smoke runner, preserving the old filename as a compatibility entrypoint or adding `scripts/run-milestone-7-smoke.sh` and delegating from the Phase 1 name
- Create or modify: `supabase/tests/database/017_m7_phase_2_parity_test.sql` only if a separate SQL parity contract is clearer than the scheduler test

**Interfaces:**
- The parity test consumes the local scheduler RPCs, queue client, worker, and Telegram handler with mocked/in-process boundaries.
- `scripts/run-milestone-7-smoke.sh` is the user-facing Phase 2 smoke command; it accepts only local Supabase URLs and local service keys, resets the local database, runs all database tests, runs Phase 1 and Phase 2 integration tests in Deno 2.1.4, checks helper/docs syntax, and runs the secret scan.

- [ ] **Step 1: Write the failing parity/integration tests and smoke assertions**

  Document the exact old/new mapping in test names/comments: n8n 30-minute pipeline → scheduled `COLLECT_INSTAGRAM` root plus worker chain; n8n fixture scheduler → scheduled `FIXTURE_SYNC` plus worker alert edge; n8n 09:00 brief → scheduled `MORNING_BRIEF` plus existing handler; Telegram Trigger → direct webhook. Assert scheduler dedupe, fixture chaining, morning-brief terminal behavior, direct header auth, bearer compatibility, owner rejection, malformed update rejection, duplicate-update short-circuit, and worker execution with no n8n boundary.

- [ ] **Step 2: Run the parity tests to verify they fail**

  Run: `supabase db reset --local && docker run --rm --add-host=host.docker.internal:host-gateway -e SUPABASE_URL=http://host.docker.internal:55321 -e SUPABASE_SECRET_KEY="$SUPABASE_SECRET_KEY" -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env --allow-net tests/integration/milestone_7_phase_2_parity_test.ts`

  Expected: FAIL because the Phase 2 scheduler and parity assertions do not exist.

- [ ] **Step 3: Implement the parity test and full smoke runner**

  Use unique deterministic test keys, invoke the scheduler RPC twice per bucket, inspect the queue through service-role REST, run the worker with mocked boundaries, and exercise the direct handler in-process. The smoke runner must verify all required Cron jobs exist via the database suite, run the Phase 1 queue smoke as well as Phase 2 parity, never invoke n8n, reject non-local URLs, and scan source for secret-like values without printing credentials. Keep n8n JSON files untouched.

- [ ] **Step 4: Run the Phase 2 smoke suite to verify it passes**

  Run: `./scripts/run-milestone-7-smoke.sh`

  Expected: local database tests, Phase 1 integration, Phase 2 parity, script checks, and secret scan pass with a short summary.

- [ ] **Step 5: Run the full Deno suite and repository validation**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests`

  Also run: `node --test scripts/validate-n8n-workflow.test.mjs` and `git diff --check`.

  Expected: all existing and new tests pass, n8n exports remain valid/unchanged, and there are no whitespace errors.

- [ ] **Step 6: Commit the parity/smoke task**

  Run: `git add supabase/tests/integration/milestone_7_phase_2_parity_test.ts scripts/run-milestone-7-smoke.sh scripts/run-milestone-7-phase-1-smoke.sh supabase/tests/database/017_m7_phase_2_parity_test.sql && git commit -m "test: add milestone 7 phase 2 parity smoke"`.

---

## Final verification

- [ ] Run `git status --short --branch` and confirm the work is committed on `main`.
- [ ] Run `git log --oneline` and confirm the Phase 2 commits are present.
- [ ] Confirm no production deploy, Telegram registration call, n8n deletion, or secret material was performed.
- [ ] Complete the executing-plans ledger and perform the required whole-branch review before claiming completion.

