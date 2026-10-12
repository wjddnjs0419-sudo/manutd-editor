# M8 Disposable Staging End-to-End Validation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the complete discovery-to-M9 evidence path with no more than five recent real Manchester United articles in an isolated disposable environment.

**Architecture:** Start a uniquely named local disposable Supabase stack from a temporary copy of the current migrations/config, send every Edge request through its Functions gateway, and use real RSS/publisher/article data. Run ranking and grounding for all qualifying items, call the configured AI provider only after the strict eligibility gate passes, then construct M9 input from the saved brief without invoking photo delivery, Telegram, or publishing.

**Tech Stack:** Supabase CLI/Docker, Supabase PostgREST and Functions gateway, Deno Edge Functions, Python M9 source-request builder, live publisher RSS/article HTTP.

**Spec:** `docs/superpowers/specs/2026-10-12-m8-grounding-ranking-ready-design.md` (acceptance 7 and 8).

## Global Constraints

- Use at most five real articles; preserve publisher URL and original Google News URL separately.
- Use only a disposable staging project ID and unique ports; never reset or modify production or shared local `manutd_editor`.
- Do not merge PR #8, #9, or #10; create no new PR; keep PR #10 Draft and based on PR #9.
- Do not activate Google News operations, schedules, cron, Telegram delivery, or user-facing publishing.
- Measure and report AI provider invocation count; do not call the provider for candidates that fail grounding or eligibility gates.
- Do not bypass verification criteria to obtain READY; unresolved reports remain blocked or human-review DRAFT.

## Review Focus

- Each live article is within the five-item cap and the report records its real publisher, URL, and publication time (Task 1).
- Google News feed access is a one-off validation request and does not enable any recurring collection path (Task 1).
- Body extraction failures (403, paywall, missing/empty text) remain normal exclusions with a per-item code (Task 1).
- The first ineligible candidate causes zero creative-provider calls; actual call count is observable (Task 2).
- M9 request uses the canonical publisher URL and retains the Google URL only as provenance, without photo delivery or Telegram (Task 2).

---

### Task 1: Prepare isolated staging and execute the live article-to-ranking path

**Files:**
- Use only: temporary copy of `supabase/config.toml`, `supabase/migrations`, and `supabase/seed.sql` with a unique project ID and ports.
- Operational record: `docs/superpowers/validation/<run-id>-m8-e2e.md` containing sanitized URLs, article identifiers, stage results, and timings; exclude keys, tokens, and full article body dumps.
- Exercise through real gateway endpoints: `trend-discovery` for the one-shot Google News RSS request, `promote-discovery`, `ground-claims`, and `rank-editorial`.

**Interfaces:**
- Use the existing Google News RSS discovery/resolver path in manual one-shot mode only; use resolved publisher URLs and extracted bodies.
- Per-item stage record has `article_id`, `publisher`, `publisher_url`, `google_news_url`, `published_at`, `body_status`, `claim_status`, `grounding_status`, `ranking_score`, `news_eligible`, and stable `failure_codes`.

- [ ] **Step 1: Verify no remote staging project is being targeted** and prepare a temporary Supabase workdir with a unique project ID and non-shared API/DB ports; inspect `supabase status` and resolved local endpoints before loading test data.
- [ ] **Step 2: Start the stack and apply migrations/seeds only there**; record project ID, ports, migration version, and local gateway URL. Do not use `supabase db reset` against any existing project/workdir.
- [ ] **Step 3: Fetch and resolve no more than five recent Manchester United Google News RSS items**; record RSS discovery, publisher resolution, article timestamp, article HTTP status, extraction status, and safe failure codes. Keep Google News wrapper and publisher URL in separate fields.
- [ ] **Step 4: Invoke the actual Functions gateway for promotion and grounding**, then inspect staging PostgREST rows for Google discovery role, reviewed publisher role, source URL/time, exact evidence sentence, linked report claim, and grounding status.
- [ ] **Step 5: Invoke the rank-editorial gateway URL** with the staging collector secret and ranking date; capture DNS/connect/TLS/first-byte/total timings, HTTP result, handler timings, and Data API timing. Confirm no 401; categorize any 499 by observed stalled stage.
- [ ] **Step 6: Record each article's result** across RSS → publisher URL → body → observation → report claim → evidence → grounding → editorial score; unmatched, incomplete, or weakly grounded items must be noneligible.

### Task 2: Validate candidate, creative output, and M9 handoff without delivery

**Files:**
- Exercise: `supabase/functions/creative-generation-priority/index.ts` through the disposable Functions gateway, only if an eligible candidate exists.
- Exercise: `scripts/m9_source_request_from_brief.py` and `scripts/tests/test_m9_source_request_from_brief.py`.
- Continue sanitized run record: `docs/superpowers/validation/<run-id>-m8-e2e.md`.

**Interfaces:**
- Candidate selection is read back by candidate ID, linked story ID/date, editorial rank/version/score, `news_eligible`, M4 flags, and `data_confidence`.
- AI calls are counted from the provider boundary in the staging run; zero calls is the expected result when no item qualifies.
- M9 input is built from a persisted READY or human-review brief and must include publisher URL/provenance; do not invoke photo rendering, Telegram, or public publishing.

- [ ] **Step 1: Confirm actual selected candidate rows** match same-date eligible ranking rows and contain no synthesized first-mover/must-cover flags; report each excluded candidate and reason.
- [ ] **Step 2: Call creative generation through the real gateway only for ranked eligible rows or a manually selected, verified-report review candidate**; collect authentication, grounding, scoring, and generation failure codes separately and count provider calls. Save generated output only in disposable staging.
- [ ] **Step 3: Inspect the saved brief** for Korean source-faithful summary, outlet and publisher URL, uncertainty distinction, no unsupported event assertion, and Instagram caption draft. READY requires every existing evidence gate; otherwise record BLOCKED or DRAFT.
- [ ] **Step 4: Build M9 request input** from the saved brief with `scripts/m9_source_request_from_brief.py`; assert only canonical publisher URLs are photo source pages and Google wrappers remain provenance.
- [ ] **Step 5: Run final focused verification**: all affected Deno suites, relevant Python M9 tests, full requested pgTAP set on the disposable database, plus staging gateway checks. Record exact counts and failures.
- [ ] **Step 6: Remove/discard only the disposable stack** after capturing sanitized evidence; verify production and shared local `manutd_editor` were not targeted or modified.
