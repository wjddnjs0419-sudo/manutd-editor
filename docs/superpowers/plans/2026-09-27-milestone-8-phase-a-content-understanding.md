# M8 Phase A Content Understanding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native execution is selected) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned, server-only multimodal Instagram analysis layer and connect it between the existing M7 collector and intelligence stages while preserving raw input, private media, and M4 deterministic scoring.

**Architecture:** A new `app_private.content_understandings` table stores validated, versioned semantic results keyed by raw post, contract, and input fingerprint. A bounded `analyze-content` Edge Function reads recent raw posts and private cached assets, invokes an injected/structured OpenAI Responses provider, and persists per-post outcomes. M7 adds one batch `ANALYZE_CONTENT` stage before one `RUN_INTELLIGENCE` stage; Intelligence consumes the analysis as optional feature enrichment and falls back to caption-only behavior.

**Tech Stack:** Supabase Postgres 17/pgTAP, Supabase Edge Functions on Deno 2.1.4, TypeScript, Supabase Storage service-role download, OpenAI Responses JSON Schema structured output, shell smoke tests, and existing M7 queue/worker conventions.

**Spec:** `docs/superpowers/specs/2026-09-27-milestone-8-phase-a-content-understanding-design.md`

## Global Constraints

- Keep implementation and commits on `main`; do not create a branch or worktree.
- Keep `raw_posts` raw and canonical; never overwrite source fields with AI output.
- Keep `instagram-analysis` private; never persist public media URLs, signed URLs, tokens, or raw upstream error bodies.
- Use one bounded `ANALYZE_CONTENT` batch job per collection chain and one downstream `RUN_INTELLIGENCE` job; never enqueue one full intelligence run per post.
- Same `(raw_post_id, analysis_version, input_fingerprint)` is idempotent; changed caption/media creates a new auditable fingerprint/versioned row.
- Claims represent what Instagram claims, not verified facts; preserve origin and evidence and defer verification to M8-B.
- Reels use caption plus thumbnail only; no full video download, frame extraction, or speech-to-text.
- Preserve existing caption extraction, story clustering compatibility, M4 Priority Score, readiness, queue leases/retries, and M7 downstream stages.
- Deterministic CI must not require live Meta, OpenAI, Notion, Telegram, or remote Supabase.
- Production rollout is a final post-verification operation explicitly authorized by the user; do not run it before all local checks pass and do not register external webhooks.

## Review Focus

- A weak caption with strong visual text must produce visual entities/numbers/claims and a combined story; covered by the golden image fixture and provider/orchestrator tests.
- Carousel slide order and slide-3 evidence must survive normalization and persistence; covered by ordered-media and claim-evidence tests.
- A repeated analysis of unchanged input must not call the model twice, while caption/media changes must create different fingerprints; covered by fingerprint/idempotency tests.
- Missing/oversized/private media and provider timeout/rate-limit/malformed output must yield safe per-post outcomes without blocking the batch; covered by media/provider/orchestrator tests.
- Intelligence with no analysis row must behave exactly as the existing caption-only path; covered by fallback feature and orchestrator regression tests.

---

### Task 1: Canonical Analysis Table and Queue Contract

**Files:**
- Create: `supabase/migrations/20260927170000_milestone_8_phase_a_content_understanding.sql`
- Create: `supabase/tests/database/019_m8_phase_a_content_understanding_test.sql`

**Interfaces:**
- Produces `app_private.content_understandings` with the schema and unique key from the spec.
- Extends `app_private.editorial_jobs` and `public.enqueue_editorial_job` to accept `ANALYZE_CONTENT`.
- Keeps all analysis table and queue privileges service-role-only.

- [ ] **Step 1: Write the failing pgTAP contract test**

  Assert the table columns/types/checks, JSON defaults, analysis confidence range, unique constraint, raw-post foreign key, updated-at trigger, RLS, absence of anon/authenticated table privileges, and service-role CRUD. Assert the queue check and enqueue RPC accept `ANALYZE_CONTENT` while rejecting an unknown type. Insert two identical analysis rows and assert the unique boundary rejects the duplicate; insert a changed fingerprint and assert historical rows coexist.

- [ ] **Step 2: Run the database test to verify it fails**

  Run: `supabase db reset --local && supabase test db --local supabase/tests/database/019_m8_phase_a_content_understanding_test.sql`

  Expected: FAIL because the analysis table and new job type do not exist.

- [ ] **Step 3: Implement the migration**

  Create the private table with safe JSON/check constraints, the service-role grants/RLS, the `updated_at` trigger, and indexes on `(raw_post_id, analysis_version, created_at desc)` and current input lookup. Replace the final M7 queue job-type constraint and enqueue allowlist with the existing types plus `ANALYZE_CONTENT`; do not alter job status, retry, lease, or dead-letter semantics.

