# Milestone 5 Grounded Creative Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade, evidence-grounded Instagram Carousel generation subsystem from M4 candidates through deterministic classification, OpenAI structured output, quality validation, immutable Creative Brief revisions, and Notion Content Pipeline handoff.

**Architecture:** Additive Supabase migration plus a server-only `creative-generation` Edge Function composed of evidence, classifier, provider, quality-gate, and orchestration modules. Reuse the existing Notion client and Daily Intelligence mapping while adding a server-side Selected poll and Content Pipeline projection; n8n only invokes functions.

**Tech Stack:** Supabase/Postgres/pgTAP, Deno 2.1.4, TypeScript, OpenAI Responses API, strict JSON Schema structured outputs, existing Notion API client, n8n JSON workflow validation.

**Spec:** `docs/superpowers/specs/2026-09-18-milestone-5-creative-generation-design.md`

## Global Constraints

- M5 generation may use only M4 canonical internal evidence; no external web search or enrichment.
- Output language is Korean by default; natural proper names and football terminology may remain English.
- Instagram Carousel only: exactly 3 hooks and 4–7 slides.
- Deterministic classifier first; AI classifier fallback only for ambiguity and below-threshold output stops generation.
- Classifier and generator models/configs are separate, versioned, and never silently substituted.
- Existing `public.creative_briefs` remains append-only revision storage; do not replace or duplicate existing columns.
- Every FACT and INFERENCE claim must reference evidence in the frozen snapshot.
- Exactly one repair attempt is allowed; no second repair.
- Notion human-owned fields must never be overwritten; projection failure must not roll back READY briefs.
- Secrets never enter git, n8n exports, logs, or provider error storage.
- Each task follows RED → GREEN → focused regression → commit.

---

### Task 1: M5 data contract and generation configuration

**Files:**
- Create: `supabase/migrations/20260918170000_milestone_5_creative_generation.sql`
- Modify: `supabase/seed.sql`
- Create: `supabase/tests/database/010_milestone_5_creative_generation_test.sql`

**Interfaces:**
- Create `public.creative_generation_configs` with versioned JSONB config and one-active invariant.
- Extend `public.creative_briefs` additively with M5 metadata, evidence snapshot, grounding, quality, and fingerprint fields; enforce append-only revision identity with `unique(candidate_id, input_fingerprint)`.
- Create `app_private.creative_generation_jobs` with job state, lease, retry/repair, and linked brief fields; enforce `unique(candidate_id, input_fingerprint)`.
- Create `app_private.creative_pipeline_sync_state` for candidate/revision/page identity and projection hash.
- Enable RLS, revoke public/anon/authenticated access, and grant service-role access consistently with M4.5.

**Steps:**
- [ ] Write pgTAP assertions for columns, enum/check constraints, one-active config, revision/fingerprint uniqueness, private RLS, and role grants.
- [ ] Run `supabase test db --file supabase/tests/database/010_milestone_5_creative_generation_test.sql` and verify RED.
- [ ] Implement the additive migration and seed one active `m5-v1` config with classifier/generator/model/mode/quality policy.
- [ ] Reset the local DB and rerun the focused pgTAP file until GREEN.
- [ ] Run the full existing pgTAP suite and DB lint.
- [ ] Commit `feat: add milestone 5 generation contracts`.

### Task 2: Evidence snapshot and canonical fingerprint

**Files:**
- Create: `supabase/functions/creative-generation/types.ts`
- Create: `supabase/functions/creative-generation/evidence.ts`
- Create: `supabase/functions/creative-generation/fingerprint.ts`
- Create: `supabase/functions/tests/creative-generation/evidence_test.ts`
- Create: `supabase/functions/tests/creative-generation/fingerprint_test.ts`

**Interfaces:**
- `buildEvidenceSnapshot(input: CandidateEvidenceInput): EvidenceSnapshot`
- `canonicalJson(value: unknown): string`
- `hashGenerationInput(input: FingerprintInput): Promise<string>`
- Stable evidence IDs: `post:<uuid>`, `source:<uuid>`, `score:<component>`.

