# Milestone 7 Phase 1 Supabase-Native Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a service-role-only Supabase editorial job queue and bounded orchestration worker without changing existing n8n workflows or M1–M6 business logic.

**Architecture:** `app_private.editorial_jobs` is mutated only through four `SECURITY INVOKER` RPCs exposed in `public` and granted only to `service_role`. The `orchestration-worker` Edge Function claims leased jobs, invokes existing function HTTP boundaries with their existing secrets, and independently completes or retries each job. Stable chain keys make downstream enqueueing idempotent.

**Tech Stack:** Supabase Postgres 17 migrations and pgTAP, Supabase Edge Functions on Deno 2.1, TypeScript, PostgREST RPC/table boundaries, shell smoke runner.

**Spec:** `docs/superpowers/specs/2026-09-26-milestone-7-phase-1-orchestration-design.md`

## Global Constraints

- Do not remove or modify existing n8n workflows.
- Do not deploy to production or use linked/remote Supabase state.
- Supabase remains the canonical source of truth.
- Do not duplicate M1–M6 business logic in the worker.
- Do not replace intelligence readiness logic or creative-generation lease logic.
- Preserve append-only `creative_briefs` revision semantics.
- Never expose `service_role` credentials outside Supabase Edge Function runtimes.
- Supported job types are exactly `COLLECT_INSTAGRAM`, `RUN_INTELLIGENCE`, `GENERATE_PRIORITY`, `SYNC_NOTION`, `POLL_SELECTED`, `DISPATCH_ALERTS`, `FIXTURE_SYNC`, and `MORNING_BRIEF`.
- Retry timing is deterministic: failure after attempt 1 is available in 5 minutes, failure after attempt 2 is available in 15 minutes, and the default third failure is `DEAD`.

## Review Focus

- A duplicate enqueue or worker retry must not create duplicate logical jobs; covered by Task 1 dedupe assertions and Task 2 repeated-chain tests.
- Two workers claiming the same available or expired job must never both receive it; covered by Task 1 claim tests and Task 4 concurrent RPC integration.
- Downstream HTTP errors must persist only bounded safe metadata, never response bodies or credentials; covered by Task 2 failure tests and Task 3 boundary tests.
- Intelligence `202 already_running` must not trigger premature priority generation; covered by Task 2 chaining tests.
- Notion failure must not invalidate successful upstream intelligence or creative work; covered by Task 2 independent-job tests.

---

### Task 1: Editorial Job Queue Schema and RPCs

**Files:**
- Create: `supabase/migrations/<CLI timestamp>_milestone_7_editorial_jobs.sql` (the exact filename returned by `supabase migration new milestone_7_editorial_jobs`)
- Create: `supabase/tests/database/015_m7_editorial_jobs_test.sql`

**Interfaces:**
- Produces `app_private.editorial_jobs` with `id uuid`, `job_type`, `payload`, unique `dedupe_key`, `status`, retry/lease/error timestamps and fields, and `created_at`/`updated_at`.
- Produces `public.enqueue_editorial_job(text, jsonb, text, integer, timestamptz) returns uuid`.
- Produces `public.claim_editorial_jobs(text, integer, timestamptz, integer) returns setof app_private.editorial_jobs`.
- Produces `public.complete_editorial_job(uuid, text, timestamptz) returns boolean`.
- Produces `public.fail_editorial_job(uuid, text, text, text, timestamptz) returns app_private.editorial_jobs`.

- [ ] **Step 1: Write the failing pgTAP contract test**

  Add tests for the table, all required columns, job/status constraints, unique dedupe index, status/availability indexes, RLS, service-role-only grants, RPC signatures and privileges, and rejection of an unsupported job type, blank dedupe key, invalid attempt count, and invalid claim limit. Add behavior tests that enqueue the same dedupe key twice, claim from two workers, reclaim an expired lock, complete with the owning worker, and run the `5m → 15m → DEAD` retry sequence at fixed timestamps. Assert the persisted error is bounded/redacted.

- [ ] **Step 2: Run the database test to verify it fails for the missing queue**

  Run: `supabase test db --local supabase/tests/database/015_m7_editorial_jobs_test.sql`

  Expected: FAIL because the new table and RPCs do not exist yet.