- [ ] **Step 4: Run the focused database test to verify it passes**

  Run: `supabase db reset --local && supabase test db --local supabase/tests/database/019_m8_phase_a_content_understanding_test.sql`

  Expected: all schema, idempotency, and privilege assertions pass.

- [ ] **Step 5: Commit the database contract**

  Run: `git add supabase/migrations/20260927170000_milestone_8_phase_a_content_understanding.sql supabase/tests/database/019_m8_phase_a_content_understanding_test.sql && git commit -m "feat: add M8 content understanding schema"`

### Task 2: Analysis Domain Contracts, Fingerprints, and Golden Fixtures

**Files:**
- Create: `supabase/functions/analyze-content/types.ts`
- Create: `supabase/functions/analyze-content/fingerprint.ts`
- Create: `supabase/functions/analyze-content/validation.ts`
- Create: `supabase/functions/tests/fixtures/m8_phase_a.ts`
- Create: `supabase/functions/tests/analyze-content/fingerprint_test.ts`
- Create: `supabase/functions/tests/analyze-content/validation_test.ts`

**Interfaces:**
- `inputFingerprint(input: FingerprintInput): Promise<string>` returns a SHA-256 hex digest of stable canonical JSON containing raw post identity, caption/media mode, ordered asset descriptors, and downloaded media hashes.
- `validateAnalysisOutput(value, context): ValidatedAnalysis` accepts only bounded schema-valid semantic output and server-selected visual mode.
- Domain types represent `ContentUnderstandingStatus`, `ClaimOrigin`, `EvidenceState`, ordered `AnalysisMediaInput`, `ContentClaim`, `ContentUnderstandingOutput`, `AnalysisContract`, and safe `AnalysisFailure` categories.

- [ ] **Step 1: Write failing fingerprint/validation tests**

  Assert deterministic property-order-independent fingerprints; changed caption and changed media hash produce different fingerprints; carousel asset order is significant; the golden fixture captures a weak caption, a former Manchester United player, a three-month numeric contrast, lower-league facilities, explicit claims, and slide evidence; malformed claims, invalid origins, out-of-range confidences, missing state fields, oversized arrays, and wrong Reel visual modes are rejected.

- [ ] **Step 2: Run focused tests to verify they fail**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/analyze-content/fingerprint_test.ts functions/tests/analyze-content/validation_test.ts`

  Expected: FAIL because the domain modules and fixture do not exist.

- [ ] **Step 3: Implement stable fingerprinting and strict domain validation**

  Normalize only deterministic input metadata and byte hashes; never include private URLs or secrets in the canonical fingerprint. Bound text lengths, list counts, slide indexes, evidence references, and confidence values. Keep claims as extracted post assertions with origin/evidence, and retain `OBSERVED`, `INFERRED`, and `UNAVAILABLE` field states.

- [ ] **Step 4: Run focused tests to verify they pass**

  Run the same Deno command; expected: PASS.

- [ ] **Step 5: Commit the domain contract**

  Run: `git add supabase/functions/analyze-content supabase/functions/tests/fixtures/m8_phase_a.ts supabase/functions/tests/analyze-content/fingerprint_test.ts supabase/functions/tests/analyze-content/validation_test.ts && git commit -m "feat: define M8 analysis contracts"`

### Task 3: Private Media Reader and Structured Multimodal Provider

**Files:**
- Create: `supabase/functions/analyze-content/config.ts`
- Create: `supabase/functions/analyze-content/media.ts`
- Create: `supabase/functions/analyze-content/provider.ts`
- Create: `supabase/functions/analyze-content/prompts.ts`
- Create: `supabase/functions/tests/analyze-content/media_test.ts`
- Create: `supabase/functions/tests/analyze-content/provider_test.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- `createPrivateMediaReader(options).read(asset): Promise<PrivateMediaInput>` downloads from the configured private Storage bucket, validates MIME/size/path, returns bytes/data URI plus SHA-256, and never returns a URL.
- `createContentUnderstandingProvider(options).analyze(input): Promise<ContentUnderstandingOutput>` sends caption plus ordered image inputs to the Responses endpoint using strict JSON Schema and safe categorized errors.
- `resolveContentUnderstandingConfig(readEnv)` parses model, prompt, timeout, max bytes/slides, batch size, and concurrency with bounded defaults.