**Steps:**
- [ ] Write tests for deterministic IDs, stable ordering, unsupported evidence exclusion, and snapshot schema.
- [ ] Run the focused Deno tests with the pinned Docker image and verify RED.
- [ ] Implement snapshot normalization from candidate/cluster/posts/accounts/sources/score evidence without media binaries.
- [ ] Implement sorted canonical JSON and SHA-256 over semantic candidate/evidence/mode/phase/config/model inputs only.
- [ ] Verify same semantic input with different ordering hashes identically, changed evidence hashes differently, and runtime metadata does not affect the hash.
- [ ] Run related function tests and commit `feat: add grounded evidence snapshots`.

### Task 3: Deterministic content-mode classifier

**Files:**
- Create: `supabase/functions/creative-generation/classifier.ts`
- Create: `supabase/functions/creative-generation/config.ts`
- Create: `supabase/functions/tests/creative-generation/classifier_test.ts`
- Create: `supabase/functions/tests/creative-generation/config_test.ts`

**Interfaces:**
- `classifyDeterministically(text: string, config: ClassifierConfig): DeterministicClassification`
- `classifyWithFallback(input, provider, config): Promise<ClassificationResult>`
- `validateGenerationConfig(value: unknown): GenerationConfig`

**Steps:**
- [ ] Add bilingual RED fixtures for lineup, goal, full-time, injury, transfer/contract, tactical, statistical, and ambiguous captions.
- [ ] Verify precedence `MATCH_CONTENT > NEWS_UPDATE > ANALYSIS_CONTEXT` and PRE/LIVE/POST mapping fails before implementation.
- [ ] Implement versioned taxonomy parsing, normalization, ambiguity detection, and deterministic classification.
- [ ] Implement fallback interface that is called only for ambiguous input and maps invalid/below-threshold output to `CLASSIFICATION_UNCERTAIN`.
- [ ] Run focused and existing intelligence tests; commit `feat: add content mode classification`.

### Task 4: OpenAI Responses provider

**Files:**
- Create: `supabase/functions/creative-generation/provider.ts`
- Create: `supabase/functions/creative-generation/prompts.ts`
- Create: `supabase/functions/tests/creative-generation/provider_test.ts`
- Create: `supabase/functions/tests/creative-generation/prompts_test.ts`

**Interfaces:**
- `CreativeGenerationProvider.classify(input): Promise<ClassificationResult>`
- `CreativeGenerationProvider.generate(input): Promise<CreativeBriefOutput>`
- `CreativeGenerationProvider.repair(input, errors): Promise<CreativeBriefOutput>`
- `normalizeProviderError(error): ProviderFailure`

**Steps:**
- [ ] Write mock-transport tests for Responses API request shape, strict JSON Schema, no web-search tool, mode-specific prompts, and secret-safe errors.
- [ ] Verify RED with the focused provider test suite.
- [ ] Implement one transport with separate classifier/generator schema/prompt contracts and configured model/reasoning/output limits.
- [ ] Implement bounded retry for 429/5xx/timeouts with Retry-After handling and permanent failure categories.
- [ ] Ensure logs contain request ID/category only and never provider response bodies or credentials.
- [ ] Run focused provider tests and commit `feat: add openai creative generation provider`.

### Task 5: Grounding quality gate and one-shot repair

**Files:**
- Create: `supabase/functions/creative-generation/quality_gate.ts`
- Create: `supabase/functions/tests/creative-generation/quality_gate_test.ts`

**Interfaces:**
- `validateCreativeBrief(output, evidence, config): ValidationResult`
- `generateWithOneRepair(provider, output, evidence, config): Promise<ValidatedCreativeBrief>`

**Steps:**
- [ ] Write RED tests for invalid IDs, missing FACT grounding, unsupported INFERENCE, hook/slide violations, missing visual direction, strict NEWS blocking, partial analysis/match, repair success, repair failure, and no second repair.
- [ ] Implement deterministic schema/contract validation with stable error codes and evidence membership checks.
- [ ] Implement strict/partial mode policies and source allowlisting from the frozen snapshot.
- [ ] Implement exactly one repair call with original evidence and validation errors; reject added facts/sources/IDs.
- [ ] Run focused tests and the full function suite; commit `feat: validate grounded creative briefs`.

### Task 6: Creative generation orchestrator

