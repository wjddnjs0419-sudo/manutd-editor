# MU Content Intelligence System — Milestone 4 설계

- 작성일: 2026-09-18
- 상태: 구현 계획 승인 대기 (구현 전)
- 대상 branch: `milestone-4-content-intelligence`
- 언어: 한국어

## 1. 목적과 범위

Milestone 4는 여러 경쟁 Instagram 계정의 게시물을 underlying story 단위로
묶고, 그 story에 대해 결정론적인 Priority Score와 Data Confidence를 계산한다.
결과는 `story_clusters`와 `content_candidates`에 저장하며, 이후 Notion,
Telegram, Creative Brief가 조회할 수 있는 TOP candidate contract를 제공한다.

이번 milestone의 범위는 다음과 같다.

- deterministic candidate generation과 story clustering
- 영어↔한국어 cross-language clustering
- ambiguity zone의 제한적 OpenAI structured classifier
- information source registry 연결
- Priority Score v1의 10개 component 계산
- Data Confidence와 FIRST_MOVER/MUST_COVER flag
- cluster lifecycle, 재실행 멱등성, concurrent run 제어
- deterministic/AI audit와 manual review queue
- unit, cluster, pgTAP, 실제 데이터 smoke test

이번 milestone에서 하지 않는 것은 Creative Brief, Notion API, Telegram UI,
Figma 지시, score history table이다.

## 2. 검증된 전제

M3 구현 전제는 다음과 같이 확인되었다.

- 현재 `main`은 clean하고 `origin/main`과 동일하다.
- M3 다계정 collector, metric refresh, media storage와 n8n workflow가 `main`에
  포함되어 있다.
- 표준 local reset/Storage bucket seed 후 pgTAP 125건, Deno 56건, DB lint,
  n8n workflow validation이 통과한다.
- Supabase project ref는 `byymtttpwmllqvggnddm`이다.

구현은 이 branch에서만 진행하며 M3 branch에 이어붙이지 않는다.

## 3. 전체 runtime 흐름

~~~text
n8n 30분 collector 완료
  → M4 intelligence Edge Function
      → recent raw_posts 조회
      → deterministic feature extraction
      → deterministic candidate pre-filter
      → cluster signature 비교 및 membership 결정
      → ambiguity pair에 한해 OpenAI classifier
      → information source registry 연결
      → cluster aggregate/signature 갱신
      → PostgreSQL deterministic score function
      → content_candidates upsert
~~~

n8n은 orchestration만 담당한다. threshold, AI prompt, score 수식은 n8n Code
Node에 넣지 않는다. collector가 일부 계정 실패를 반환해도 intelligence는
성공적으로 관측된 데이터로 실행한다.

## 4. Story feature와 cross-language 정규화

게시물은 다음 canonical feature로 정규화한다.

- player, club, opponent, competition 등 canonical entity
- injury, transfer, lineup, match, suspension 등 event concept
- score, shirt number, fee, date 등 숫자/날짜
- `information_sources`의 canonical source와 alias
- publication time과 24시간 window 내 time distance
- 언어별 normalized token/character similarity

정규화 순서는 Unicode NFKC, 영문 case-folding, 한국어 조사·구두점 정리,
alias lookup, 숫자/date canonicalization이다.

예를 들어 `Bruno Fernandes`, `Bruno`, `브루노 페르난데스`는
`bruno_fernandes`로, `injury update`, `부상 소식`은 `injury`로
정규화한다. 모르는 entity를 임의로 번역하거나 동일 entity로 추정하지 않는다.

v1에서는 player/event dictionary를 별도 public table로 만들지 않고 versioned
Edge Function dictionary module로 관리한다. dictionary version은 cluster
evaluation audit와 `score_inputs`에 기록한다. source entity는 기존
`information_sources` registry를 사용한다.

## 5. Cluster signature와 candidate generation

각 `story_cluster`는 member 전체의 누적 signature를 가진다.