- [ ] **Step 1: Write failing media/provider tests**

  Test IMAGE input, ordered carousel inputs, Reel thumbnail-only input, missing media, oversized media, invalid path/MIME, and SHA-256. Stub `fetch` to assert the Responses request contains no source URL and uses `store: false`, configured model, strict JSON schema, caption text, and image data. Add malformed JSON, missing output text, timeout, 429, 5xx, and secret-redaction assertions. Verify weak-caption golden input can express visual text and claims without a live model.

- [ ] **Step 2: Run focused tests to verify they fail**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/analyze-content/media_test.ts functions/tests/analyze-content/provider_test.ts`

  Expected: FAIL because the media/provider modules do not exist.

- [ ] **Step 3: Implement private media access and provider**

  Use the service-role Storage client’s `download` method, not signed URLs. Enforce the private bucket name, supported image MIME types, max byte count, and carousel slide cap. Mirror the existing Responses structured-output request/retry pattern while keeping M8-specific schema/prompt/configuration in this module; provider errors expose only safe category/status metadata.

- [ ] **Step 4: Run focused tests to verify they pass**

  Run the same Deno command; expected: PASS.

- [ ] **Step 5: Commit media/provider support**

  Run: `git add supabase/functions/analyze-content/config.ts supabase/functions/analyze-content/media.ts supabase/functions/analyze-content/provider.ts supabase/functions/analyze-content/prompts.ts supabase/functions/tests/analyze-content/media_test.ts supabase/functions/tests/analyze-content/provider_test.ts .env.example README.md && git commit -m "feat: add private multimodal analysis provider"`

### Task 4: Analysis Repository, Orchestrator, Handler, and Edge Function

**Files:**
- Create: `supabase/functions/analyze-content/repository.ts`
- Create: `supabase/functions/analyze-content/orchestrator.ts`
- Create: `supabase/functions/analyze-content/handler.ts`
- Create: `supabase/functions/analyze-content/index.ts`
- Modify: `supabase/config.toml`
- Create: `supabase/functions/tests/analyze-content/orchestrator_test.ts`
- Create: `supabase/functions/tests/analyze-content/handler_test.ts`
- Create: `supabase/functions/tests/analyze-content/repository_test.ts`

**Interfaces:**
- `AnalysisRepository.listCandidates(asOf, limit, contract): Promise<readonly AnalysisCandidate[]>` reads recent raw posts and ordered media metadata plus exact current-contract existing rows through service-role REST.
- `AnalysisRepository.save(input): Promise<void>` persists one validated row with `on_conflict` behavior consistent with the unique input boundary.
- `runContentAnalysis(options): Promise<AnalysisBatchSummary>` processes candidates with bounded concurrency, skips exact fingerprints, writes safe success/partial/unavailable/failed rows, and never throws one post’s provider/media failure over the batch.
- `createAnalyzeContentHandler(dependencies)` authenticates the existing collector secret, accepts an empty POST or bounded `{as_of, limit}` body, and returns only a safe batch summary.

- [ ] **Step 1: Write failing orchestration/handler/repository tests**

  Cover the four requested fixture classes: weak caption/strong visual, useful caption/useful visual, carousel slide 3 key fact, and Reel thumbnail-only. Assert duplicate requests call the provider once, changed fingerprints create a new row, missing media creates partial/unavailable output, one failed post does not block another, and errors/logs omit `OPENAI_API_KEY`, bearer values, source URLs, signed URL patterns, and raw upstream bodies. Handler tests cover auth, method/body validation, and safe response fields. Repository tests assert `app_private` profile headers, exact select/upsert payloads, and no public media URL output.

- [ ] **Step 2: Run focused tests to verify they fail**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/analyze-content/orchestrator_test.ts functions/tests/analyze-content/handler_test.ts functions/tests/analyze-content/repository_test.ts`

  Expected: FAIL because the analysis runtime modules do not exist.

- [ ] **Step 3: Implement repository, orchestration, and authenticated function**

  Query only a bounded recent window, select current-contract latest rows, and compute media hashes before the exact fingerprint lookup. If an exact row exists, skip the provider. Persist semantic output and safe failure categories with historical uniqueness. Use `Promise.all` only over the configured small concurrency and return per-post counts. Add `[functions.analyze-content] verify_jwt = false` and construct the service-role client/provider from env in `index.ts`.

- [ ] **Step 4: Run focused tests to verify they pass**

  Run the same Deno command; expected: PASS.

- [ ] **Step 5: Commit the analysis function**

  Run: `git add supabase/functions/analyze-content supabase/functions/tests/analyze-content supabase/config.toml && git commit -m "feat: add analyze content edge function"`

### Task 5: M7 Batch Stage Chaining