- [ ] **Step 3: Create the migration scaffold through the CLI**

  Run: `supabase migration new milestone_7_editorial_jobs`.

  Use the generated migration path for the remaining steps; do not invent a migration filename.

- [ ] **Step 4: Implement the table, grants, trigger, indexes, and RPCs**

  In the generated migration, create `app_private.editorial_jobs` with default `PENDING`, `attempt_count = 0`, `max_attempts = 3`, `available_at = now()`, and server timestamps. Constrain job types to the eight listed values, statuses to `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `DEAD`, payload to a JSON object, dedupe keys to nonblank unique text, and attempts/limits to bounded positive values. Enable RLS, revoke all table privileges from `public`, `anon`, and `authenticated`, and grant required CRUD only to `service_role`.

  Define `enqueue_editorial_job` as an idempotent insert-on-conflict-do-nothing that returns the existing row id without changing its state. Define `claim_editorial_jobs` with `FOR UPDATE SKIP LOCKED`, pending availability checks, expired-running reclaim using the supplied lease seconds, atomic `RUNNING` transition, attempt increment, owner/lock timestamps, and first-start preservation. Define owner-checked completion with lock clearing and `finished_at`. Define owner-checked failure with safe uppercase category normalization, newline/token-like redaction, a 240-character message bound, deterministic retry availability, and `DEAD`/`finished_at` when attempts are exhausted. Use invoker security, empty search paths, and service-role-only execute grants.

- [ ] **Step 5: Run the focused database test to verify it passes**

  Run: `supabase test db --local supabase/tests/database/015_m7_editorial_jobs_test.sql`

  Expected: all M7 queue assertions pass with zero failures.

- [ ] **Step 6: Commit the queue task**

  Run: `git add supabase/migrations supabase/tests/database/015_m7_editorial_jobs_test.sql && git commit -m "feat: add editorial job queue RPCs"`.

---

### Task 2: Orchestration Worker Domain and Pipeline Chaining

**Files:**
- Create: `supabase/functions/orchestration-worker/types.ts`
- Create: `supabase/functions/orchestration-worker/worker.ts`
- Create: `supabase/functions/tests/orchestration-worker/worker_test.ts`

**Interfaces:**
- `EditorialJobType` is the eight-value union from Task 1.
- `EditorialJob` maps the queue row, including `id`, `job_type`, `payload`, `dedupe_key`, `attempt_count`, `max_attempts`, `status`, lock fields, and error fields.
- `EditorialJobQueue` exposes `claim(workerId, limit, now, leaseSeconds)`, `complete(jobId, workerId, finishedAt)`, `fail(jobId, workerId, category, message, failedAt)`, and `enqueue(jobType, payload, dedupeKey, maxAttempts, availableAt)`.
- `BoundaryInvoker` exposes `invoke(jobType, payload): Promise<{ status: number; body?: unknown }>`.
- `createOrchestrationWorker(options)` returns `processBatch(): Promise<{ claimed: number; succeeded: number; failed: number; downstream_enqueued: number }>`.

- [ ] **Step 1: Write failing worker tests**

  Test one successful job, one failed job alongside an unrelated successful job, exact downstream enqueueing and stable derived dedupe keys, no downstream enqueue for a failed required stage, no downstream enqueue for `RUN_INTELLIGENCE` with HTTP 202/body `already_running`, Notion failure isolation, safe category/message forwarding without upstream bodies, and repeated processing not duplicating a downstream job when enqueue returns an existing id.

- [ ] **Step 2: Run the worker tests to verify they fail**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/orchestration-worker/worker_test.ts`

  Expected: FAIL because the worker module and types do not exist.

- [ ] **Step 3: Implement the worker state machine**

  Implement per-job isolation: invoke the boundary, treat 2xx as a safe invocation, enqueue the next stage before completing the current job, complete only after downstream enqueue succeeds, and route non-2xx/exception paths to `fail` with generic safe metadata. Chain using `<root chain key>:<job type>` dedupe keys carried in `payload.chain_key`. Map the pipeline exactly as `COLLECT_INSTAGRAM → RUN_INTELLIGENCE → GENERATE_PRIORITY → SYNC_NOTION → POLL_SELECTED → DISPATCH_ALERTS`; treat `already_running` as completed-but-no-chain. Keep fixture sync and morning brief terminal/independent. Never log or persist `payload` or upstream response bodies.

