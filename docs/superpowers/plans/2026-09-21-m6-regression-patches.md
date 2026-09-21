# M6 Regression Patches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair Telegram natural-language grounding, unify M6 business-date handling, and prevent Morning Brief from treating an incomplete Intelligence run as an empty result.

**Architecture:** Supabase remains canonical and natural language remains read-only. PATCH 1 will add a focused conversation responder that receives real recent messages, summary, fresh active rows, and conditional structured history; the Telegram entrypoint will wire real REST readers and the existing OpenAI abstraction without exposing internal rules. PATCH 2 will centralize timezone-aware business-date calculation. PATCH 3 will persist per-business-date Intelligence readiness and make Morning Brief classify `NOT_READY`, `DEGRADED`, `READY_EMPTY`, and `READY_WITH_CANDIDATES` before delivery.

**Tech Stack:** Supabase Edge Functions, Deno 2.1, TypeScript, Supabase REST, PostgreSQL/pgTAP, n8n JSON workflow validation, OpenAI Responses abstraction already present in `supabase/functions/_shared/m6/openai.ts`.

**Spec:** User-provided regression request pasted in `/Users/jeongwonkim/.codex/attachments/a726fa43-3254-4183-93a2-9b35ffc07b78/붙여넣은 텍스트.txt`.

## Global Constraints

- Supabase = canonical state.
- Natural-language conversation = read-only; slash commands alone may mutate editorial state.
- No external web search; preserve the existing grounded evidence boundary.
- Complete PATCH 1 and its tests before starting PATCH 2; complete PATCH 2 and its tests before starting PATCH 3.
- Do not change slash-command behavior or perform unrelated refactors.
- Use UTC instants for timestamps and the active `telegram_agent_configs.timezone` for business-local dates; default remains `Asia/Seoul`.
- Preserve duplicate Telegram update, briefing, fixture-sync, and command idempotency.

## Review Focus

- A model failure or prompt leakage must produce a safe deterministic reply without returning memory rules; PATCH 1 tests the fallback and leakage boundary.
- Active IDs must be accompanied by fresh canonical rows, not only stale identifiers; PATCH 1 tests the payload.
- History retrieval must be gated by explicit history intent; PATCH 1 tests ordinary and historical requests separately.
- UTC/local midnight boundaries must produce the same ranking and briefing date; PATCH 2 tests all requested boundary instants.
- Missing, running, failed, empty, and populated Intelligence states must not collapse into one Telegram outcome; PATCH 3 tests each readiness state and duplicate delivery.

### Task 1: PATCH 1 failing tests and conversation responder

**Files:**
- Create: `supabase/functions/telegram-agent/conversation.ts`
- Create: `supabase/functions/tests/m6/telegram_agent_conversation_test.ts`
- Modify: `supabase/functions/_shared/m6/memory.ts`
- Modify: `supabase/functions/_shared/m6/openai.ts`

**Interfaces:**
- `createConversationReply(message, context, dependencies): Promise<string>` consumes a `ConversationContext`, optional fresh canonical context, and a history provider; it produces only a safe assistant string.
- `validateConversationReply(value): string` accepts `{ reply: string }` and rejects system-rule leakage, empty/non-string output, and unsafe structured output.

- [ ] Write tests proving a normal “너 누구야” reply never contains `MEMORY_SYSTEM_RULES`, invokes the generator exactly once, and uses a deterministic fallback when generation fails.
- [ ] Write tests proving the generator input contains at most the latest 12 messages, the conversation summary, all active IDs, and fresh candidate/brief/match rows.
- [ ] Write tests proving history retrieval is called only for `shouldRetrieveHistory(message)` requests.
- [ ] Write tests proving an ordinary response has no mutation dependency or mutation call.
- [ ] Run the focused tests and verify they fail because the responder/wiring does not yet exist.
- [ ] Implement the smallest responder and validation layer, preserving `MEMORY_SYSTEM_RULES` as model instruction data only and never as a user-facing reply.
- [ ] Run the focused tests again and verify they pass.

### Task 2: PATCH 1 production wiring and regression verification

**Files:**
- Modify: `supabase/functions/telegram-agent/index.ts`
- Modify: `supabase/functions/_shared/m6/memory.ts`
- Modify: `supabase/functions/_shared/m6/openai.ts`
- Modify: `supabase/functions/tests/m6/memory_test.ts`
- Modify: `supabase/functions/tests/m6/telegram_agent_handler_test.ts` only if wiring coverage needs a handler seam

**Interfaces:**
- The production natural-language path will list `app_private.telegram_messages` with a bounded latest-12 query, load the active thread summary/state, and load fresh canonical candidate, brief, and match rows by active ID.
- The path will invoke `retrieveHistoricalContext` only after `shouldRetrieveHistory`, and will use `createOpenAIGenerator` once for the answer.

