# M8 Editorial Ranking, Candidate Selection, and Relevance Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect calculated M8 editorial rankings to same-story/same-date generation candidates and reject marginal Manchester United relevance without fabricating M4 scores or flags.

**Architecture:** Treat `editorial_rankings` as the decision source for current-date M8 auto generation. Persist an explicit same-date candidate projection with a namespaced editorial snapshot and evidence confidence, preserve existing M4 score components and flags, and select only fresh `news_eligible` ranking rows. Upgrade relevance from a merged keyword boolean to a classification over title, body, entities, and topic.

**Tech Stack:** Supabase Postgres/PostgREST, Supabase Edge Functions, Deno tests, existing M8 ranking scorer.

**Spec:** `docs/superpowers/specs/2026-10-12-m8-grounding-ranking-ready-design.md` (acceptance 4 and 5).

## Global Constraints

- Scores, confidence, and flags derive from observed evidence and current scoring policy; never synthesize `first_mover_flag` or `must_cover_flag` to unlock generation.
- Use ranking for the same `story_cluster_id` and `ranking_date`; only `news_eligible` rows inside the existing 72-hour discovery freshness window may enter `AUTO_PRIORITY`.
- Keep M4 component score meanings and M4 flag meanings intact.
- Production Supabase and shared local `manutd_editor` are out of scope; use only a separately identified disposable staging stack.
- Do not merge PR #8, #9, or #10; create no new PR; keep PR #10 Draft and based on PR #9.
- Do not activate Google News operations, schedules, cron, Telegram delivery, or user-facing publishing.

## Review Focus

- A high discovery signal with no VERIFIED claim stays a research/review lead and is not auto-generated (Task 1).
- Ranking from a prior date or another story cannot select the candidate, even when its score/flags are high (Task 1).
- Existing M4 component scores and first-mover/must-cover flags survive projection updates without being overwritten (Task 1).
- United-centered stories pass only when title/body/entity/topic signals corroborate the topic; opponent context is separate (Task 2).
- Incidental mention, other sport, and multi-club transfer roundup cannot pass from one keyword or focused-source shortcut (Task 2).

---

### Task 1: Project rankings into generation candidates and select only eligible rows

**Files:**
- Modify: `supabase/functions/rank-editorial/repository.ts`
- Modify: `supabase/functions/rank-editorial/types.ts`
- Modify: `supabase/functions/rank-editorial/orchestrator.ts`
- Modify: `supabase/functions/creative-generation/repository.ts`
- Modify: `supabase/functions/creative-generation/types.ts`
- Modify: `supabase/functions/creative-generation/orchestrator.ts`
- Modify: `supabase/functions/promote-discovery/repository.ts`
- Modify: `supabase/functions/promote-discovery/orchestrator.ts`
- Modify: `supabase/functions/promote-discovery/types.ts`
- Test: `supabase/functions/tests/rank-editorial/repository_test.ts`
- Test: `supabase/functions/tests/rank-editorial/orchestrator_test.ts`
- Test: `supabase/functions/tests/creative-generation/repository_test.ts`
- Test: `supabase/functions/tests/creative-generation/orchestrator_test.ts`
- Test: `supabase/functions/tests/promote-discovery/repository_test.ts`

**Interfaces:**
- `EditorialRankingRepository.upsertRanking(ranking)` writes `editorial_rankings` and an idempotent `content_candidates` projection for the identical story/date/config, with M8 evidence confidence and `score_inputs.m8_editorial_ranking` containing ranking version, rank, score, eligibility, and reason codes.
- Promotion no longer creates an unranked all-zero `content_candidates` placeholder; rank persistence creates the same-date candidate projection after it has a real editorial score.
- `GenerationRepository.listPriorityCandidateIds(rankingDate: string)` returns candidate IDs ordered by current-date editorial rank, joined by story ID/date, only when `news_eligible` and within 72 hours. `runPriorityCreativeGeneration` derives that date using `businessDate(now, "Asia/Seoul")`.
- `CandidateEvidenceInput.candidate.editorial_ranking` carries `{ ranking_date, ranking_version, rank, editorial_score, news_eligible }`; `AUTO_PRIORITY` revalidates this current row before generation and does not use M4 flags as a substitute.

