# M8 Data API Authentication and Gateway Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix server-side Data API authorization for M8 repositories and diagnose Function gateway latency with stage timings.

**Architecture:** Use the existing service-role key for both `apikey` and `Authorization: Bearer ...`, retain private-schema profile headers, and keep the key inside server-side repository options. Exercise the actual rank-editorial gateway URL in a unique disposable Supabase project while correlating client timing with safe handler and Data API timings.

**Tech Stack:** Supabase Edge Functions, Deno, PostgREST, Supabase CLI, Python/curl diagnostics.

**Spec:** `docs/superpowers/specs/2026-10-12-m8-grounding-ranking-ready-design.md` (acceptance 1 and 7).

## Global Constraints

- Production Supabase and the shared local `manutd_editor` database are out of scope; use only a separately identified disposable staging stack with isolated project ID and ports.
- Do not merge PR #8, #9, or #10; create no new PR; keep PR #10 Draft and based on PR #9.
- Do not activate Google News operations, schedules, cron, Telegram delivery, or user-facing publishing.
- Do not log or return service-role keys, bearer tokens, or request headers containing secrets.
- Treat HTTP 499 as a client-disconnect symptom until timings distinguish client, DNS/connect/TLS, gateway, handler, authentication, and Data API stages.

## Review Focus

- A test fetch sees the exact bearer value only in `authorization`, with `apikey` still present and no secret in captured output (Task 1).
- Calls targeting `app_private` retain both profile headers; public calls do not gain a schema override (Task 1).
- A gateway timeout is not labeled a Kong defect without evidence from DNS/connect/TLS, gateway response, handler entry/exit, and repository timing (Task 2).
- Unauthorized requests do not reach the repository, and initialization/auth failures use redacted codes (Task 2).
- A successful gateway smoke uses the configured request timeout and reports DNS, connect, first-byte, total, HTTP, and handler timings separately (Task 2).

---

### Task 1: Add and verify service-role Authorization headers

**Files:**
- Modify: `supabase/functions/rank-editorial/repository.ts`
- Modify: `supabase/functions/ground-claims/repository.ts`
- Modify: `supabase/functions/source-discovery/repository.ts`
- Test: `supabase/functions/tests/rank-editorial/repository_test.ts`
- Test: `supabase/functions/tests/ground-claims/repository_test.ts`
- Test: `supabase/functions/tests/source-discovery/repository_test.ts`

**Interfaces:**
- Each repository's injected `request` remains `typeof fetch`; its request helper sends `apikey: serviceRoleKey` and `authorization: Bearer ${serviceRoleKey}`.
- For `app_private`, retain both `accept-profile` and `content-profile`; public table requests keep their existing profile behavior.

- [ ] **Step 1: Add failing outgoing-header tests** named `rank repository sends service-role authorization and app_private profiles`, `grounding repository sends service-role authorization and app_private profiles`, and `source discovery repository sends service-role authorization and app_private profiles`. Each captures `new Headers(init.headers)` and asserts exact `apikey`, exact `authorization: Bearer service-role-secret`, and both `accept-profile` and `content-profile` equal `app_private` on a private request.
- [ ] **Step 2: Run the focused tests**

Run: `cd supabase/functions && deno test --allow-env --allow-net tests/rank-editorial/repository_test.ts tests/ground-claims/repository_test.ts tests/source-discovery/repository_test.ts`

Expected: each new authorization assertion fails while existing API-key/profile assertions continue to pass.

- [ ] **Step 3: Implement the header fix** in each repository's request helper without changing error response bodies or logging request options.
- [ ] **Step 4: Re-run the focused tests** with the same command; expect all tests to pass.
- [ ] **Step 5: Review sibling internal repositories** (`promote-discovery`, `trend-discovery`, `_shared/m6`, and `notion-sync`) and record whether each already sends service-role authorization; only change another repository if it participates in this same M8 Data API path.

### Task 2: Diagnose the real Functions gateway path

**Files:**
- Modify: `supabase/functions/rank-editorial/handler.ts`
- Modify: `supabase/functions/rank-editorial/repository.ts`
- Modify: `supabase/functions/rank-editorial/types.ts`
- Modify: `supabase/functions/rank-editorial/index.ts`
- Test: `supabase/functions/tests/rank-editorial/handler_test.ts`
- Test: `supabase/functions/tests/rank-editorial/repository_test.ts`
- Operational validation: an isolated disposable Supabase CLI workdir and redacted validation notes; do not add secrets or a local `.env` file to Git.

**Interfaces:**
- Handler/repository log entries carry `requestId`, a bounded stage/table name, elapsed milliseconds, HTTP status class or safe failure code; they never contain credentials, headers, query values, or article text. A single-flight staging smoke correlates the rank invocation's repository timings with its handler request ID.
- `RankEditorialHandlerDependencies.run(input, requestId)` passes the server-generated ID into `runEditorialRanking`; repository methods accept that optional ID for redacted request timing logs.
- The smoke request targets `POST <isolated-functions-gateway>/rank-editorial` with the existing collector invocation secret and a fixed disposable `ranking_date`.

- [ ] **Step 1: Add failing handler-log tests** named `rank handler logs safe stage timings and never logs credentials` and `rank handler rejects before repository work`; assert request/auth/parse/run/total stages, repository call count zero on auth failure, and absence of the configured collector secret in serialized logs.
- [ ] **Step 2: Run** `cd supabase/functions && deno test --allow-env --allow-net tests/rank-editorial/handler_test.ts`; expect the new timing assertions to fail.
- [ ] **Step 3: Add safe per-stage handler timing** around authentication, request parsing, repository-backed run, and total response; keep response contract and secret comparison unchanged. Emit one safe startup-ready marker from `index.ts` after repository/provider setup completes.
- [ ] **Step 4: Re-run the handler test**; expect safe timing entries and no secret in logs.
- [ ] **Step 5: Add failing repository timing tests** asserting each Data API fetch emits only table name, elapsed time, status class, and request ID; assert URL query values and service-role key are absent. Add optional safe logger injection to repository options and thread the current handler request ID through the rank invocation.
- [ ] **Step 6: Run the timing unit tests** with `cd supabase/functions && deno test --allow-env --allow-net tests/rank-editorial/handler_test.ts tests/rank-editorial/repository_test.ts`; expect passing redaction and duration assertions.
- [ ] **Step 7: Start a disposable stack** from a temporary copy of the Supabase config/migrations/seeds after changing its project ID and all API/database ports to unique values. Confirm the resolved API and database endpoints before applying any write.
- [ ] **Step 8: Send a request through the actual Functions gateway URL** with a bounded client timeout. Record timestamp, DNS resolution, connect, TLS, time-to-first-byte, total, HTTP status/body code, handler stage durations, Data API stage durations, and gateway/Edge logs. Never call the handler directly.
- [ ] **Step 9: Diagnose 499 by evidence**: state whether it reproduced; if so, classify the slow/missing stage, and if not, report that 499 was not reproduced. A 401 must be distinguished from a timeout and checked against the corrected Data API request.
