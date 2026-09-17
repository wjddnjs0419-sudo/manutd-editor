# Milestone 4 Content Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** M3가 수집한 Instagram 게시물을 deterministic story cluster로 묶고, ambiguity만 AI로 보조 판정하며, 재현 가능한 Priority Score·Data Confidence·opportunity flag를 생성한다.

**Architecture:** intelligence Supabase Edge Function은 feature extraction, candidate filtering, cluster orchestration, 제한적 OpenAI 호출을 담당한다. PostgreSQL RPC/function은 membership transaction, lease, baseline, 10개 score component와 candidate upsert를 담당한다. n8n은 M3 collector 뒤에 intelligence function을 호출하는 orchestration만 수행한다.

**Tech Stack:** Supabase Postgres/pgTAP, Supabase Edge Functions, Deno 2.1.4, TypeScript strict mode, @supabase/supabase-js 2.116.0, OpenAI HTTP structured output, n8n JSON workflow.

**Spec:** docs/superpowers/specs/2026-09-18-milestone-4-content-intelligence-design.md

## Global Constraints

- Supabase가 backend source of truth이다.
- Priority Score와 component score는 Meta/Postgres data와 versioned scoring config만으로 계산한다.
- AI는 story equivalence 보조만 담당하며 score 숫자·flag 조건을 결정하지 않는다.
- Eligible monitored account는 active=true AND api_supported=true이다.
- api_supported IS NULL은 pending capability, false는 unsupported로 기록하고 coverage denominator에서 제외한다.
- FIRST_MOVER는 eligible KR account가 모두 run 시각 90분 이내 성공 probe를 가져야 한다.
- GLOBAL↔KR unresolved/manual review가 있으면 korea_coverage_status=UNCERTAIN, korea_gap_score=0, FIRST_MOVER=false이다.
- Deterministic thresholds는 same >=0.85, different <=0.40, ambiguity (0.40,0.85)이다.
- AI merge/separate는 confidence>=0.90에서만 허용한다.
- Korean Saturation은 K를 공식에 넣지 않으며 KR post와 valid ER이 없으면 score 0이다.
- Baseline fallback은 account+media+age(n>=5), account+age(n>=5), region cohort+media+age(n>=20), unavailable 순서다.
- Missing component는 weight redistribution 없이 0으로 처리하고 Data Confidence만 낮춘다.
- Lease와 heartbeat는 STORY_INTELLIGENCE_LEASE_SECONDS(기본 300, 허용 60~1800), STORY_INTELLIGENCE_HEARTBEAT_SECONDS(기본 30, lease 절반 미만)으로 설정한다.
- 신규 private schema/table/function은 RLS 또는 schema revoke, empty search_path, service-role EXECUTE만 사용한다.
- 구현 전 실제 secret, raw payload, upstream 오류 본문을 로그에 출력하지 않는다.

## File Map

- Create: supabase/migrations/20260918150000_milestone_4_content_intelligence.sql — signature, candidate metadata, evaluation audit, lease, deterministic SQL functions/RPC.
- Modify: supabase/seed.sql — M4 scoring/clustering config와 singleton lease seed.
- Create: supabase/functions/intelligence/types.ts — feature, signature, score input, run summary types.
- Create: supabase/functions/intelligence/config.ts — AI flag/model/prompt/dictionary/lease config parser.
- Create: supabase/functions/intelligence/features.ts — bilingual normalization과 deterministic feature extraction.
- Create: supabase/functions/intelligence/clustering.ts — pre-filter, similarity, threshold decision, aggregate signature.
- Create: supabase/functions/intelligence/ai_classifier.ts — ambiguity-only structured OpenAI client.
- Create: supabase/functions/intelligence/repository.ts — service-role RPC/query boundary와 audit persistence.
- Create: supabase/functions/intelligence/orchestrator.ts — lease, recent post processing, source extraction, score run.
- Create: supabase/functions/intelligence/handler.ts — authenticated POST contract와 safe response/log.
- Create: supabase/functions/intelligence/index.ts — dependency wiring and Deno.serve.
- Create: supabase/functions/tests/intelligence/config_test.ts
- Create: supabase/functions/tests/intelligence/features_test.ts
- Create: supabase/functions/tests/intelligence/clustering_test.ts
- Create: supabase/functions/tests/intelligence/ai_classifier_test.ts
- Create: supabase/functions/tests/intelligence/orchestrator_test.ts
- Create: supabase/functions/tests/intelligence/handler_test.ts
- Create: supabase/tests/database/007_milestone_4_intelligence_test.sql
- Modify: n8n/workflows/instagram-collector-schedule.json
- Modify: n8n/README.md
- Modify: scripts/validate-n8n-workflow.mjs
- Create: scripts/run-milestone-4-smoke.sh
- Create: scripts/verify-milestone-4-smoke.sql
- Modify: README.md

