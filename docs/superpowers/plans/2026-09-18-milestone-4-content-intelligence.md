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
- Korean Saturation은 K를 공식에 넣지 않으며 KR post가 있고 valid KR outperformance ratio가 없으면 score 0이다.
- Global Momentum ratio는 post-level → per-account median → account priority_weight weighted median의 2단계 aggregation을 사용한다.
- Baseline fallback은 account+media+age(n>=5), account+age(n>=5), region cohort+media+age(n>=20), unavailable 순서다.
- Missing component는 weight redistribution 없이 0으로 처리하고 Data Confidence만 낮춘다.
- Lease와 heartbeat는 STORY_INTELLIGENCE_LEASE_SECONDS(기본 300, 허용 60~1800), STORY_INTELLIGENCE_HEARTBEAT_SECONDS(기본 30, lease 절반 미만)으로 설정한다.
- 신규 private schema/table/function은 RLS 또는 schema revoke, empty search_path, service-role EXECUTE만 사용한다.
- 구현 전 실제 secret, raw payload, upstream 오류 본문을 로그에 출력하지 않는다.

## Implementation Preconditions (must be locked before Task 1)

- **Baseline self-leakage 방지:** 평가 대상 `raw_post_id`는 모든 baseline sample query에서
  `raw_post_id <> evaluated_raw_post_id`로 제외한다. `same-region cohort` fallback은 여기에
  현재 story cluster의 모든 member id를 `NOT IN (current_cluster_member_ids)`로 추가 제외한다.
  제외 후의 sample count로 n>=5/n>=20 fallback을 다시 판정하며, 제외된 id와 최종 n을
  `score_inputs`에 기록한다.
- **M3 metric contract 확인:** `post_metric_snapshots`를 metric source of truth로 사용한다.
  M3는 `captured_at`과 `capture_bucket_start=date_bin('30 minutes', captured_at,
  '2000-01-01T00:00:00Z')`를 저장하고 `(raw_post_id, capture_bucket_start)`가 unique하다.
  `post_age_minutes=floor((collected_at-published_at)/60)`일 때 refresh cadence는
  `[0,120)→30m`, `[120,360)→1h`, `[360,720)→2h`, `[720,1440)→4h`, `>=1440→refresh 없음`이다.
  age bucket은 `[0,60)`, `[60,180)`, `[180,360)`, `[360,720)`, `[720,1440)`로 해석하며
  음수/미래 post와 1440분 이상 post는 candidate score에서 제외한다.
- **Snapshot 선택과 최소 Δt:** run마다 `s0=max(captured_at <= run_at)`,
  `s1=max(captured_at <= s0.captured_at-30m)`, `s2=max(captured_at <= s1.captured_at-30m)`를
  post별로 선택한다. 미래 snapshot은 사용하지 않으며 실제 `Δt01`, `Δt12`가 각각
  30분 이상이어야 한다. valid ER은 `followers>0` 및 like/comments/followers가 모두
  non-null인 snapshot의
  `(like_count + scoring_configs.comment_multiplier * comments_count) / followers_count`다.
  multiplier는 해당 candidate가 참조하는 동일 `scoring_config_id`/version의
  `scoring_configs.comment_multiplier`를 사용하고 `score_inputs`에 config id, version,
  multiplier를 함께 기록한다.
  `v_current=(ER0-ER1)/hours(Δt01)`, `v_previous=(ER1-ER2)/hours(Δt12)`로 계산하고,
  `velocity_ratio=v_current/baseline_velocity`, `acceleration_ratio=v_current/v_previous`를
  각각 양의 분모가 `0.000001 ER/hour` 초과일 때만 계산한다. 미충족 시 해당 component는 0이다.
- **run_at 기준 timestamp predicate:** 모든 lifecycle/candidate query는 실제 timestamp를
  `run_at`에 대입한다. candidate는
  `first_seen_at >= run_at - interval '24 hours' AND first_seen_at <= run_at`,
  ARCHIVED(자동)는 `last_seen_at < run_at - interval '7 days'`, STALE는
  `last_seen_at < run_at - interval '6 hours' AND last_seen_at >= run_at - interval '7 days'`,
  recent는 `last_seen_at >= run_at - interval '6 hours' AND last_seen_at <= run_at`이다.
  경계값은 6시간/7일에 포함되는 쪽으로 고정하며 manual archive와 archived non-reopen
  규칙은 이 predicate보다 우선한다.