**Files:**
- Create: `supabase/functions/creative-generation/repository.ts`
- Create: `supabase/functions/creative-generation/orchestrator.ts`
- Create: `supabase/functions/creative-generation/handler.ts`
- Create: `supabase/functions/creative-generation/index.ts`
- Create: `supabase/functions/tests/creative-generation/orchestrator_test.ts`
- Create: `supabase/functions/tests/creative-generation/handler_test.ts`

**Interfaces:**
- `runCreativeGeneration(input: GenerationTrigger, dependencies): Promise<GenerationResult>`
- `createCreativeGenerationHandler(dependencies): (request: Request) => Promise<Response>`
- Repository methods for active config, candidate evidence, job lease, revision insert, and job state transition.

**Steps:**
- [ ] Write RED tests for eligibility, same-fingerprint NOOP, changed-input revision +1, concurrent trigger deduplication, lease expiry, and every terminal state.
- [ ] Implement canonical evidence/config/fingerprint flow and server-only repository access.
- [ ] Implement lease acquisition and idempotent job insert before provider calls.
- [ ] Implement persistence order: brief insert → job READY → downstream projections, isolating projection failures.
- [ ] Wire authenticated POST handler with safe response codes and trigger types `AUTO_PRIORITY` and `NOTION_SELECTED`.
- [ ] Run focused and full function tests; commit `feat: orchestrate creative generation`.

### Task 7: Notion and n8n production handoff

**Files:**
- Modify: `supabase/functions/notion-sync/mapper.ts`
- Modify: `supabase/functions/notion-sync/notion_client.ts`
- Modify: `supabase/functions/notion-sync/repository.ts`
- Create: `supabase/functions/creative-generation/notion_projection.ts`
- Create: `supabase/functions/creative-generation/selected_poll.ts`
- Create: `supabase/functions/tests/creative-generation/notion_projection_test.ts`
- Create: `supabase/functions/tests/creative-generation/selected_poll_test.ts`
- Modify: `n8n/workflows/instagram-collector-schedule.json`
- Modify: `scripts/validate-n8n-workflow.mjs`
- Modify: `scripts/validate-n8n-workflow.test.mjs`

**Interfaces:**
- Add system-owned Daily Intelligence status mapping without including Selected, Editorial Status, Editor Headline, or Editor Notes.
- `projectCreativeBriefToContentPipeline(brief, existingState, notion): Promise<ProjectionResult>` with EDITABLE update and LOCKED/APPROVED create-new branching.
- `pollSelectedDailyIntelligence(): Promise<GenerationTrigger[]>` invokes the same orchestrator core.

**Steps:**
- [ ] Write mapping/ownership/branching RED tests against the existing M4.5 Notion client contracts and fixture schema.
- [ ] Implement additive Daily Intelligence properties and Content Pipeline page-body representation.
- [ ] Implement selected poll in an Edge Function module, preserving all human-owned fields and using configured IDs only.
- [ ] Add n8n success-gated urgent path and scheduled selected-poll path; keep business logic in Edge Functions.
- [ ] Extend validator tests for ordering, single invocation, failure isolation, and no credential values.
- [ ] Run n8n tests and Notion function tests; commit `feat: project creative briefs to notion`.

### Task 8: End-to-end smoke and full regression

**Files:**
- Create: `scripts/run-milestone-5-smoke.sh`
- Create: `scripts/verify-milestone-5-smoke.sql`
- Create: `supabase/tests/integration/milestone_5_generation_integration_test.ts`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Safe fixture smoke covering all three modes, lifecycle outcomes, idempotent NOOP, revision change, grounding, repair, Notion branching, and projection isolation.

**Steps:**
- [ ] Write RED fixture assertions for one NEWS_UPDATE, ANALYSIS_CONTEXT, and MATCH_CONTENT case plus strict blocked news and repair cases.
- [ ] Implement safe local runner with secret checks, no production mutation, and secret-scan assertions.
- [ ] Run actual OpenAI smoke only if `OPENAI_API_KEY` and configured model access are available; otherwise report the exact external credential blocker.
- [ ] Run fresh `supabase db reset --local`, pgTAP, DB lint, Docker Deno tests, n8n validator/tests, M4 smoke, M4.5 smoke, M5 unit/integration, and secret scan.
- [ ] Verify worktree status and requirement checklist; commit `test: verify milestone 5 end to end`.

