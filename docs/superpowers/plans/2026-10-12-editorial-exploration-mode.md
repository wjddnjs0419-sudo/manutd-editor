# Editorial Exploration Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a default-off Exploration Mode that uses recent publisher article text to create review-only DRAFT briefs while preserving strict VERIFIED/READY rules and existing M6–M9 contracts.

**Architecture:** Extend the current observation-to-candidate-to-creative-generation path. Add an explicit generation intent, separate article evidence and DRAFT quality gate, stable story-level deduplication, and an atomic daily quota using the existing generation job table. Wire Telegram and manual M9 preview through their existing entry points; keep PR #8's READY-only automation unchanged.

**Tech Stack:** Deno 2 / TypeScript, Supabase PostgREST and additive PostgreSQL migrations, Python M9 preview scripts, GitHub Actions workflow_dispatch.

**Spec:** `docs/superpowers/specs/2026-10-12-editorial-exploration-mode-design.md`

## Global Constraints

- `EDITORIAL_EXPLORATION_MODE` defaults to `false`.
- Exploration DRAFTs are capped at 10 per Asia/Seoul business day and 72-hour publication age.
- Manual historical review is capped at 30 candidates; no automatic historical backfill.
- Exploration DRAFTs never become VERIFIED or READY and are never auto-posted.
- Existing READY evidence requirements, M8 job types, Telegram callback contracts, and M9 PR #8 scheduler remain intact.
- No production/shared database mutation, live provider call without disposable-staging credentials, live Telegram send, or Instagram publish.

## Review Focus

- Article URL, publisher, text, or extraction marker missing: block before classifier/generator call; cover in Task 1.
- Unapproved report or rumor: retain publisher attribution and modality in slides/caption; never satisfy strict READY evidence; cover in Task 2.
- Same story across date-scoped candidate IDs or concurrent requests: return the existing brief / reject the second reservation; cover in Task 3.
- Archived, excluded, irrelevant, stale-only, or >72-hour story: do not auto-generate; cover in Task 3 and Task 4.
- DRAFT chosen or previewed: preserve SELECTED semantics, keep it out of PR #8 polling, and require explicit M9 preview opt-in; cover in Task 4 and Task 5.

---

### Task 1: Exploration configuration and article evidence

**Files:**
- Create: `supabase/functions/creative-generation/exploration.ts`
- Modify: `supabase/functions/creative-generation/types.ts`
- Modify: `supabase/functions/creative-generation/evidence.ts`
- Modify: `supabase/functions/creative-generation/repository.ts`
- Modify: `supabase/functions/source-discovery/orchestrator.ts`
- Test: `supabase/functions/tests/creative-generation/exploration_test.ts`
- Test: `supabase/functions/tests/creative-generation/repository_test.ts`
- Test: `supabase/functions/tests/source-discovery/orchestrator_test.ts`

- [x] Write tests for default-off config, URL/body/published-at evidence requirements, and extracted-page markers.
- [x] Run those tests and confirm the missing policy/evidence behavior fails.
- [x] Add bounded `ExplorationArticleEvidence` and gather it only from existing source/discovery observations with publisher identity and extraction metadata.
- [x] Mark a feed item `EXTRACTED` only when a publisher-page fetch supplied the excerpt; otherwise preserve `FEED_SUMMARY`.
- [x] Run the three focused tests and verify missing-body/title-only records never qualify.

### Task 2: Explicit DRAFT intent and quality gate

**Files:**
- Modify: `supabase/functions/creative-generation/orchestrator.ts`
- Modify: `supabase/functions/creative-generation/prompts.ts`
- Modify: `supabase/functions/creative-generation/quality_gate.ts`
- Modify: `supabase/functions/creative-generation/handler.ts`
- Modify: `supabase/functions/creative-generation/provider.ts`
- Modify: `supabase/functions/creative-generation/classifier.ts`
- Test: `supabase/functions/tests/creative-generation/orchestrator_test.ts`
- Test: `supabase/functions/tests/creative-generation/quality_gate_test.ts`
- Test: `supabase/functions/tests/creative-generation/handler_test.ts`
- Test: `supabase/functions/tests/creative-generation/provider_test.ts`

- [x] Add failing tests that exploration forces DRAFT for NEWS_UPDATE, ANALYSIS_CONTEXT, and MATCH_CONTENT while STANDARD READY behavior remains unchanged.
- [x] Add failing tests for rumor attribution, exact publisher URL, 3–5 slides, at most five hashtags, and no title-only generation.
- [x] Implement the explicit `generation_intent` request field and separate Exploration DRAFT quality checks without changing `verifiedNewsSources()`.
- [x] Include article evidence and uncertainty instructions in the prompt; preserve source text, URL, publication time, and review caveats in the saved snapshot.
- [x] Capture provider calls, tokens, retries, repairs, and configured cost estimates in job/brief metrics; add no live provider tests.
- [x] Run focused creative-generation tests and verify existing trigger types still parse unchanged.

### Task 3: Idempotency, leases, daily cap, and latest-news selection