- **Founding/seed membership:** 새 cluster의 첫 post는 `match_method='SEED'`와
  `membership_confidence=1.0`으로 저장한다. member가 1개일 때만 전체 `C_cluster=0.60`
  special case를 적용한다. member가 2개 이상이면 seed도 weighted aggregation에 1.0으로
  포함하고, deterministic high-confidence는 0.95, AI accepted는 classifier confidence를
  사용하며 manual_review post는 제외한다. seed가 reassign되어 사라지면 남은 member 중
  `(created_at, raw_post_id)` 최소를 새 SEED로 승격해 같은 규칙을 적용한다.

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

**Migration/RPC/function scope:** schema columns and constraints, the singleton lease RPCs,
membership/reassignment RPCs, baseline/snapshot helper functions, deterministic score
functions, lifecycle/candidate upsert, and read-only candidate query.

**Failing test first:** extend `007_milestone_4_intelligence_test.sql` with pgTAP cases for
the exact M3 snapshot selection (`s0/s1/s2`, 30-minute minimum Δt), each half-open age bucket,
baseline exclusion of the evaluated post and cluster members, seed confidence promotion,
run_at timestamp predicates at exactly 6h/7d/24h, and lease contention. Run the focused file
before creating the migration and confirm missing relations/functions fail.

**Implementation:** add the migration, seed the versioned config, and implement all RPCs with
`SECURITY INVOKER`, empty `search_path`, service-role-only EXECUTE, row locks, and atomic
expiry predicates. Persist `match_method='SEED'` and confidence 1.0 for a founding post;
promote the deterministic earliest member if the seed is reassigned. Implement baseline SQL
with the two self-leakage exclusions and post-snapshot SQL with the preconditions above.

**Verification:**

~~~bash
supabase db reset --local
supabase seed buckets
supabase test db
supabase db lint --local --schema public,app_private --level warning
~~~

**Done when:** pgTAP passes with assertions for all schema/RPC/security contracts,
self-leakage and time-boundary fixtures, the M3 cadence and age buckets are encoded as
deterministic tests, DB lint is clean, and the migration is committed as
`feat: add milestone 4 intelligence schema and score functions`.

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

**Migration/RPC/function scope:** no database migration; implement the typed runtime config,
bilingual feature extractor, and canonical JSON SHA-256 helper consumed by clustering and AI audit.

**Failing test first:** add named Deno tests for NFKC/case-folding, Korean spacing/particles,
Bruno/injury/source aliases, number/date normalization, unknown entity preservation, lease and
heartbeat bounds, and hash changes when a raw post or aggregate signature changes. Run the two
test files before implementation and confirm imports/functions are missing.

**Implementation:** parse `STORY_CLUSTER_AI_ENABLED`, model, prompt/dictionary versions, lease,
and heartbeat strictly; reject lease outside 60–1800 seconds and heartbeat below 10 seconds or
at least half the lease without echoing values. Keep unknown tokens explicit. Hash a stable-key
ordered object containing raw post features plus the full aggregate candidate-cluster signature;
never sort or canonicalize post pairs.

**Verification:**

~~~bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env functions/tests/intelligence/config_test.ts functions/tests/intelligence/features_test.ts
~~~

**Done when:** all config/feature/hash tests pass, boundary errors are safe and non-secret,
and the task is committed as `feat: add intelligence config and bilingual features`.

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

**Migration/RPC/function scope:** pure TypeScript deterministic pre-filter, similarity,
decision, signature union, and representative-member selection; no external API calls.

**Failing test first:** add fixtures for same/different English stories, English/Korean Bruno
injury, same journalist repost, same player/different event, same match/different event,
pre-filter exclusion, exact 0.40/0.85 thresholds, and aggregate-signature changes. Run the
clustering test file before implementation and confirm the exported functions are absent.

**Implementation:** apply entity .35, event .20, source .15, number/opponent .10, time .10,
caption .10 with missing signals zero; enforce contradiction gates and the story-similarity
candidate pre-filter. Compare the complete aggregate signature first, then at most three
reliability/freshness-ranked representatives. The 24-hour timestamp window is owned solely by
Task 5's repository/orchestrator query.
Return AUTO_MERGE, SEPARATE, or AMBIGUOUS with stable reason codes and union entities/events/
sources/numbers/time into the signature.

**Verification:**

~~~bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env functions/tests/intelligence/clustering_test.ts
~~~

**Done when:** deterministic boundary, cross-language, aggregate-signature, and pre-filter
tests pass and the task is committed as `feat: add aggregate signature clustering`.

### Task 4: AI ambiguity classifier and audit persistence

**Files:**
- Create: supabase/functions/intelligence/ai_classifier.ts
- Create: supabase/functions/intelligence/repository.ts
- Test: supabase/functions/tests/intelligence/ai_classifier_test.ts

**Interfaces:**

