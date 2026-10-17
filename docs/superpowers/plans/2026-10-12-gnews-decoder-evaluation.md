# Google News URL Decoder PoC Plan

> **For agentic workers:** This plan was executed natively in the current session.

**Goal:** Evaluate `gnews-decoder==0.1.1` against 30 recent, read-only Supabase Google News observations and report URL and article-body outcomes without changing production.

**Architecture:** Keep the network test in a standalone Python script that consumes a committed, credential-free input fixture. Add offline unit tests for URL safety, deduplication, redirects, and extraction; use a guarded Google session with concurrency 2 and no automatic redirects. Run the historical resolver separately from its Git revision, then document both live results and the prior operational baseline as distinct evidence.

**Tech Stack:** Python 3.9+, `gnews-decoder==0.1.1`, `requests`, Python `unittest`, Supabase SQL read-only query, Deno for the historical TypeScript resolver.

**Spec:** User request in this conversation, sections 2–9.

## Global Constraints

- Only read `app_private.discovery_observations`; do not change production data or settings.
- Select 30 recent, distinct `https://news.google.com/rss/articles/` URLs, including BBC, ESPN, and Yahoo Sports when available.
- Use `decode_many()` with concurrency 2; stop without retries on HTTP 429.
- Fetch no more than 10 publisher pages, with HTTPS-only bounded response reads and at most 3 manually checked redirects.
- Keep the Google URL when conversion fails; never pass it off as a publisher URL or extracted article text.
- Do not alter Google News/GDELT settings, schedules, deployment, or M8/M9 pipelines.
- Do not expose credentials or database passwords.

## Review Focus

- A malformed or non-Google input must never be sent to the resolver (offline test).
- A Google News or non-HTTPS decode result must never count as publisher success (offline test).
- Redirects to private/internal hosts and redirect loops must be stopped (offline test).
- A fetched HTML page without meaningful paragraphs must not count as body extraction (offline test).
- A Google 429 must stop queued signature requests without retries (offline test plus live run status).

## Tasks

### Task 1: Offline PoC contract

**Files:** `scripts/test_gnews_decoder_poc.py`, `scripts/gnews_decoder_poc.py`

- [ ] Write and run failing tests for safe URL classification, record deduplication, bounded redirect handling, and article excerpt extraction.
- [ ] Implement the minimum standalone test harness to pass those tests.
- [ ] Run the offline test suite in the isolated Python environment.

### Task 2: Live comparison and bounded body checks

**Files:** `scripts/fixtures/gnews-decoder-input.json`, temporary run output under `/tmp`.

- [ ] Freeze 30 recent, unique rows read from the requested Supabase table.
- [ ] Run the new batch decoder, then the historical resolver against the same URLs; stop each run at the first 429 and perform no retries.
- [ ] Fetch at most 10 successful publisher URLs and record HTTP access and body extraction separately.

### Task 3: Findings and integration assessment

**Files:** `docs/gnews-decoder-evaluation.md`.

- [ ] Record exact run counts, timings, per-article outcomes, failure causes, prior 0/1,206 production evidence, and non-equivalent baselines.
- [ ] Assess Edge Function versus M9 Python pipeline fit, cache boundaries, failure preservation, request volume, and unofficial endpoint risk.
- [ ] Verify only PoC files changed beyond the pre-existing user worktree edits.