**Files:**
- Modify: `supabase/functions/orchestration-worker/types.ts`
- Modify: `supabase/functions/orchestration-worker/worker.ts`
- Modify: `supabase/functions/orchestration-worker/boundary_client.ts`
- Modify: `supabase/functions/tests/orchestration-worker/worker_test.ts`
- Modify: `supabase/functions/tests/orchestration-worker/boundary_client_test.ts`

**Interfaces:**
- `EditorialJobType` includes `ANALYZE_CONTENT`.
- Worker stage map is `COLLECT_INSTAGRAM -> ANALYZE_CONTENT -> RUN_INTELLIGENCE`.
- Boundary map invokes `analyze-content` with the collector secret and status-only response handling.

- [ ] **Step 1: Write failing worker/boundary tests**

  Assert collection success enqueues exactly one `ANALYZE_CONTENT` job, analysis success enqueues exactly one stable `RUN_INTELLIGENCE` job, repeated processing does not duplicate either key, analysis failure does not enqueue intelligence, and existing intelligence/fixture/morning stages retain their behavior. Assert the boundary path, secret class, and bounded request body for `ANALYZE_CONTENT`.

- [ ] **Step 2: Run focused tests to verify they fail**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/orchestration-worker/worker_test.ts functions/tests/orchestration-worker/boundary_client_test.ts`

  Expected: FAIL because the new type and stage map are absent.

- [ ] **Step 3: Implement the minimal worker/boundary extension**

  Add only the new type, endpoint, request-body mapping, and two stage edges. Reuse existing per-job failure isolation, safe status-only boundary responses, stable chain keys, and completion ordering. Do not move analysis logic into the worker.

- [ ] **Step 4: Run focused tests to verify they pass**

  Run the same Deno command; expected: PASS.

- [ ] **Step 5: Commit the M7 integration**

  Run: `git add supabase/functions/orchestration-worker supabase/functions/tests/orchestration-worker && git commit -m "feat: insert multimodal analysis into M7 chain"`

### Task 6: Intelligence Feature Enrichment with Caption Fallback

**Files:**
- Modify: `supabase/functions/intelligence/types.ts`
- Modify: `supabase/functions/intelligence/features.ts`
- Modify: `supabase/functions/intelligence/clustering.ts`
- Modify: `supabase/functions/intelligence/repository.ts`
- Modify: `supabase/functions/intelligence/orchestrator.ts`
- Modify: `supabase/functions/intelligence/ai_classifier.ts`
- Modify: `supabase/functions/tests/intelligence/features_test.ts`
- Modify: `supabase/functions/tests/intelligence/clustering_test.ts`
- Modify: `supabase/functions/tests/intelligence/orchestrator_test.ts`
- Modify: `supabase/functions/tests/intelligence/repository_test.ts`

**Interfaces:**
- `extractStoryFeatures(caption, publishedAt, dictionary, multimodal?)` preserves existing output for omitted `multimodal` and enriches entities/events/sources/numbers/tokens when present.
- `RecentRawPost.contentUnderstanding?: RecentContentUnderstanding` is optional and safe when the app-private row is absent.
- `ClusterSignature` carries bounded multimodal summary context without invalidating old signatures.

- [ ] **Step 1: Write failing enrichment/fallback tests**

  Assert visually discovered entities, topics, source names, important numbers, and combined-summary tokens affect features/signatures; assert slide/order evidence is not flattened incorrectly; assert the same existing caption-only inputs produce the prior feature shape and an intelligence run succeeds with no analysis rows. Assert repository makes a separate app-private request and treats an empty/missing response as fallback.

- [ ] **Step 2: Run focused intelligence tests to verify they fail**

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/intelligence/features_test.ts functions/tests/intelligence/clustering_test.ts functions/tests/intelligence/orchestrator_test.ts functions/tests/intelligence/repository_test.ts`

  Expected: FAIL because the current intelligence types/repository/features do not consume M8 rows.

- [ ] **Step 3: Implement optional multimodal enrichment**

  Keep caption normalization as the base. Normalize semantic terms deterministically, merge topics through the existing event/topic channel without changing M4 score SQL, and add bounded combined-summary context to clustering signatures. Fetch only the latest `SUCCEEDED`/`PARTIAL` current-contract row through `app_private` with service-role headers; tolerate no row, unavailable, or malformed optional analysis by using caption-only features.

- [ ] **Step 4: Run focused intelligence tests to verify they pass**

  Run the same Deno command; expected: PASS.

- [ ] **Step 5: Commit intelligence enrichment**

  Run: `git add supabase/functions/intelligence supabase/functions/tests/intelligence && git commit -m "feat: enrich intelligence with multimodal features"`

