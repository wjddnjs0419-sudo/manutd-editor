# M8 Publisher Grounding and Source-Faithful Creative Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ground publisher-report claims in reviewed publisher articles while preserving report attribution, uncertainty, and traceable source evidence through creative output.

**Architecture:** Keep the Google News observation discovery-only. Match a resolved article URL by exact normalized host to an already-active, reviewed fact source; save a separate publisher observation only on a match, then ground a claim about what that publisher reported using the exact article sentence. Carry claim scope, modality, source URL/outlet/time, and linked evidence through the creative snapshot and require claim-linked evidence for NEWS_UPDATE.

**Tech Stack:** Supabase Postgres migrations, pgTAP, Supabase Edge Functions, Deno tests, existing creative-generation provider contract.

**Spec:** `docs/superpowers/specs/2026-10-12-m8-grounding-ranking-ready-design.md` (acceptance 2, 3, and 6).

## Global Constraints

- Google News stays `DISCOVERY_COMMUNITY`; its wrapper URL, publisher label, or successful body extraction alone never establishes publisher trust.
- Use only an active, already-reviewed `information_sources` entry with a fact role and reliability at least 8; an unmatched host remains discovery-only and receives no elevated reliability.
- A source may verify that an outlet reported a statement; it does not verify the underlying event unless separate evidence directly supports that event.
- Preserve uncertainty, rumor, attribution, and denial through claims, evidence snapshots, Korean carousel copy, and captions.
- Store publisher URL, original Google News URL, outlet name, article publication time, and exact supporting sentence with traceable links.
- 403, paywall, missing body, or unsupported claim are normal exclusion/block reasons.
- Production Supabase and shared local `manutd_editor` are out of scope; use only a separately identified disposable staging stack.
- Do not merge PR #8, #9, or #10; create no new PR; keep PR #10 Draft and based on PR #9.
- Do not activate Google News operations, schedules, cron, Telegram delivery, or user-facing publishing.

## Review Focus

- Unknown, inactive, low-reliability, or host-mismatched publishers cannot produce fact-role evidence (Task 1).
- Google News remains discovery-only even when the publisher article URL and body resolve (Task 1 and pgTAP).
- An exact body sentence supporting a rumor cannot ground an event claim that says a transfer is confirmed (Task 2).
- 403, paywall, empty, and absent body results stay non-grounding and retain a safe reason code (Task 1 and Task 2).
- Creative output cites only claim-linked evidence and retains the original uncertainty, canonical URL, publisher label, and publication time (Task 3).

---

### Task 1: Resolve reviewed publisher identity and persist article provenance

**Files:**
- Create: `supabase/functions/promote-discovery/publisher_evidence.ts`
- Modify: `supabase/functions/promote-discovery/repository.ts`
- Test: `supabase/functions/tests/trend-discovery/google_news_resolution_test.ts`
- Test: `supabase/functions/tests/trend-discovery/article_enrichment_test.ts`
- Test: `supabase/functions/tests/promote-discovery/repository_test.ts`
- Test: `supabase/functions/tests/promote-discovery/publisher_evidence_test.ts`
- Database test: `supabase/tests/database/026_publisher_grounding_test.sql`

**Interfaces:**
- `PublisherRegistryEntry` fields are `id`, `canonical_name`, `website_url`, `editorial_role`, `reliability_score`, and `active`.
- `matchReviewedPublisher(articleUrl, registry)` returns a `ReviewedPublisherMatch | null`; match only when normalized hostname is exact, active is true, role is `FACT_PRIMARY` or `FACT_INDEPENDENT`, and reliability is at least 8.
- A matched article is a separate `source_observations` row linked to the existing source ID; the original Google observation remains `DISCOVERY_COMMUNITY` and stores the wrapper URL in metadata.
- Article observation metadata retains `google_news_original_url`, `resolved_publisher_url`, `article_extraction_status`, `publisher_canonical_name`, and exact `supporting_sentence` provenance. Do not create a source-registry row from an unreviewed publisher.

- [ ] **Step 1: Add failing registry tests** named `reviewed publisher exact host is eligible` and `publisher trust rejects unknown inactive weak role and sibling hosts`; assert only a matching active FACT_PRIMARY/FACT_INDEPENDENT registry row with reliability `>= 8` returns a match.
- [ ] **Step 2: Run** `cd supabase/functions && deno test --allow-env --allow-net tests/promote-discovery/publisher_evidence_test.ts`; expect the matcher import/behavior tests to fail.
- [ ] **Step 3: Implement `matchReviewedPublisher`** as a pure function with no DNS lookup and no trust inference from the article or Google News metadata.
- [ ] **Step 4: Add failing trend/promotion tests** named `resolved Google News publisher URL is the body extraction target`, `403 and empty article body remain non-grounding`, and `publisher observation requires extracted non-empty body`; assert wrapper resolution and body status stay distinct and exclusion never creates fact evidence.
- [ ] **Step 5: Update promotion persistence** and add pgTAP coverage for source identity, observation role, publication time, exact publisher URL, wrapper provenance, and idempotency.
- [ ] **Step 6: Run focused tests**: `cd supabase/functions && deno test --allow-env --allow-net tests/promote-discovery/publisher_evidence_test.ts tests/promote-discovery/repository_test.ts`; then run the new pgTAP file only on an isolated disposable database.

### Task 2: Separate publisher reports from event claims in grounding

**Files:**
- Add: `supabase/migrations/20261012120000_m8_publisher_report_grounding.sql`
- Modify: `supabase/functions/ground-claims/types.ts`
- Modify: `supabase/functions/ground-claims/repository.ts`
- Modify: `supabase/functions/ground-claims/matcher.ts`
- Modify: `supabase/functions/ground-claims/orchestrator.ts`
- Modify: `supabase/functions/promote-discovery/repository.ts`
- Test: `supabase/functions/tests/ground-claims/matcher_test.ts`
- Test: `supabase/functions/tests/ground-claims/repository_test.ts`
- Test: `supabase/functions/tests/promote-discovery/repository_test.ts`