---

### Task 1: M4 schema, lease RPC, and score SQL boundary

**Files:**
- Create: supabase/migrations/20260918150000_milestone_4_content_intelligence.sql
- Modify: supabase/seed.sql
- Test: supabase/tests/database/007_milestone_4_intelligence_test.sql

**Interfaces:**

- try_acquire_intelligence_run(run_id uuid, now timestamptz, lease_until timestamptz) returns boolean
- renew_intelligence_run(run_id uuid, lease_until timestamptz) returns boolean
- release_intelligence_run(run_id uuid) returns boolean
- upsert_story_cluster_member(raw_post_id uuid, cluster_id uuid, match_method text, match_confidence numeric, signature jsonb) returns uuid
- reassign_story_cluster_post(raw_post_id uuid, target_cluster_id uuid, reason text) returns uuid
- calculate_priority_candidates(run_at timestamptz, ranking_date date) returns integer
- get_todays_candidates(ranking_date date) returns table(rank integer, story_cluster_id uuid, priority_score numeric, data_confidence numeric, first_mover_flag boolean, must_cover_flag boolean, korea_coverage_status text, component_scores jsonb)

- [ ] Write failing pgTAP tests for signature columns, score_version, korea_coverage_status, private evaluation/lease tables, function signatures, RLS, and service-role-only EXECUTE.
- [ ] Run the focused test and confirm missing objects fail.

~~~bash
supabase db reset --local
supabase seed buckets
supabase test db
~~~

- [ ] Add signature_json/signature_version, candidate score_version/korea_coverage_status, private evaluation table, singleton lease table, constraints, RLS, schema grants, and pair/version/hash unique key.
- [ ] Add trigger validation that candidate score_version equals referenced scoring config version.
- [ ] Implement invoker lease RPCs with atomic expiry predicate; membership RPC locks post and cluster, enforces one raw_post_id membership, and updates signature in the same transaction.
- [ ] Implement deterministic SQL score functions for all curves, eligible denominators, KR completeness/uncertainty, K-free saturation, baseline sample factor, seven confidence factors, flags, and candidate upsert.
- [ ] Seed M4 config and run supabase test db plus local DB lint.
- [ ] Commit with message feat: add milestone 4 intelligence schema and score functions.

### Task 2: Config and bilingual deterministic feature extraction

**Files:**
- Create: supabase/functions/intelligence/types.ts
- Create: supabase/functions/intelligence/config.ts
- Create: supabase/functions/intelligence/features.ts
- Test: supabase/functions/tests/intelligence/config_test.ts
- Test: supabase/functions/tests/intelligence/features_test.ts

**Interfaces:**

- resolveIntelligenceConfig(readEnv) returns IntelligenceConfig
- extractStoryFeatures(caption, publishedAt, dictionary) returns StoryFeatures
- canonicalInputHash(input) returns Promise<string>

- [ ] Add tests for NFKC/case-folding, Korean spacing/particles, Bruno bilingual aliases, injury aliases, source aliases, number/date normalization, unknown entity behavior, and lease bounds.
- [ ] Run Deno focused tests and confirm missing implementations fail.
- [ ] Implement strict parsing for STORY_CLUSTER_AI_ENABLED, model, prompt version, dictionary version, lease seconds, and heartbeat seconds. Reject lease outside 60–1800 seconds or heartbeat below 10 seconds/at least half the lease without echoing values.
- [ ] Implement versioned bilingual dictionary and feature extraction. Unknown tokens remain unknown.
- [ ] Implement stable-key-order SHA-256 hashing for canonical classifier JSON and post-pair ordering.
- [ ] Run focused tests and commit with message feat: add intelligence config and bilingual features.