~~~json
{
  "entities": ["bruno_fernandes", "manchester_united"],
  "events": ["injury"],
  "sources": ["fabrizio_romano"],
  "numbers": [],
  "first_published_at": "...",
  "last_published_at": "...",
  "representative_post_ids": ["...", "...", "..."],
  "dictionary_version": "entity-v1"
}
~~~

신규 게시물은 representative post 하나와 비교하지 않는다. 먼저 signature의
entity/event/source/number/time aggregate와 비교하고, ambiguity일 때만
신뢰도·최신성이 높은 representative member 최대 3개를 추가 비교한다.
signature는 membership 변경이 commit된 같은 RPC transaction에서 갱신한다.

모든 pair를 비교하지 않기 위해 다음 pre-filter를 적용한다.

~~~text
published_at 차이 <= 24시간
AND
(canonical entity overlap
 OR event + team/opponent overlap
 OR recognized source overlap
 OR number/match-info overlap
 OR normalized caption similarity >= 0.25)
~~~

## 6. Deterministic similarity threshold

`S_det`은 0~1 범위의 고정 가중합이다.

~~~text
entity overlap       0.35
event overlap        0.20
source overlap       0.15
number/opponent      0.10
time proximity       0.10
caption similarity   0.10
~~~

없는 signal은 0으로 두며 다른 weight를 redistribution하지 않는다. primary
entity overlap이 없으면 높은 점수만으로 merge하지 않는다.

| 구간 | 판정 |
|---|---|
| `S_det >= 0.85` + primary entity overlap + contradiction 없음 | AI 없이 same-story 자동 merge |
| `S_det <= 0.40`, window 초과, 명백한 contradictory anchor | AI 없이 separate |
| `0.40 < S_det < 0.85` | ambiguity zone; AI 또는 manual review |

같은 선수/경기 이름이지만 event가 다른 경우(예: injury와 lineup)는
contradictory 또는 different event로 처리하여 false merge를 막는다.

## 7. AI ambiguity resolution

AI는 ambiguity zone에서만 호출한다. 입력은 두 caption과 정규화 entity,
event, timestamp, known source이며 raw payload나 secret은 전달하지 않는다.

응답 schema는 다음 세 값만 사용한다.

~~~json
{
  "same_story": true,
  "confidence": 0.94,
  "reason": "동일 선수의 동일 부상 업데이트이며 시간과 출처가 가깝다"
}
~~~

판정 규칙은 다음과 같다.

~~~text
same_story=true  AND confidence>=0.90 → merge
same_story=false AND confidence>=0.90 → separate
그 외 또는 API 실패/malformed → manual_review
~~~

AI가 cluster의 주체가 아니므로 high same/different deterministic 구간에서는
호출하지 않는다. AI confidence가 낮으면 자동 merge하지 않는다.

feature flag는 다음 환경 변수로 제어한다.

~~~text
STORY_CLUSTER_AI_ENABLED=true|false
STORY_CLUSTER_AI_MODEL=<configured model>
STORY_CLUSTER_AI_PROMPT_VERSION=cluster-v1
~~~

flag가 false이면 ambiguity pair는 전부 manual review다.

## 8. AI audit와 manual review

기존 membership table만으로는 AI가 separate로 판정한 pair나 보류 pair를
감사할 수 없으므로 private schema에 최소 audit/queue table을 추가한다.

`app_private.story_cluster_evaluations`의 주요 필드는 다음과 같다.

~~~text
raw_post_id
candidate_cluster_id nullable
deterministic_score
decision (SAME_STORY|DIFFERENT_STORY|MANUAL_REVIEW|ERROR)
same_story nullable
confidence nullable
reason
model
prompt_version
dictionary_version
classifier_version (model + prompt_version + dictionary_version)
input_hash (canonical JSON SHA-256)
input_snapshot (normalized, non-secret input)
result (structured classifier result)
evaluated_at
review_status
resolved_cluster_id nullable
resolved_at nullable
~~~