- createStoryClassifier(deps) returns StoryClassifier
- classifyAmbiguousPair(input) returns Promise<ClassifierResult>
- classifierVersion(model, promptVersion, dictionaryVersion) returns string
- saveEvaluation(evaluation) returns Promise<void>

**Migration/RPC/function scope:** ambiguity-only structured classifier client and repository
adapter for `story_cluster_evaluations`; it may return only same_story, confidence, and reason.

**Failing test first:** add mocked-fetch tests proving high/low deterministic decisions do not
call OpenAI, ambiguity calls once, the feature flag returns manual review, and model/prompt/
dictionary changes produce distinct classifier versions. Add failure fixtures for timeout,
429/5xx, malformed JSON, missing fields, confidence below 0.90, oversized reason, and duplicate
upsert identity. Run the test file before implementation and confirm it fails.

**Implementation:** send normalized-only structured input containing raw post features and the
aggregate candidate-cluster signature/member references. Accept automatic SAME_STORY or
DIFFERENT_STORY only at confidence >=0.90; otherwise persist MANUAL_REVIEW or ERROR. Persist
identity `(raw_post_id, candidate_cluster_id)` and unique key
`(raw_post_id, candidate_cluster_id, classifier_version, input_hash)` with model, prompt/
dictionary versions, snapshot/hash, result, confidence, and evaluated_at. Signature/member
changes must produce a new input hash.

**Verification:**

~~~bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env --allow-net functions/tests/intelligence/ai_classifier_test.ts
~~~

**Done when:** all call-budget, conservative-decision, schema-validation, and audit-dedupe
tests pass and the task is committed as `feat: add conservative AI ambiguity resolution`.

### Task 5: Repository and idempotent orchestrator

**Files:**
- Modify: supabase/functions/intelligence/repository.ts
- Create: supabase/functions/intelligence/orchestrator.ts
- Test: supabase/functions/tests/intelligence/orchestrator_test.ts

**Interfaces:**

- createIntelligenceRepository(options) returns IntelligenceRepository
- runIntelligence(options) returns Promise<IntelligenceRunSummary>
- loadEligibleAccounts(runAt) returns Promise<EligibleAccountSnapshot>
- upsertMembership(input) returns Promise<void>
- calculateCandidates(runAt) returns Promise<number>

**Migration/RPC/function scope:** repository queries and the idempotent run orchestrator,
including lease heartbeat, eligible-account snapshots, lifecycle transitions, source aggregation,
AI/manual-review routing, and the final SQL scoring call.

**Failing test first:** add orchestrator tests for lease contention/expiry takeover, configured
heartbeat timing, partial account failure, NULL/false capability exclusion, rerun idempotency,
manual review, self-leakage inputs, seed promotion, and score invocation. Add table-driven
lifecycle tests at exact `run_at-6h`, `run_at-7d`, and `run_at-24h` boundaries plus future
timestamps. Run before implementation and confirm missing repository/orchestrator exports fail.

**Implementation:** query recent posts with real run_at predicates, acquire the singleton lease
before work, renew at the configured heartbeat, release in `finally`, and return
`already_running` without processing when busy. Process feature extraction, pre-filter,
aggregate signature, ambiguity AI, membership/audit, source aggregates, two-stage GLOBAL/KR
ratio aggregation, and SQL scoring in that order. Keep capability-pending/unsupported ids only
in audit fields. Set KNOWN only for completeness 1.0 with no unresolved GLOBAL↔KR evaluation;
otherwise force UNCERTAIN, gap 0, and FIRST_MOVER false at the SQL boundary. Apply exact
lifecycle precedence and predicates from the preconditions, including manual archive first and
archived non-reopen. Ensure a reassigned seed promotes the `(created_at, raw_post_id)` minimum.

**Verification:**

~~~bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env --allow-net functions/tests/intelligence/orchestrator_test.ts
~~~

**Done when:** lease/concurrency, timestamp boundaries, account gates, uncertainty, aggregation,
membership/audit ordering, and idempotent rerun tests pass and the task is committed as
`feat: orchestrate idempotent intelligence runs`.

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

**Migration/RPC/function scope:** authenticated HTTP handler and Deno entrypoint only; the
handler delegates all business logic to Task 5's `runIntelligence`.

**Failing test first:** add handler tests for valid/invalid bearer auth, empty and malformed
POST bodies, ISO `as_of` parsing, 202 already-running, safe partial results, and absence of
secrets/raw upstream error text. Run before implementation and confirm the handler factory is
missing.

**Implementation:** use timing-safe bearer comparison with the existing collector invocation
secret contract, validate `{as_of}` as an ISO timestamp, and wire Supabase client, config,
repository, classifier, orchestrator, and `Deno.serve`. Return only the documented summary and
request id; never echo credentials or upstream payloads.