~~~bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env functions/tests/intelligence/config_test.ts functions/tests/intelligence/features_test.ts
~~~

### Task 3: Aggregate-signature clustering engine

**Files:**
- Create: supabase/functions/intelligence/clustering.ts
- Test: supabase/functions/tests/intelligence/clustering_test.ts

**Interfaces:**

- candidatePrefilter(post, signature) returns boolean
- deterministicSimilarity(post, signature) returns SimilarityResult
- decideDeterministicMatch(result) returns DeterministicDecision
- mergeSignature(signature, post, postId) returns ClusterSignature
- selectRepresentativeMembers(members, limit=3) returns string[]

- [ ] Add fixtures for same English story, different English story, English/Korean Bruno injury, same journalist repost, same player/different event, same match/different event, pre-filter exclusion, and 0.40/0.85 boundaries.
- [ ] Implement weighted similarity: entity .35, event .20, source .15, number/opponent .10, time .10, caption .10; missing signals remain zero.
- [ ] Implement contradiction gates and 24-hour candidate pre-filter.
- [ ] Compare complete aggregate signature first; on ambiguity compare up to three reliability/freshness-ranked members.
- [ ] Implement signature union and AUTO_MERGE, SEPARATE, AMBIGUOUS decisions with reason codes.
- [ ] Run focused clustering tests and commit with message feat: add aggregate signature clustering.

### Task 4: AI ambiguity classifier and audit persistence

**Files:**
- Create: supabase/functions/intelligence/ai_classifier.ts
- Modify: supabase/functions/intelligence/repository.ts
- Test: supabase/functions/tests/intelligence/ai_classifier_test.ts

**Interfaces:**

- createStoryClassifier(deps) returns StoryClassifier
- classifyAmbiguousPair(input) returns Promise<ClassifierResult>
- classifierVersion(model, promptVersion, dictionaryVersion) returns string
- saveEvaluation(evaluation) returns Promise<void>

- [ ] Add mocked-fetch tests proving high/low deterministic decisions do not call OpenAI, ambiguity calls once, flag off returns manual review, and model/prompt/dictionary changes produce distinct classifier versions.
- [ ] Add timeout, 429/5xx, malformed JSON, missing field, low confidence, and oversized reason tests.
- [ ] Implement normalized-only structured request and response validation.
- [ ] Map only confidence>=0.90 same/separate to automatic decisions; all other outcomes are manual review/error.
- [ ] Persist canonical pair ids, model, prompt version, dictionary version, classifier version, hash/snapshot, result, confidence, and evaluated time using unique conflict handling.
- [ ] Run focused tests and commit with message feat: add conservative AI ambiguity resolution.

### Task 5: Repository and idempotent orchestrator

**Files:**
- Create: supabase/functions/intelligence/repository.ts
- Create: supabase/functions/intelligence/orchestrator.ts
- Test: supabase/functions/tests/intelligence/orchestrator_test.ts

**Interfaces:**

- createIntelligenceRepository(options) returns IntelligenceRepository
- runIntelligence(options) returns Promise<IntelligenceRunSummary>
- loadEligibleAccounts(runAt) returns Promise<EligibleAccountSnapshot>
- upsertMembership(input) returns Promise<void>
- calculateCandidates(runAt) returns Promise<number>

- [ ] Add tests for lease contention, expired lease takeover, heartbeat scheduling, eligible account observation, partial account failures, rerun idempotency, manual review, and score invocation.
- [ ] Implement recent-post, eligible-account, source-registry, signature, evaluation, and RPC repository queries. Keep api_supported NULL/false outside denominators and record their ids.
- [ ] Acquire lease before processing, renew using parsed config, release in finally, and return already_running without processing when busy.
- [ ] Process features, pre-filter, aggregate signatures, AI ambiguity, membership/audit, source aggregates, and SQL scoring in that order.
- [ ] Set KNOWN only when eligible KR completeness is 1.0 and no unresolved GLOBAL↔KR evaluation exists; otherwise set UNCERTAIN and force gap score 0/FIRST_MOVER false at SQL boundary.
- [ ] Apply OPEN/ACTIVE/STALE/ARCHIVED lifecycle transitions from first_seen_at, last_seen_at, member count, and the 6-hour/7-day rules before candidate calculation.
- [ ] Expose get_todays_candidates with deterministic rank ordering and component/coverage/status fields for later Notion and Telegram consumers.
- [ ] Run focused tests and commit with message feat: orchestrate idempotent intelligence runs.