pair의 post id는 작은 UUID가 앞에 오도록 canonicalize한다. 동일 pair·동일
`classifier_version`·동일 input hash는 unique하게 저장한다.
`classifier_version`은 다음 세 값을 결합한 문자열이다.

~~~text
model + prompt_version + dictionary_version
~~~

따라서 model이 바뀌면 같은 input/prompt라도 새 평가가 가능하다.
`model`, `prompt_version`, `dictionary_version`은 별도 column으로도 저장한다.
`raw_posts` 변경이나 dictionary 변경으로 hash가 바뀌면 새 평가로 남긴다.

manual resolution은 service-role 전용 `reassign_story_cluster_post` RPC를
사용한다. 잘못 merge된 post를 분리할 때는 새 cluster를 만들고 membership을
이동하며, `story_cluster_posts.raw_post_id` unique 제약을 유지한다.

## 9. Cluster lifecycle

- OPEN: member 1개이고 최초 감지 후 6시간 이내
- ACTIVE: member 2개 이상이거나 최근 6시간 이내 유효 coverage가 추가됨
- STALE: `last_seen_at`이 6시간 초과이고 7일 이내
- ARCHIVED: `last_seen_at`이 7일 초과 또는 명시적 archive

Candidate 계산 window는 lifecycle과 독립적으로 `first_seen_at <= 24h`로
제한한다. ARCHIVED cluster는 계산에서 제외한다.

## 10. Independent source extraction

먼저 deterministic parser로 canonical name, aliases, Instagram username,
known domain/pattern을 검사한다. 발견된 이름만 기존
`information_sources` row와 연결한다.

인식되지 않은 source는 unknown/unverified로 남기며 reliability 숫자를 만들지
않는다. `story_cluster_sources`의 distinct information source만 diversity와
reliability에 사용한다. Instagram repost account 수는 source diversity가 아니다.

## 11. Priority Score v1

기존 100점 allocation과 `content_candidates.priority_score` generated
column을 유지한다.

| Component | Max | 규칙 |
|---|---:|---|
| Global Spread | 12 | global weighted coverage × 12 |
| Engagement Outperformance | 12 | weighted median ER/baseline ratio curve |
| Engagement Velocity | 10 | velocity ratio curve |
| Velocity Acceleration | 6 | 기존 1.0x/1.25x/1.5x/1.75x/2.0x curve |
| Korea Coverage Gap | 15 | `15 × min(G/0.60,1) × (1-K)`, known 상태에서만 |
| First-Mover Window | 10 | 기존 age curve, 추가 gate 적용 |
| Korean Saturation | 10 | 아래 별도 규칙 |
| Reliability | 10 | verified source 중 highest registry score |
| Source Diversity | 5 | 1→1, 2→3, 3+→5 |
| Freshness | 10 | 기존 story age curve |

### Baseline과 outperformance

baseline fallback은 다음 순서와 최소 sample로 고정한다.

~~~text
1. account + media_type + age_bucket, n>=5
2. account + age_bucket, n>=5
3. same-region cohort + media_type + age_bucket, n>=20
4. unavailable
~~~

median을 사용하고, fallback level과 sample count를 모두 audit한다.

outperformance curve는 `0.5x→0, 1.0x→3, 1.5x→6, 2.0x→9, 2.5x→12`이다.
여러 member account는 maximum이 아니라 priority weight weighted median을
사용한다.

velocity curve는 `0.5x→0, 1.0x→2.5, 1.5x→5, 2.0x→7.5, 2.5x→10`이다.
이전 interval velocity와 baseline velocity가
`0.000001 ER/hour` 이하이면 ratio 폭발을 막고 해당 component를 0으로 둔다.

### Korean Coverage Gap과 uncertainty