- [ ] **Step 1: Add failing repository/promotion tests** named `promotion does not create unranked zero score candidate`, `ranking upsert writes same story date candidate projection`, `ranking projection preserves M4 component scores and flags`, and `priority candidates require current news eligible ranking`; assert no placeholder is created, the namespaced ranking snapshot matches actual rank/version/date, M4 fields remain unchanged, and ineligible rows are absent.
- [ ] **Step 2: Run** `cd supabase/functions && deno test --allow-env --allow-net tests/rank-editorial/repository_test.ts tests/creative-generation/repository_test.ts`; expect the new projection/join assertions to fail.
- [ ] **Step 3: Add a ranking repository projection write** that copies evidence confidence and a namespaced M8 ranking snapshot without setting M4 flags or overwriting M4 component scores.
- [ ] **Step 4: Add failing selection tests** named `priority selection rejects stale wrong date and ineligible ranks` and `priority selection orders same date candidates by editorial rank`; assert stale, wrong-date, and ineligible IDs are excluded and eligible IDs retain rank order, then implement `listPriorityCandidateIds(rankingDate?)` using `editorial_rankings` as eligibility authority.
- [ ] **Step 5: Add failing orchestrator tests** named `AUTO_PRIORITY requires an eligible editorial ranking` and `AUTO_PRIORITY does not require M4 flags when M8 rank is eligible`; keep MANUAL/NOTION_SELECTED trigger behavior explicit.
- [ ] **Step 6: Run** `cd supabase/functions && deno test --allow-env --allow-net tests/rank-editorial/repository_test.ts tests/rank-editorial/orchestrator_test.ts tests/creative-generation/repository_test.ts tests/creative-generation/orchestrator_test.ts tests/promote-discovery/repository_test.ts`; expect all focused tests to pass.

### Task 2: Classify Manchester United relevance from separate story signals

**Files:**
- Modify: `supabase/functions/_shared/m8/manchester_united_relevance.ts`
- Modify: `supabase/functions/rank-editorial/repository.ts`
- Test: `supabase/functions/tests/m8/manchester_united_relevance_test.ts`
- Test: `supabase/functions/tests/rank-editorial/repository_test.ts`

**Interfaces:**
- Add `classifyManchesterUnitedRelevance(input)` returning `{ classification: "UNITED_PRIMARY" | "OPPONENT_MATCH_CONTEXT" | "INCIDENTAL_MENTION" | "OTHER_SPORT" | "TRANSFER_ROUNDUP" | "UNRELATED", autoEligible: boolean, reasonCodes: readonly string[] }`; input carries `title`, `body`, `entities`, `topic`, and `sourceUsernames` separately. Keep `isManchesterUnitedRelevant(input)` as a compatibility boolean wrapper.
- Classifications distinguish `UNITED_PRIMARY`, `OPPONENT_MATCH_CONTEXT`, `INCIDENTAL_MENTION`, `OTHER_SPORT`, `TRANSFER_ROUNDUP`, and `UNRELATED`.
- A focused-source exception cannot override contradictory title/topic/sport evidence; normalize allow-listed usernames before comparison.

- [ ] **Step 1: Add five failing category tests** named `classifies United centered story`, `classifies opponent article with United fixture context`, `rejects fleeting United mention`, `rejects another sport despite a United keyword`, and `rejects multi club transfer rumor roundup`. Add `title body entity topic disagreement cannot auto qualify` and `focused source usernames are normalized but cannot override contradiction` cases.
- [ ] **Step 2: Run** `cd supabase/functions && deno test --allow-env --allow-net tests/m8/manchester_united_relevance_test.ts`; expect category/body/entity/topic assertions to fail.
- [ ] **Step 3: Implement the classifier** with separate signal weighting/contradiction checks; opponent context remains classified but not automatically eligible unless the story directly covers the United fixture.
- [ ] **Step 4: Feed story topic and extracted source/article text into the repository evaluator** without merging all inputs into one undifferentiated keyword string.
- [ ] **Step 5: Re-run relevance and rank repository tests**; confirm one keyword/entity occurrence cannot make incidental or other-sport material auto-eligible.