### Task 6: Edge Function API

**Files:**
- Create: supabase/functions/intelligence/handler.ts
- Create: supabase/functions/intelligence/index.ts
- Test: supabase/functions/tests/intelligence/handler_test.ts

**Interfaces:**

- createIntelligenceHandler(deps) returns request-to-Response handler
- POST body is empty or { "as_of": "<ISO timestamp>" }
- success returns request_id, run_id, status, clusters_processed, candidates_upserted
- busy returns HTTP 202 with status already_running

- [ ] Test POST/auth, body validation, as-of parsing, busy response, safe partial result, and secret/raw-error non-leakage.
- [ ] Implement timing-safe bearer authentication using the existing collector invocation secret contract.
- [ ] Wire Supabase client, config, repository, classifier, orchestrator, and Deno.serve in index.ts.
- [ ] Run handler tests and commit with message feat: expose intelligence edge function.

### Task 7: n8n integration

**Files:**
- Modify: n8n/workflows/instagram-collector-schedule.json
- Modify: n8n/README.md
- Modify: scripts/validate-n8n-workflow.mjs

- [ ] Extend validator to require collector → intelligence connection, M4 endpoint, POST, JSON response, timeout, and no secret/key in export.
- [ ] Add Run Content Intelligence HTTP node with existing credential, 120-second timeout, and continue-on-failure behavior.
- [ ] Document publish/manual execution and HTTP 202 already-running behavior.
- [ ] Run validator and commit with message feat: trigger intelligence after collector.

### Task 8: Smoke verification and full suite

**Files:**
- Create: scripts/run-milestone-4-smoke.sh
- Create: scripts/verify-milestone-4-smoke.sql
- Modify: README.md

- [ ] Add SQL assertions for recent non-archived clusters, one-post-one-cluster membership, score/config match, Korea status, flags, and duplicate keys.
- [ ] Add smoke runner that invokes the function and outputs only TOP 5 safe fields: title, member usernames, region counts, components, confidence, flags, and Korea status.
- [ ] Document local serve/config/test/smoke commands without printing secrets.
- [ ] Run the full suite.

~~~bash
supabase db reset --local
supabase seed buckets
supabase test db
supabase db lint --local --schema public,app_private --level warning
docker run --rm --add-host=host.docker.internal:host-gateway --env SUPABASE_URL="$LOCAL_SUPABASE_URL" --env SUPABASE_SECRET_KEY="$LOCAL_SUPABASE_SECRET_KEY" -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env --allow-net functions/tests
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
./scripts/run-milestone-4-smoke.sh --output /tmp/milestone-4-smoke.json
~~~

Expected: all pgTAP/Deno tests pass, DB lint and workflow validation pass, and smoke output contains no token, secret, raw payload, or full upstream error.

- [ ] Perform human sanity review on at least three actual clusters, including one English/Korean pair.
- [ ] Commit with message test: add milestone 4 smoke verification.

### Task 9: Final review and handoff

**Files:** all M4 files above.

- [ ] Run git diff --check and scan tracked files for secret values.
- [ ] Map every spec requirement to a test or smoke assertion, especially KR gate, uncertainty, model-aware dedupe, aggregate signature, exact confidence factors, and lease config bounds.
- [ ] Re-run complete tests from a clean local reset.
- [ ] Confirm branch diff excludes Notion, Telegram, Creative Brief, Figma, score history, and unrelated refactors.
- [ ] Present branch, commits, test counts, smoke summary, and known manual-review items.

## Execution Order

Tasks are sequential because each later boundary consumes the previous task's schema or interface. Each task ends with a focused test and commit; Task 8 is the final integration gate. No implementation action is authorized by this plan document alone.