~~~text
eligible monitored accounts
  = active = true AND api_supported = true
  (region별로 같은 조건을 적용)

G = eligible GLOBAL account weighted coverage
K = eligible KR account weighted coverage
gap = 15 × min(G/0.60, 1) × (1-K)
~~~

api_supported IS NULL은 아직 capability probe가 끝나지 않은 초기 상태로
간주한다. 이 계정은 eligible denominator와 observation completeness numerator
어디에도 넣지 않지만, score_inputs에 pending_capability_account_ids로
기록한다. api_supported = false 계정도 현재 M4 관측 불가 계정이므로
denominator에서 제외하고 unsupported_account_ids로 기록한다. 이후 probe가
true가 되면 다음 intelligence run부터 eligible set에 포함한다. 따라서 API
미지원/미확정 계정이 coverage를 영구적으로 희석하지 않는다.

coverage denominator는 run 시각에 조회한 region별 eligible set의 전체
priority_weight 합이다. eligible account가 하나도 없는 region의 coverage는
0이지만, KR eligible set이 비어 있으면 FIRST_MOVER를 만들 수 없다.

cluster coverage 자체는 해당 eligible account가 cluster member를 하나 이상
가지는지로 계산한다.

~~~text
coverage_R(cluster) =
  sum(priority_weight of eligible region-R accounts represented in cluster)
  /
  sum(priority_weight of all eligible region-R accounts)
~~~

관측 freshness와 별도로 저장되는 값이므로, stale account가 이미 올린 member는
coverage에는 남지만 FIRST_MOVER gate와 observation completeness에는 사용할 수
없다.

KR observation completeness는 다음 식으로 계산하며, eligible KR account가
하나 이상일 때 값이 1.0이어야 KNOWN으로 본다.

~~~text
KR_observation_completeness =
  sum(priority_weight of eligible KR accounts with fresh successful probe)
  /
  sum(priority_weight of all eligible KR accounts)
~~~

eligible KR account가 하나 이상이고 KR observation completeness < 1.0이면
korea_coverage_status = UNCERTAIN으로 저장한다. GLOBAL↔KR ambiguity pair가
unresolved/manual_review여도 UNCERTAIN으로 저장한다.

UNCERTAIN cluster는 `korea_gap_score = 0`으로 보수적으로 계산하고
`data_confidence`를 낮춘다. API와 `score_inputs`에
`KNOWN|UNCERTAIN`을 함께 반환한다.

### FIRST_MOVER

기존 조건에 다음 gate를 추가한다.

~~~text
global_coverage >= 0.30
AND korean_coverage = 0
AND velocity_ratio available AND velocity_ratio >= 1.5
AND reliability_score >= 8
AND eligible KR account count > 0
AND every eligible KR account:
      last_probe_at >= intelligence_run_at - 90 minutes
      AND last_probe_at <= intelligence_run_at
      AND probe_error IS NULL
AND korea_coverage_status = KNOWN
~~~

여기서 eligible KR account는 `active=true AND api_supported=true`인 계정이다.
`api_supported IS NULL` 또는 `false`인 계정만 있는 경우에는 eligible KR
account count가 0이므로 false다. eligible KR account 중 하나라도 최근 90분
probe가 없거나 실패하면 false다. 즉 일부 KR 계정 수집 실패·stale 상태에서
`korean_coverage=0`만으로 FIRST_MOVER를 만들 수 없다. unresolved
GLOBAL↔KR ambiguity가 있으면 항상 false다.

### Korean Saturation

Coverage Gap과 First-Mover가 한국 미커버를 담당하므로 saturation 공식에서는
`K`를 제거한다.

~~~text
KR post가 1개 이상이고 valid KR ER이 존재:
  normalized = clamp(weighted_median(KR outperformance ratio) / 2.5, 0, 1)
  korean_saturation_score = 10 × (1 - normalized)

KR post가 0개:
  korean_saturation_score = 0 (unavailable)