### Task 7: Phase A Smoke, Regression, and Documentation Verification

**Files:**
- Create: `supabase/tests/integration/milestone_8_phase_a_integration_test.ts`
- Create: `scripts/run-milestone-8-phase-a-smoke.sh`
- Modify: `README.md`
- Modify: `.env.example` if configuration documentation is incomplete

**Interfaces:**
- The smoke runner resets only local Supabase, runs database contract tests, focused M8 tests, M7 worker tests, intelligence regression tests, repository validators, and secret scans without external calls.
- The integration test proves one collection root maps to one analysis batch and one intelligence job using mocked boundaries and the synthetic golden fixture.

- [ ] **Step 1: Write failing parity/smoke assertions**

  Assert the old M7 chain remains intact after the new stage, one `ANALYZE_CONTENT` job leads to one `RUN_INTELLIGENCE`, per-post analysis failures do not deadlock the chain, content-understanding rows are private, no secrets/URLs leak, and caption-only intelligence remains green.

- [ ] **Step 2: Run the smoke assertions to verify they fail**

  Run: `supabase db reset --local && ./scripts/run-milestone-8-phase-a-smoke.sh`

  Expected: FAIL until the integration runner and all Phase A contracts are complete.

- [ ] **Step 3: Implement local-only smoke runner and docs**

  Use the existing Docker Deno 2.1.4 convention and local Supabase ports. Reject non-local URLs, do not read or print production secrets, do not invoke OpenAI/Meta/Notion/Telegram, and document the new env/config and pipeline in README.

- [ ] **Step 4: Run Phase A smoke and full repository verification**

  Run: `./scripts/run-milestone-8-phase-a-smoke.sh`

  Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests`

  Run: `node --test scripts/validate-n8n-workflow.test.mjs && git diff --check`

  Expected: all database, M8, M7, intelligence, and existing repository tests pass; n8n historical exports remain unchanged and no whitespace errors exist.

- [ ] **Step 5: Commit Phase A verification**

  Run: `git add supabase/tests/integration/milestone_8_phase_a_integration_test.ts scripts/run-milestone-8-phase-a-smoke.sh README.md .env.example && git commit -m "test: add M8 phase A smoke verification"`

### Task 8: Final Local Review and Authorized Production Rollout

**Files:**
- No new source files; inspect committed diff and deployment state.

**Interfaces:**
- Production database receives the committed migrations through the configured linked Supabase project.
- Production receives the `analyze-content` and all modified Edge Functions through the existing Supabase CLI deployment path.

- [ ] **Step 1: Verify final local state before rollout**

  Run: `git status --short --branch`, `git log --oneline -12`, `git diff --check`, and the complete smoke/full test commands from Task 7. Confirm no pending uncommitted changes, no production URL was used in tests, and no secret-like literals were introduced.

- [ ] **Step 2: Verify the configured remote target without mutating it**

  Run the Supabase CLI read-only status/link inspection available in this environment. Confirm the linked project is the intended production target and that the CLI has a usable authenticated session. If the target or credentials are unavailable, stop and report the exact missing external prerequisite rather than deploying elsewhere.

- [ ] **Step 3: Apply database migrations to the intended production project**

  Run: `supabase db push --linked`

  Expected: the M8 Phase A migration applies cleanly; do not use `--include-all` or destructive reset commands against the remote project.

- [ ] **Step 4: Deploy the new and modified Edge Functions**

  Deploy `analyze-content`, `orchestration-worker`, and `intelligence` with the existing project ref/link and no secrets in command arguments. Deploy `collect-instagram` only if its source changed; otherwise leave it untouched. Verify deploy responses without printing credentials.

- [ ] **Step 5: Verify production schema/function health read-only**

  Use safe read-only checks against the intended project to confirm the private analysis table exists, anon/authenticated cannot access it, the worker job type is accepted, and deployed function endpoints return safe auth errors when called without credentials. Do not invoke live Meta/OpenAI analysis as part of this smoke unless the existing production runbook explicitly requires it.

- [ ] **Step 6: Report rollout result and preserve rollback information**

  Record the applied migration name, deployed function names, local test summary, and any remote verification limitation. Do not register Telegram webhooks or change unrelated production state.

## Final verification ledger

- [ ] `main` contains only the M8 Phase A implementation and documentation commits.
- [ ] Local database contract, focused Deno, full Deno, M7, intelligence, n8n validator, and diff checks pass.
- [ ] Private media and app-private analysis permissions are preserved.
- [ ] No live OpenAI requirement exists in deterministic CI tests.
- [ ] Production rollout, if the configured target is available, happened only after all prior checks and is reported with exact migration/function names.