- [ ] **Step 4: Run the focused worker tests to verify they pass**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/orchestration-worker/worker_test.ts`

  Expected: all worker state-machine tests pass.

- [ ] **Step 5: Commit the worker domain task**

  Run: `git add supabase/functions/orchestration-worker/types.ts supabase/functions/orchestration-worker/worker.ts supabase/functions/tests/orchestration-worker/worker_test.ts && git commit -m "feat: add editorial orchestration worker"`.

---

### Task 3: Queue/Boundary Adapters, Authenticated Edge Function, and Local Configuration

**Files:**
- Create: `supabase/functions/orchestration-worker/queue_client.ts`
- Create: `supabase/functions/orchestration-worker/boundary_client.ts`
- Create: `supabase/functions/orchestration-worker/handler.ts`
- Create: `supabase/functions/orchestration-worker/index.ts`
- Create: `supabase/functions/tests/orchestration-worker/handler_test.ts`
- Create: `supabase/functions/tests/orchestration-worker/boundary_client_test.ts`
- Modify: `supabase/config.toml`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- `createEditorialJobQueue({ supabaseUrl, serviceKey, request? }): EditorialJobQueue` calls only the four Task 1 RPCs and uses the service key internally.
- `createBoundaryInvoker({ functionsUrl, collectorSecret, telegramSecret, request? }): BoundaryInvoker` maps each job type to the existing function endpoint and existing invoke secret.
- `createOrchestrationHandler({ workerSecret, run, requestId?, log? })` accepts authenticated `POST` with an empty body or `{ "limit": 1..20 }` and returns only a safe batch summary.
- `ORCHESTRATION_WORKER_INVOKE_SECRET` is the dedicated inbound secret; `ORCHESTRATION_BATCH_SIZE` defaults to 5 and `ORCHESTRATION_LEASE_SECONDS` defaults to 300.

- [ ] **Step 1: Write failing adapter and handler tests**

  Assert handler method/auth/body validation, safe response and log behavior, queue RPC argument names and service-role headers, endpoint mapping/body contracts for all eight job types, the collector-vs-Telegram secret split, and absence of service-role material in downstream requests or responses.

- [ ] **Step 2: Run focused adapter tests to verify they fail**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/orchestration-worker/handler_test.ts functions/tests/orchestration-worker/boundary_client_test.ts`

  Expected: FAIL because the adapters and handler do not exist.

- [ ] **Step 3: Implement the REST queue client and existing-boundary invoker**

  Use the existing Supabase REST conventions (`apikey` plus internal service-role authorization, `app_private` profile where required). Invoke `/rpc/claim_editorial_jobs`, `/rpc/complete_editorial_job`, `/rpc/fail_editorial_job`, and `/rpc/enqueue_editorial_job` with exact parameter names. Send only existing invoke secrets to function endpoints. Use `{ as_of }` for intelligence/Notion when present, `{ mode }` for fixture sync, `{}` for creative generation, selected poll, alerts, and morning brief, and the queued payload contract for collection. Convert any non-2xx response to a status-only `BoundaryResult` without retaining its body.

- [ ] **Step 4: Implement the authenticated worker handler and entrypoint**

  Add timing-safe bearer authentication, bounded batch-limit validation, safe logs/responses, and construction of the queue client, boundary invoker, and worker from environment variables. Set `[functions.orchestration-worker].verify_jwt = false` because the function validates its dedicated secret itself. Do not alter any existing function or n8n workflow configuration.

- [ ] **Step 5: Update local env/example and README guidance**

  Document only local M7 setup and the smoke command. Add the dedicated worker secret and optional batch/lease settings to `.env.example`; explicitly state that service-role keys remain inside Supabase and that n8n remains unchanged in Phase 1.