KR post는 있으나 valid ER이 없음:
  korean_saturation_score = 0 (conservative unavailable)
~~~

KR post가 1개인 계산은 허용하지만 Data Confidence를 낮춘다.

## 12. Missing data와 Data Confidence

component weight는 redistribution하지 않는다. followers, baseline, snapshot이
없으면 해당 momentum component는 0이다. source가 없으면 reliability와
diversity는 0이다.

Data Confidence는 다음 100점 구성이다.

~~~text
account coverage completeness   20
baseline evidence               20
metric snapshot availability    20
followers availability          15
source recognition               10
cluster certainty               10
API field availability            5
~~~

### Account coverage completeness

run 시각의 모든 eligible account(`active=true AND api_supported=true`)를
대상으로 한다.

~~~text
C_account =
  sum(priority_weight of eligible accounts with
      last_probe_at >= run_at - 90m
      AND last_probe_at <= run_at
      AND probe_error IS NULL)
  /
  sum(priority_weight of all eligible accounts)
~~~

eligible set이 비어 있으면 0이다. `api_supported IS NULL|false`는 분모에서
제외하되 score input에 별도 보존한다.

### Baseline evidence exact aggregation

각 ER/velocity baseline 사용 건의 fallback factor에 실제 sample count factor를
곱한다.

~~~text
primary fallback factor = 1.0
account-age fallback    = 0.8
cohort fallback         = 0.6
unavailable             = 0
sample_factor(n)        = min(1, sqrt(n / 50))
evidence_factor         = fallback_factor × sample_factor(n)
C_baseline              = arithmetic mean(evidence_factor for all baselines used)
~~~

사용된 baseline이 하나도 없으면 C_baseline은 0이다. n=5와 n=50은 서로 다른
confidence를 갖는다.

### Metric snapshot availability

각 member post p에 대해 run 시각까지의 snapshot 수를 세고, 최대 3개를 완전
관측으로 본다.

~~~text
snapshot_factor(p) = min(1, n_snapshot(p) / 3)
C_snapshot =
  sum(priority_weight(account(p)) × snapshot_factor(p))
  /
  sum(priority_weight(account(p)))
~~~

member post가 없거나 분모가 0이면 0이다. field null 여부는 C_api에서 별도로
측정한다.

### Followers availability

cluster member가 있는 각 account a의 최신 member post가
followers_count_at_collection IS NOT NULL AND > 0이면 F(a)=1, 아니면 F(a)=0이다.
followers 0은 수집된 유효 상태지만 ER 분모로 사용할 수 없으므로 0으로
분류한다.

~~~text
C_followers =
  sum(priority_weight(a) × F(a))
  /
  sum(priority_weight(a) for accounts represented in cluster)
~~~

represented account가 없으면 0이다.

### Source recognition

cluster caption에서 추출된 source mention 전체를 m, registry row와 매칭된
mention을 r이라 한다.

~~~text
C_source = r / m
~~~

mention이 하나도 없으면 0이다. 반복 인용도 mention 단위로 계산한다.

### Cluster certainty

~~~text
deterministic high-confidence membership = 0.95
AI accepted membership                   = classifier confidence
singleton cluster                        = 0.60
C_cluster =
  sum(priority_weight(account(i)) × membership_confidence(i))
  /
  sum(priority_weight(account(i)))
~~~

manual_review post는 membership에 포함하지 않는다. membership가 없으면
0이다. AI confidence는 C_cluster의 일부일 뿐 전체 Data Confidence와 동일하지
않다.

### API field availability

score가 직접 사용하는 raw post field는 like_count, comments_count,
followers_count_at_collection 세 개로 고정한다.

~~~text
api_factor(p) = available_non_null_fields(p) / 3
C_api =
  sum(priority_weight(account(p)) × api_factor(p))
  /
  sum(priority_weight(account(p)))
~~~

