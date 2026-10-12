# Editorial Exploration Mode Design

## Goal

Add a default-off Exploration Mode to the existing M6–M9 editorial workflow. It may generate review-only DRAFT briefs from recent, relevant publisher articles even when the source has not passed the existing FACT verification gate. It must not relax VERIFIED or READY eligibility.

## Phase 1: Existing Workflow Findings

### Reusable path

1. `source-discovery` and `trend-discovery` already collect articles into `source_observations` and `discovery_observations`; Google News resolution records the publisher URL, extraction status, excerpt, and timestamps.
2. `promote-discovery` links observations to canonical `story_clusters`; `ground-claims` adds `story_claims` and `claim_evidence`; `rank-editorial` projects rankings and `content_candidates`.
3. `orchestration-worker` already chains `RANK_EDITORIAL` to `GENERATE_PRIORITY`. This is the daily automation entry point; do not add a queue or schedule.
4. `creative-generation` owns provider calls, quality repair, immutable evidence snapshots, fingerprints, leases, revisions, and `creative_briefs`. Its current unique job identity is `(candidate_id, input_fingerprint)`.
5. Telegram's M6 console already reads rankings/trend snapshots, enqueues bounded `DISCOVER_TRENDS` jobs, and calls canonical `MANUAL` generation. Existing UI rejects `news_eligible=false` before generation.
6. M9's manual `m9-private-preview.yml` accepts a brief ID, renders with the existing Pillow renderer, uploads privately, and separates upload from Telegram send. PR #8's `m9-auto-preview.yml` polls READY only.

### Conflicts to address

- `creative-generation/orchestrator.ts` currently defaults successful output to READY except one narrow NEWS_UPDATE/manual branch. Exploration must explicitly force DRAFT for all three content modes.
- `verifiedNewsSources()` is the strict NEWS_UPDATE READY gate. Unapproved article evidence must be represented separately or marked unverified so it can never satisfy this gate.
- Candidate evidence currently omits unverified publisher article text. Add a bounded article-evidence projection from existing observation tables, retaining publisher URL, publisher name, publication time, extraction status, article excerpt, and modality cues.
- Telegram blocks non-eligible cards and its response parser accepts only READY/NOOP. Feature-flagged calls must reach canonical generation, accept DRAFT, and keep existing callbacks and SELECTED state transitions intact.
- Job dedupe is candidate-scoped, while candidates are date-scoped. Exploration needs a stable story/article evidence fingerprint and database-level duplicate protection across ranking dates.
- An in-memory daily count is race-prone. Enforce the ten-DRAFT limit in an additive service-only SQL lease RPC that serializes Exploration reservations; count in-flight reservations and completed DRAFTs for the Seoul business date.
- The M9 manual loader currently accepts any brief ID and PR #8 only polls READY. Add an explicit DRAFT-preview opt-in to the existing manual M9 path and do not change PR #8.
- Source discovery extracts a bounded excerpt but does not consistently mark whether it came from the publisher page. Mark extracted-vs-feed-summary evidence so title/RSS-only records cannot reach the provider.

## Architecture Decisions

- `EDITORIAL_EXPLORATION_MODE` defaults to `false`; disabled requests retain current behavior.
- Preserve `AUTO_PRIORITY`, `NOTION_SELECTED`, and `MANUAL` trigger contracts. Add an explicit `generation_intent: "STANDARD" | "EXPLORATION"` field; only the latter uses the DRAFT policy.
- Keep source article evidence distinct from verified claim evidence. Never assign `VERIFIED`, and leave `verifiedNewsSources()` unchanged.
- Exploration requires a safe HTTPS publisher URL, extracted publisher-page text above the configured minimum, a non-archived materially relevant Manchester United story, and publication within 72 hours. No provider call is made when those checks fail.
- Exploration uses the existing creative job and brief tables. A stable story/article-content fingerprint prevents repeat generation across daily candidate IDs; changed evidence may form a new revision.
- Use the existing `GENERATE_PRIORITY` job to process the latest eligible Exploration candidates, with an atomic per-Seoul-day maximum of 10 drafts. Existing READY generation continues unchanged.
- Telegram shows article-source evidence as reported/unverified, requests DRAFT generation through the canonical handler, and provides an explicit, authenticated manual M9 preview dispatch. No unsolicited Telegram send or Instagram publishing is enabled.
- M9 DRAFT previews require an explicit workflow input; READY remains the only input accepted by the PR #8 automatic scheduler.
- Record provider attempts, input/output tokens, retry/repair counts, and estimated cost when model pricing is configured. Never infer cost from missing usage data.

## Validation Boundaries

- Unit tests use in-memory repositories and mocked network clients; they do not contact shared Supabase or production providers.
- SQL migration tests run only against a disposable database. No shared local DB reset, restore, migration, or `db push`.
- Actual provider tests are limited to three and run only if disposable-staging credentials are explicitly available.
- Telegram and Instagram delivery are not exercised against live credentials.
- PR #8 is fetched/read for compatibility only; this work does not edit, merge, or dispatch it.
