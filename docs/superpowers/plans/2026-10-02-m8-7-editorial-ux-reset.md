# M8.7 Editorial UX Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the M8.7 Telegram editorial workflow from hourly discovery through a trust-aware card-news draft and revisions, while preserving canonical grounding semantics.

**Architecture:** Keep canonical ranking and grounding authoritative. Add an editorial trust policy at presentation and generation boundaries, persist digest/list context for deterministic action resolution, route natural language into a validated action object, and use the existing queue/outbox for hourly discovery delivery.

**Tech Stack:** Supabase Edge Functions (Deno/TypeScript), Postgres migrations/pg_cron, Telegram Bot API, OpenAI Responses API, Deno and Node tests.

**Spec:** `/Users/jeongwonkim/.codex/attachments/d63c6343-7883-44e4-9144-5637d9741681/붙여넣은 텍스트.txt`

## Global Constraints

- Preserve canonical `news_eligible` and VERIFIED semantics.
- Keep Figma manual; do not add publishing or a visual pipeline.
- Discovery remains available on demand; hourly empty windows send no Telegram message.
- LLM returns a bounded action object; deterministic application code validates and performs actions.
- Preserve cross-story grounding protections from `origin/main`.
- Do not modify the concurrently active match-calendar worktree.

## Review Focus

- Discovery or community evidence must not be presented as verified fact; label copy and controls explicitly.
- A digest retry must not resend a previously delivered bucket or lose a digest after a delivery failure.
- Ambiguous or malformed LLM output must not trigger a mutation or select an unintended story.
- A requested slide/caption edit must preserve evidence identifiers and target only the active draft.
- Missed/late cron invocations must retain stable hourly windows and avoid duplicate or empty digests.

---

### Task 1: Trust-aware generation and briefing

**Files:** `supabase/functions/_shared/m6/editorial_console_actions.ts`, `briefing.ts`, `editorial_console.ts`, creative-generation handler/orchestrator/prompts/types, Telegram draft renderer, and their tests.

**Interfaces:** Add a shared `EditorialTrustState` (`VERIFIED | REPORTED | DISCOVERY`) policy. Generation accepts an optional constrained trust state and requested slide count; canonical `news_eligible` remains unchanged. Briefing candidates are ranked/presented by trust and retain source URLs.

- [x] Write RED tests for VERIFIED, credible linked single-source REPORTED, and discovery-only generation policy; include existing cross-story binding tests.
- [x] Write RED briefing tests retaining and ranking useful non-eligible stories with visible trust labels and source URLs.
- [x] Implement bounded trust derivation and policy-specific generation language/validation; discovery copy is explicitly unconfirmed.
- [x] Render trust state, source names, original URLs, and image direction in draft output.
- [x] Run targeted generation and briefing tests.

### Task 2: Hourly digest and scheduling

**Files:** new Supabase migration, orchestration worker types/boundary/queue tests, `telegram-alerts` digest selection/render/outbox code, and related tests.

**Interfaces:** Add an idempotent `EDITORIAL_DIGEST` queue job with a fixed Seoul-hour window. The alert outbox receives at most one digest event per window; empty windows create no event. FAST discovery changes from ten-minute to hourly. Digest items include trust, source name, and URL; one credible source can pass.

- [x] Add RED tests for time-window inclusion, deduplication, credible single-source inclusion, trust labels, empty suppression, and retry idempotency.
- [x] Add RED worker/boundary tests for the digest job and empty-window outcome.
- [x] Use `supabase migration new m8_7_hourly_editorial_digest` and replace only the exact prior FAST cron job while keeping the player sweep and worker schedules understood.
- [x] Implement queue dispatch, digest outbox persistence, safe rendering, and hourly Seoul bucket deduplication.
- [x] Run digest, migration architecture, and orchestration tests.

### Task 3: Chat-first Telegram intent and context

**Files:** `telegram-agent/conversation.ts`, `index.ts`, `_shared/m6/editorial_console_actions.ts`, `editorial_console.ts`, M6 OpenAI/action tests.

**Interfaces:** Add a schema-validated intent result with bounded intents, `story_position` (1–5), `slide_count` (3–4), `edit_target`, and instruction. Resolve positions only against the latest presented list/digest; resolve “this” through active story/draft. Existing callbacks and slash commands remain fallback. Unknown output falls back safely.

- [x] Add RED parser/router validation tests for all required Korean utterances, malformed output, unknown intent, and position limits.
- [x] Add RED context tests for digest/list position → story, active story → generation, active draft → targeted edit, and source display.
- [x] Implement one constrained intent parse followed by deterministic action dispatch; do not expose internal UUIDs.
- [x] Reduce story buttons to original, card-news, and source; keep slash commands/callbacks working.
- [x] Run Telegram agent/action/revision tests.

### Task 4: Full verification and deployment

**Files:** all M8.7 changes and architecture validators.

- [x] Run `./scripts/run-milestone-8-6-smoke.sh` and all new M8.7 tests.
- [x] Review complete diff, migration scheduling safety, secrets, and cross-story protections.
- [ ] Commit on `codex/m8-7-editorial-ux-reset`, push branch to origin.
- [ ] Apply pending migrations and deploy only changed Edge Functions to project `byymtttpwmllqvggnddm`.
- [ ] Verify remote migration history, deployed function versions, and Git SHA.

**Production deployment blocker:** The linked project has remote migration `20261002123351`, which is absent from the current `origin/main` and this isolated worktree; it belongs to the separate match-calendar change. `supabase db push --dry-run` refuses to proceed. Do not repair migration history or deploy functions against a mismatched schema. Recheck after Git push; if still present, leave production untouched and report the blocker.
- [ ] Report files, migration/schedule changes, exact test results, deployment state, limitations, and subagent use.