followers 0은 field가 존재하므로 available로 센다. member post가 없거나
분모가 0이면 0이다. snapshot timestamp는 M3 schema constraint로 보장되므로
중복하여 세지 않는다.

### Confidence 합산

~~~text
data_confidence =
round(100 × (
  0.20 × C_account
  + 0.20 × C_baseline
  + 0.20 × C_snapshot
  + 0.15 × C_followers
  + 0.10 × C_source
  + 0.10 × C_cluster
  + 0.05 × C_api
), 1)
~~~

## 13. Candidate 생성, rank, reproducibility

최근 24시간 내 비-ARCHIVED cluster만 candidate로 upsert한다.

rank tie-break는 다음과 같다.

~~~text
priority_score DESC
data_confidence DESC
first_seen_at DESC
story_cluster_id ASC
~~~

`content_candidates`에 `score_version`을 명시적으로 추가하고
`scoring_config_id`와 version이 일치하는지 privileged write path에서
검증한다. `score_inputs`에는 최소 다음을 보존한다.

- score version/config id
- active GLOBAL/KR account ids와 priority weights
- fresh observation 목록과 KR completeness gate 결과
- 사용한 post/member/representative ids
- aggregate cluster signature와 dictionary version
- G/K coverage와 KNOWN/UNCERTAIN 상태
- ER, baseline, sample count, fallback level
- velocity, velocity baseline, acceleration
- recognized source ids와 registry reliability
- first_seen_at, story age, missing input 목록

동일 input을 같은 config로 재계산하면 동일한 component와 total score가 나와야
한다. score history는 이번 milestone에서 만들지 않는다.

## 14. Concurrent intelligence run과 멱등성

외부 AI 호출 중 transaction lock을 유지할 수 없으므로 session advisory lock만
사용하지 않는다. private schema에 singleton lease row를 추가한다.

`app_private.intelligence_run_lock`:

~~~text
lock_name primary key ('story-intelligence')
run_id uuid nullable
acquired_at timestamptz nullable
lease_until timestamptz nullable
heartbeat_at timestamptz nullable
~~~

service-role 전용 SECURITY INVOKER RPC를 제공한다.

- `try_acquire_intelligence_run(run_id, now, lease_until)`: lease가 없거나
  만료된 경우에만 atomic update 후 true 반환
- `renew_intelligence_run(run_id, lease_until)`: 현재 run만 갱신
- `release_intelligence_run(run_id)`: 현재 run만 해제

lease duration과 heartbeat는 코드에 하드코딩하지 않고 다음 runtime config로
분리한다.

~~~text
STORY_INTELLIGENCE_LEASE_SECONDS=300
STORY_INTELLIGENCE_HEARTBEAT_SECONDS=30
~~~

config parser는 lease를 60~1800초, heartbeat를 10초 이상 lease의 절반
미만으로만 허용한다. 실제 run은 config의 lease duration으로 acquire하고
heartbeat interval로 renew한다. crash 시 lease expiry 후 다음 실행이 회복한다.
lock이 사용 중이면 already_running을 반환하고 즉시 종료한다.

동시 실행 보호는 lease만으로 끝내지 않고 다음 unique/upsert를 함께 사용한다.

- `story_cluster_posts.raw_post_id` unique
- AI evaluation pair + classifier version + input hash unique
- `content_candidates(story_cluster_id, ranking_date, scoring_config_id)` unique
- cluster signature와 aggregate 갱신의 atomic membership RPC

## 15. Supabase 보안 경계

- 기존 모든 public table RLS와 client role 권한 차단을 유지한다.
- 신규 public `score_version`/status 필드에도 동일한 service-role write
  경계를 적용한다.
- `app_private` audit/lock table은 schema usage를 service_role만 가지며,
  defense-in-depth로 RLS를 활성화한다.
- 신규 RPC는 SECURITY INVOKER, empty search_path, service_role EXECUTE만
  사용한다.