- [ ] Add/adjust memory tests for the real message list contract and summary inclusion.
- [ ] Replace `listMessages: async () => []` with the private REST query and pass the configured 12-message limit.
- [ ] Add best-effort fresh canonical-row loading for active IDs and inject those rows into the model payload.
- [ ] Add structured retrieval dependencies backed only by Supabase canonical tables and Telegram history; do not add web access.
- [ ] Wire `maybeRollSummary` after assistant persistence using the existing OpenAI abstraction and configured summary thresholds, with safe failure isolation.
- [ ] Keep command routing unchanged and ensure the natural-language branch never calls revision/save/mutation APIs.
- [ ] Run all PATCH 1 M6 tests plus the existing slash-command and handler tests; report changed files, design, results, and limitations before beginning PATCH 2.

### Task 3: PATCH 2 business date contract

**Files:**
- Create: `supabase/functions/_shared/m6/business_date.ts`
- Create: `supabase/functions/tests/m6/business_date_test.ts`
- Modify: `supabase/functions/intelligence/repository.ts`
- Modify: `supabase/functions/telegram-morning-brief/index.ts`
- Modify: `supabase/functions/tests/intelligence/repository_test.ts`

**Interfaces:**
- `businessDate(now: Date | string, timezone: string): string` returns `YYYY-MM-DD` using `Intl.DateTimeFormat` in the supplied timezone.
- Intelligence repository candidate calculation accepts the already-resolved business date while production resolves the active `telegram_agent_configs.timezone` (defaulting safely to `Asia/Seoul` only when no active config is available).

- [ ] Write boundary tests for `2026-09-20T14:59:59Z`, `15:00:00Z`, `23:30:00Z`, and `23:59:59Z` in `Asia/Seoul`; verify the expected local dates.
- [ ] Add a repository regression test asserting `p_ranking_date` uses the timezone-aware date rather than `toISOString().slice(0, 10)`.
- [ ] Run the focused tests and verify they fail on the old UTC-slice behavior.
- [ ] Implement and use the shared helper in Intelligence and Morning Brief, keeping `p_run_at`/`calculated_at` as UTC instants and the database field type as `date`.
- [ ] Run focused date tests and the existing Intelligence/Morning Brief tests; verify all pass before PATCH 3.

### Task 4: PATCH 3 canonical Intelligence readiness

**Files:**
- Create: `supabase/migrations/20260921100000_m6_intelligence_readiness.sql`
- Create: `supabase/functions/_shared/m6/readiness.ts`
- Create: `supabase/functions/tests/m6/readiness_test.ts`
- Create: `supabase/tests/database/014_m6_intelligence_readiness_test.sql`
- Modify: `supabase/functions/intelligence/repository.ts`
- Modify: `supabase/functions/intelligence/orchestrator.ts`
- Modify: `supabase/functions/telegram-morning-brief/index.ts`
- Modify: `supabase/functions/telegram-morning-brief/handler.ts`
- Modify: `supabase/functions/_shared/m6/repository.ts`
- Modify: `supabase/functions/tests/m6/morning_brief_handler_test.ts`

**Interfaces:**
- A service-only `app_private.intelligence_readiness` row is keyed by `ranking_date` and stores `RUNNING`, `SUCCEEDED`, or `FAILED`, candidate count, timestamps, and a safe error category.
- `classifyReadiness(state, currentCandidateCount): "NOT_READY" | "DEGRADED" | "READY_EMPTY" | "READY_WITH_CANDIDATES"` is pure and rejects missing/date-mismatched/stale success state.

- [ ] Write readiness tests for missing/running, failed, successful-zero, and successful-populated states, plus candidate-count mismatch.
- [ ] Write Morning Brief tests proving `NOT_READY` and `DEGRADED` never send a “0 candidates” briefing, while `READY_EMPTY` and `READY_WITH_CANDIDATES` do.
- [ ] Write a database contract test for the service-only table, status/check constraints, date key, and grants.
- [ ] Run tests and verify the new readiness behavior fails before implementation.
- [ ] Add the migration and repository methods for upserting run state and reading the business-date state.
- [ ] Mark Intelligence `RUNNING` after lease acquisition, `SUCCEEDED` with the calculated candidate count, and `FAILED` with a non-secret category; preserve lease release behavior.
- [ ] Gate Morning Brief before candidate rendering/sending; return explicit readiness status, preserve duplicate briefing protection, and keep fixture-sync failure as a warning on otherwise-ready delivery.
- [ ] Run focused readiness, Intelligence, Morning Brief, and database tests.

### Task 5: Final verification

- [ ] Run `deno test functions/tests` from `supabase` (or the repository’s documented Deno command).
- [ ] Run `supabase test db` and the focused readiness database test.
- [ ] Run `node scripts/validate-n8n-workflow.mjs` for all M6 workflows and `node --test scripts/validate-n8n-workflow.test.mjs`.
- [ ] Run the M6 smoke script and the M4/M5 regression smoke/tests available in the environment.
- [ ] Inspect `git diff`, confirm no secrets or unrelated refactors, and report any environment-dependent checks that could not run.