**Interfaces:**
- Add `claimScope: "PUBLISHER_REPORT" | "EVENT"` and `claimModality: "CONFIRMED" | "RUMOR" | "PREDICTION" | "DENIAL" | "OPINION" | "UNKNOWN"` to `GroundingClaim`; report-level claim text is explicitly attributed to the publisher and preserves the described event's modality.
- `GroundingEvidence.evidenceText` is the exact article sentence, not a synthesized concatenation of outlet and title/excerpt.
- Grounding a `PUBLISHER_REPORT` proves the publication/report assertion only. Event-level `CONFIRMED` claims reject evidence classified as rumor, prediction, denial, opinion, or unknown.

- [ ] **Step 1: Add failing matcher tests** named `publisher report grounds rumor attribution without grounding the transfer`, `rumor evidence cannot verify a confirmed event claim`, `publisher denial remains a denial`, and `unrelated body sentence is insufficient`; assert report claim VERIFIED with exact sentence, event claim not VERIFIED, modality preserved, and no title-only evidence acceptance.
- [ ] **Step 2: Run** `cd supabase/functions && deno test --allow-env --allow-net tests/ground-claims/matcher_test.ts`; expect the new distinctions to fail against current lexical matching.
- [ ] **Step 3: Add the minimal typed claim scope/modality fields and deterministic modality comparison**; preserve existing source-role and entity-anchor checks for legacy claims.
- [ ] **Step 4: Add the migration columns/checks for `claim_scope`, `claim_modality`, and the `publisher_article` origin**; use the existing nullable `raw_post_id`/`discovery_observation_id` model, constrain the new values, and preserve claim/evidence history.
- [ ] **Step 5: Add repository tests** proving claim-to-observation links, exact sentence persistence, role, relation, confidence, origin, and idempotent upsert.
- [ ] **Step 6: Run** matcher/repository/promotion focused Deno tests and the new pgTAP assertions on disposable staging; expect report claims to ground while unsupported event claims remain `INSUFFICIENT` or `DISCOVERY_ONLY`.

### Task 3: Carry verified provenance through NEWS_UPDATE generation

**Files:**
- Modify: `supabase/functions/creative-generation/types.ts`
- Modify: `supabase/functions/creative-generation/repository.ts`
- Modify: `supabase/functions/creative-generation/evidence.ts`
- Modify: `supabase/functions/creative-generation/prompts.ts`
- Modify: `supabase/functions/creative-generation/provider.ts`
- Modify: `supabase/functions/creative-generation/quality_gate.ts`
- Modify: `supabase/functions/creative-generation/orchestrator.ts`
- Test: `supabase/functions/tests/creative-generation/repository_test.ts`
- Test: `supabase/functions/tests/creative-generation/evidence_test.ts`
- Test: `supabase/functions/tests/creative-generation/quality_gate_test.ts`
- Test: `supabase/functions/tests/creative-generation/orchestrator_test.ts`

**Interfaces:**
- `EvidenceSource` retains `claim_id`, role, relation, reliability, exact sentence, canonical publisher URL, original Google URL, publisher label, publication time, and claim modality.
- NEWS_UPDATE eligibility checks that a generated claim's evidence ID maps to a verified, claim-linked fact observation with an allowed source; a legacy `story_cluster_sources` mention alone is insufficient.
- A READY brief's `sources[]` item carries a validated publisher URL and outlet label; at least one carousel slide and the Instagram caption include that source attribution/URL, and Korean copy preserves the reported/rumored/confirmed distinction.
- `AUTO_PRIORITY` remains limited to ranked `news_eligible` rows; an explicit `MANUAL` or `NOTION_SELECTED` trigger may save a `DRAFT` only when the report itself is verified and the generated wording/citation passes the same claim-support gate. Missing or unsupported facts remain blocked, never softened into a draft.

- [ ] **Step 1: Add failing snapshot and gate tests** named `creative snapshot preserves claim linked publisher provenance`, `legacy reliable source mention cannot satisfy NEWS_UPDATE`, `NEWS_UPDATE blocks missing publisher URL or unsupported evidence id`, `NEWS_UPDATE source URL appears in carousel and caption`, and `NEWS_UPDATE rejects rumor rewritten as confirmed`; assert exact URL, publisher, publication time, evidence sentence, linked claim, and modality are retained and cited.
- [ ] **Step 2: Run** `cd supabase/functions && deno test --allow-env --allow-net tests/creative-generation/repository_test.ts tests/creative-generation/evidence_test.ts tests/creative-generation/quality_gate_test.ts tests/creative-generation/orchestrator_test.ts`; expect the new assertions to fail.
- [ ] **Step 3: Preserve linked claim evidence and provenance** in repository mapping and frozen evidence snapshot; do not infer URLs or report/event semantics from source labels.
- [ ] **Step 4: Tighten provider schema, Korean prompt, and quality gate** so NEWS_UPDATE citations are claim-linked and the public source treatment includes publisher name/URL and uncertainty qualification.
- [ ] **Step 5: Keep unsupported candidates blocked; allow only an explicit `MANUAL` or `NOTION_SELECTED` trigger to save a human-review `DRAFT`** when a reviewed publisher-report claim is verified and every generated assertion/source passes support validation, but the ranking/automatic-ready threshold is unmet. Do not call the provider for candidates with no reviewed publisher evidence.
- [ ] **Step 6: Re-run the focused creative-generation tests**; assert one faithful report-level output validates and all unsupported/overstated output remains non-READY with stable error codes.