- OpenAI key, Supabase secret key, Meta token과 raw upstream 오류는 log/API에
  남기지 않는다.
- baseline view/function이 필요하면 security-invoker 또는 private schema를
  사용한다.

## 16. 제안 schema 변경과 YAGNI 판단

이번 구현에 필요한 최소 변경은 다음 네 가지다.

1. `story_clusters.signature_json`, `signature_version`: aggregated
   signature를 재실행 간 보존한다.
2. `content_candidates.score_version`, `korea_coverage_status`: score
   version과 Korea uncertainty를 조회 contract에 명시한다.
3. `app_private.story_cluster_evaluations`와
   `app_private.intelligence_run_lock`: AI audit/manual review와
   concurrent run lease를 가능하게 한다.
   evaluation unique key에는 classifier_version
   (model + prompt_version + dictionary_version)을 포함한다.
4. STORY_INTELLIGENCE_LEASE_SECONDS,
   STORY_INTELLIGENCE_HEARTBEAT_SECONDS: lease duration/heartbeat를
   runtime config로 분리한다.

baseline 전용 table, score history table, public AI table, 별도 player registry는
이번 milestone에 추가하지 않는다. baseline은 기존 snapshots 기반 SQL
function/view로 계산하고, player registry는 versioned dictionary로 시작한다.

## 17. 테스트와 smoke test

### Unit

- similarity 경계 `0.40/0.85`
- AI confidence 경계 `0.90`
- cross-language normalization
- outperformance/velocity/acceleration curve
- baseline fallback과 n=5/n=50 confidence 차이
- Korean Saturation의 KR 0/1/다수 post
- missing followers/baseline/snapshots
- KR freshness/completeness gate
- Korea uncertainty와 FIRST_MOVER false
- MUST_COVER, source reliability/diversity

### Cluster

- 같은 영어 story
- 다른 영어 story
- 영어+한국어 동일 story
- 같은 기자를 3개 계정이 재게시
- 같은 player지만 다른 event
- 같은 match지만 다른 event
- aggregate signature가 representative 하나보다 정확한지
- false merge와 false split

### AI

- high/low deterministic 구간에서 OpenAI 미호출
- ambiguity 구간에서만 호출
- feature flag off
- timeout/5xx/malformed/low-confidence
- audit model/prompt/hash/result 저장
- 동일 input 재실행 시 duplicate evaluation 방지

### DB/security

- story relationship, score version, status constraint
- score_inputs JSON contract
- ranking uniqueness
- private table RLS와 RPC EXECUTE
- lease acquire/renew/expiry와 겹친 run 거부
- 기존 전체 pgTAP와 DB lint

### 실제 데이터

M3 수집 데이터의 최근 24시간 게시물로 cluster와 TOP 5를 생성한다. 각 결과에
cluster title, member posts, GLOBAL/KR account, score breakdown, confidence,
flags, Korea coverage status를 출력한다. raw payload, token, secret은 출력하지
않는다. 사람이 최소 몇 개 cluster를 확인하고 false merge/split 발견 시
threshold 또는 dictionary를 수정한 후 재검증한다.

## 18. 완료 조건

M4 완료는 다음을 모두 만족해야 한다.

- cross-language cluster와 aggregate signature
- deterministic score 100점과 별도 Data Confidence
- Korea uncertainty 및 KR observation gate
- FIRST_MOVER/MUST_COVER
- source registry 기반 reliability/diversity
- score_inputs와 AI audit 재현성
- manual review 및 잘못된 membership 수정
- concurrent run lease와 모든 멱등성 제약
- unit/cluster/pgTAP/Deno/DB lint/n8n 검증
- M3 실제 데이터 TOP 5 smoke 및 human sanity check

이 문서는 설계 단계의 산출물이며, 승인 후 별도의 implementation plan을
작성한다. 이 문서만으로는 migration, Edge Function, n8n workflow를 생성하지
않는다.
