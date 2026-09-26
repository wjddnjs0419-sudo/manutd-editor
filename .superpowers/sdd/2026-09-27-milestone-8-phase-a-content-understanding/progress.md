# SDD ledger — plan: docs/superpowers/plans/2026-09-27-milestone-8-phase-a-content-understanding.md

## Setup

- Execution method: native inline execution on `main`, per-task TDD and commits.
- Spec: `docs/superpowers/specs/2026-09-27-milestone-8-phase-a-content-understanding-design.md` (reviewed and committed).
- Plan: `docs/superpowers/plans/2026-09-27-milestone-8-phase-a-content-understanding.md` (self-reviewed; production rollout is a final authorized operation only after local verification).

## Pre-flight shared interfaces

- Task 1 → Task 4: the migration produces `app_private.content_understandings`, its unique input boundary, and service-role API access; the analysis repository must use those exact column names and the same uniqueness boundary.
- Task 1 → Task 5: the migration adds `ANALYZE_CONTENT` to the queue allowlist; TypeScript worker types and boundary routing must add the same literal without changing existing job statuses or retry behavior.
- Task 2 → Task 3: the domain output/claim/media types and validation states are the provider's return contract; provider output must remain strict-schema compatible with those types.
- Task 3 → Task 4: the private media reader returns only in-memory bytes/data URI/hash and the provider returns safe categorized errors; the orchestrator must not reintroduce URLs or raw upstream errors.
- Task 4 → Task 5: the handler accepts a bounded empty/`as_of` request and returns safe status summaries; the worker boundary client may send only that request shape and consume status-only responses.
- Task 1/4 → Task 6: Intelligence reads only service-role `SUCCEEDED`/`PARTIAL` current-contract rows and falls back when no row exists; it must not make the private table public or change raw-post contracts.
- Task 6 → Task 7: the integration smoke consumes the extended worker chain and optional enriched features; the legacy caption-only path remains the baseline.

No pre-flight interface conflict found; the plan's producer/consumer names are consistent. Continue with the smallest implementation satisfying the spec.

Ruling: `task-start`/`task-done` helper scripts referenced by executing-plans are not present in the installed skill package — read the exact Task 1 brief directly from the committed plan and will record equivalent test/commit evidence manually in this ledger; cost if wrong: the helper would otherwise only automate bookkeeping, not implementation or verification.

Task 1: Ruling: the initial pgTAP test declared 36 assertions but contained 34; corrected the test plan to 34 after the migration made all assertions pass — cost if wrong: a stale plan count would report a false test failure.

Task 1: complete (commit 3e38d85, tests: `supabase test db --local supabase/tests/database/019_m8_phase_a_content_understanding_test.sql` → 34/34 pass)

Task 2: Ruling: the first whole-suite Deno command omitted `--allow-env`/`--allow-net`, so two pre-existing integration tests failed before execution; reran in the repository's Docker harness with `supabase/functions/.env.local` and both permissions — cost if wrong: the initial result would misclassify a harness invocation error as a regression.

Task 2: complete (commit pending, focused tests: 9/9 pass; whole suite: 281/281 pass)

Task 3: complete (commit pending, focused tests: 9/9 pass; private Storage reader and structured provider verified for image/carousel/thumbnail-safe inputs, bounded media, SHA-256, strict schema, retry, timeout, and redaction)

Task 4: complete (commit pending, focused tests: 8/8 pass; repository, fingerprint idempotency, bounded concurrency, failure isolation, authenticated handler, and `verify_jwt = false` function wiring verified)

Task 5: complete (commit pending, focused tests: 14/14 pass; `COLLECT_INSTAGRAM -> ANALYZE_CONTENT -> RUN_INTELLIGENCE`, stable dedupe keys, failure isolation, collector-secret boundary, and bounded request mapping verified)