**Verification:**

~~~bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env --allow-net functions/tests/intelligence/handler_test.ts
~~~

**Done when:** auth, input, status, safe-output, and delegation tests pass and the task is
committed as `feat: expose intelligence edge function`.

### Task 7: n8n integration

**Files:**
- Modify: n8n/workflows/instagram-collector-schedule.json
- Modify: n8n/README.md
- Modify: scripts/validate-n8n-workflow.mjs

**Migration/RPC/function scope:** workflow-only integration; no new database or Edge Function
logic. The collector success path invokes the Task 6 endpoint exactly once per workflow run.

**Failing test first:** update `scripts/validate-n8n-workflow.mjs` tests/fixtures to fail when
the collector→intelligence edge, POST method, M4 endpoint, JSON response handling, timeout,
credential reference, or no-secret export rule is absent.

**Implementation:** add the Run Content Intelligence HTTP node with the existing credential,
120-second timeout, continue-on-failure, and explicit handling of HTTP 202 `already_running`.
Document publish/manual execution and retry semantics in `n8n/README.md` without exposing
credentials.

**Verification:**

~~~bash
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
~~~

**Done when:** validator assertions pass, the exported workflow has no token/key, the node is
connected after collection, and the task is committed as `feat: trigger intelligence after collector`.

### Task 8: Smoke verification and full suite

**Files:**
- Create: scripts/run-milestone-4-smoke.sh
- Create: scripts/verify-milestone-4-smoke.sql
- Modify: README.md

**Migration/RPC/function scope:** SQL smoke assertions, safe shell runner, and user-facing
verification documentation; no production scoring logic.

**Failing test first:** add smoke assertions that initially fail without M4 objects/data:
recent candidate timestamp predicate, non-ARCHIVED lifecycle, one-post-one-cluster, score/config
version match, Korea status/uncertainty and flag gates, duplicate evaluation/membership keys,
baseline exclusion, M3 snapshot Δt/age boundaries, and seed confidence.

**Implementation:** make the runner invoke the Edge Function and emit only TOP 5 safe fields
(title, member usernames, region counts, components, confidence, flags, Korea status). Document
local serve/config/test/smoke commands and the no-secret output contract in `README.md`.

**Verification:**

~~~bash
supabase db reset --local
supabase seed buckets
supabase test db
supabase db lint --local --schema public,app_private --level warning
docker run --rm --add-host=host.docker.internal:host-gateway --env SUPABASE_URL="$LOCAL_SUPABASE_URL" --env SUPABASE_SECRET_KEY="$LOCAL_SUPABASE_SECRET_KEY" -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test --allow-env --allow-net functions/tests
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
./scripts/run-milestone-4-smoke.sh --output /tmp/milestone-4-smoke.json
~~~

Expected: all pgTAP/Deno tests pass, DB lint and workflow validation pass, and smoke output
contains no token, secret, raw payload, or full upstream error.

**Done when:** the full reset/test/lint/function/workflow/smoke sequence passes, output is safe,
and human sanity review covers at least three actual clusters including one English/Korean pair.
Commit as `test: add milestone 4 smoke verification`.

### Task 9: Final review and handoff

**Files:** all M4 files above.

**Migration/RPC/function scope:** final review only; no production code changes beyond the
previous tasks.

**Failing test first:** before declaring completion, run the repository-wide checks against a
clean reset and require failure if any task test, SQL assertion, workflow validator, secret scan,
or spec-to-test mapping is missing.

**Implementation:** none. Review the diff against the approved spec, confirm baseline self-
leakage exclusions, M3 snapshot/cadence rules, run_at timestamp predicates, seed confidence,
two-stage GLOBAL/KR aggregation, KR gate/uncertainty, model-aware AI identity, aggregate
signature, lifecycle precedence, exact confidence factors, and lease config bounds.

**Verification:**

~~~bash
git diff --check
rg -n "(OPENAI_API_KEY|SUPABASE_SECRET_KEY|META_ACCESS_TOKEN|Authorization:)" --glob '!*.md' .
supabase db reset --local
supabase seed buckets
supabase test db
supabase db lint --local --schema public,app_private --level warning
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
~~~

**Done when:** the branch diff contains only M4 files, all tests/validation pass, no secret or
raw payload is exposed, every spec requirement maps to a test/smoke assertion, and the final
handoff lists commits, counts, smoke output, and known manual-review items.

## Execution Order

Tasks are sequential because each later boundary consumes the previous task's schema or interface. Each task ends with a focused test and commit; Task 8 is the final integration gate. No implementation action is authorized by this plan document alone.