**Files:**
- Modify: `supabase/functions/creative-generation/repository.ts`
- Modify: `supabase/functions/creative-generation/orchestrator.ts`
- Modify: `supabase/functions/creative-generation-priority/index.ts`
- Create: `supabase/migrations/20261012150000_editorial_exploration_generation.sql`
- Test: `supabase/functions/tests/creative-generation/repository_test.ts`
- Test: `supabase/functions/tests/creative-generation/orchestrator_test.ts`
- Test: `supabase/tests/database/027_editorial_exploration_generation_test.sql`

- [x] Test stable evidence fingerprints across ranking dates, retries, duplicate requests, and an existing READY brief.
- [x] Test eligibility order: latest 24 hours first, 24–72 hours second, stale only with a newly published article, ARCHIVED excluded, 72-hour-old excluded.
- [x] Add additive intent/usage fields and a service-only atomic lease/quota RPC; retain `creative_generation_jobs` and its existing lease contract.
- [x] Add a partial unique fingerprint for Exploration source/story evidence so concurrent/date-scoped candidates cannot save duplicate briefs.
- [x] Reuse `GENERATE_PRIORITY`; when the flag is on, run existing strict READY candidates plus up to the remaining ten Exploration DRAFT reservations.
- [x] Test failed lease recovery, expired lease, concurrent reservation, daily limit, existing DRAFT reuse, and READY non-demotion on a disposable database only.

### Task 4: Telegram compatibility and manual DRAFT generation

**Files:**
- Modify: `supabase/functions/_shared/m6/editorial_console.ts`
- Modify: `supabase/functions/_shared/m6/editorial_console_actions.ts`
- Modify: `supabase/functions/_shared/m6/console_generation.ts`
- Modify: `supabase/functions/telegram-agent/index.ts`
- Test: `supabase/functions/tests/m6/editorial_console_test.ts`
- Test: `supabase/functions/tests/telegram-agent/console_actions_test.ts`
- Test: `supabase/functions/tests/telegram-agent/index_test.ts`

- [x] Add failing tests for non-eligible article-backed manual DRAFT, no-body rejection, and READY/NOOP/DRAFT response parsing.
- [x] When the flag is off, preserve the current `news_eligible` and evidence blocks.
- [x] When on, let the canonical generator make the article-evidence decision and render DRAFT with source/modality labeling.
- [x] Preserve trend snapshot queries, `DISCOVER_TRENDS` MANUAL profile/max-8, skip fingerprints, SELECTED state, and all callback strings.
- [x] Run Telegram/M6 tests and verify DRAFT cannot enter the existing READY-only auto preview response path.

### Task 5: Explicit M9 DRAFT preview path

**Files:**
- Modify: `.github/workflows/m9-private-preview.yml`
- Modify: `scripts/m9_run_pipeline.py`
- Modify: `scripts/m9_preview_workflow.py`
- Modify: `supabase/functions/telegram-agent/index.ts`
- Test: `scripts/tests/test_m9_preview_workflow.py`
- Test: `supabase/functions/tests/telegram-agent/index_test.ts`
- Read-only compatibility check: PR #8 `.github/workflows/m9-auto-preview.yml`

- [x] Test that the manual M9 loader rejects DRAFT by default and accepts only an explicit DRAFT-preview option.
- [x] Add an explicit Telegram preview action that dispatches the existing manual workflow in upload-only mode and reports its run URL.
- [x] Require configured, narrowly scoped GitHub Actions dispatch credentials; keep Telegram send as a separate explicit workflow mode.
- [x] Keep PR #8 workflow and its READY query unchanged; test its source diff remains empty and DRAFT cannot enter its poller.
- [x] Add only the required font/rendering support for existing Pretendard Bold cover/headings and SemiBold body, with renderer tests.

### Task 6: Usage reporting, docs, and regressions

**Files:**
- Modify: `docs/gnews-resolution-pipeline-runbook.md`
- Create: `docs/editorial-exploration-mode.md`
- Modify tests only where a current failure is shown to be a stale fixture; do not remove tests or weaken assertions.

- [x] Document configuration, DRAFT vs READY, cost fields, explicit preview controls, and disabled-by-default deployment.
- [x] Re-run all creative, source/trend, M8 Telegram, orchestration, and M9 tests.
- [x] Re-run the full Deno suite: 656 passed; the M4 scoring and media storage integration tests require SUPABASE_URL and SUPABASE_SECRET_KEY and could not run without a local API stack. The two stale M6 revision fixtures were repaired with strict source data and now pass.
- [x] Validate additive SQL on a disposable database: migration applied and pgTAP passed 17/17; shared `manutd_editor` was not modified.
- [x] Check provider credential names without printing values; run zero real provider calls unless a disposable staging credential set is present.
- [x] Verify no PR #8 workflow diff, no PR #9 changes, no live Telegram sends or Instagram publish, and PR #10 remains Draft.
- [x] Commit and push only to the existing PR #10 branch, then confirm PR #10 remains open and Draft.