- [ ] **Step 6: Run the focused adapter tests to verify they pass**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/orchestration-worker/handler_test.ts functions/tests/orchestration-worker/boundary_client_test.ts`

  Expected: all adapter and handler tests pass.

- [ ] **Step 7: Commit the Edge Function task**

  Run: `git add supabase/functions/orchestration-worker supabase/functions/tests/orchestration-worker/handler_test.ts supabase/functions/tests/orchestration-worker/boundary_client_test.ts supabase/config.toml .env.example README.md && git commit -m "feat: expose authenticated orchestration worker"`.

---

### Task 4: Deterministic Local Integration Smoke

**Files:**
- Create: `supabase/tests/integration/milestone_7_orchestration_integration_test.ts`
- Create: `scripts/run-milestone-7-phase-1-smoke.sh`

**Interfaces:**
- The integration test consumes the real local Task 1 RPCs through `SUPABASE_URL` and `SUPABASE_SECRET_KEY` and the Task 2 worker with an injected mocked `BoundaryInvoker`.
- The smoke runner resets only the local database, runs the M7 pgTAP contract and integration tests, and never contacts live Meta, OpenAI, Notion, Telegram, or a linked Supabase project.

- [ ] **Step 1: Write the failing local integration test and shell assertions**

  Enqueue one `COLLECT_INSTAGRAM` job with a fixed chain key, run the worker with a mocked successful collection boundary, and assert the root job is `SUCCEEDED` and exactly one `RUN_INTELLIGENCE` row with the derived dedupe key is `PENDING`. Add two simultaneous claim calls against two worker ids and assert only one receives the same job.

- [ ] **Step 2: Run the integration test to verify it fails before the smoke implementation**

  Run: `supabase db reset --local && docker run --rm --add-host=host.docker.internal:host-gateway -e SUPABASE_URL=http://host.docker.internal:55321 -e SUPABASE_SECRET_KEY="$SUPABASE_SECRET_KEY" -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env --allow-net tests/integration/milestone_7_orchestration_integration_test.ts`

  Expected: FAIL because the smoke test and queue/worker integration are not implemented.

- [ ] **Step 3: Implement the local integration test**

  Use unique fixed smoke dedupe keys, the real queue REST client, and the worker domain with an in-process mocked boundary. Query `app_private.editorial_jobs` through the service-role REST profile to verify statuses and exact row counts. Keep all assertions deterministic and do not read or print credentials.

- [ ] **Step 4: Implement `scripts/run-milestone-7-phase-1-smoke.sh`**

  Load the local function env file when present, require only local Supabase URL/service key, reset the local database, run `supabase test db`, run the Deno integration test in the pinned Deno 2.1.4 container with explicit local environment values, and print a short success summary. Mark the script executable. Fail on any test or secret-scan error. Do not invoke `supabase db push`, `supabase functions deploy`, or any remote URL.

- [ ] **Step 5: Run the smoke script to verify the full deterministic path**

  Run: `./scripts/run-milestone-7-phase-1-smoke.sh`

  Expected: local database tests and integration smoke pass; output demonstrates one claimed/completed collection job and exactly one queued intelligence job.

- [ ] **Step 6: Commit the smoke task**

  Run: `git add supabase/tests/integration/milestone_7_orchestration_integration_test.ts scripts/run-milestone-7-phase-1-smoke.sh && git commit -m "test: add milestone 7 orchestration smoke"`.

---

### Task 5: Full Local Verification and Final Review

**Files:**
- Modify only files needed to resolve verification findings; never modify `n8n/workflows/*`.

- [ ] **Step 1: Run the complete local database suite**

  Run: `supabase db reset --local && supabase test db`.

  Expected: all existing M1–M6 and new M7 pgTAP tests pass.

- [ ] **Step 2: Run the complete Edge Function test suite**

  Run: `docker run --rm --env-file supabase/functions/.env.local -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env --allow-net functions/tests`.

  Expected: all existing and new Deno tests pass with no unhandled failures.

- [ ] **Step 3: Verify n8n is unchanged and local-only constraints hold**

  Run: `git diff --name-only 9ac7db2..HEAD -- n8n/workflows` and `git status --short`.

  Expected: no n8n workflow paths changed, no generated credential files are tracked, and the working tree is clean after commits.

- [ ] **Step 4: Run database lint and the M7 smoke script**

  Run: `supabase db lint --local --schema public,app_private --level warning && ./scripts/run-milestone-7-phase-1-smoke.sh`.

  Expected: no new lint warnings/errors and deterministic smoke passes.

- [ ] **Step 5: Commit any verification-only fixes and record evidence**

  Use a focused commit for any necessary fix, rerun the affected RED→GREEN test and the complete verification suite, then record the final commands and results in the execution ledger.
