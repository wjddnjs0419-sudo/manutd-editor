# MU Content Intelligence System

맨체스터 유나이티드 관련 Instagram 콘텐츠를 수집·분석하고, 객관적인 우선순위 점수와 실행 가능한 콘텐츠 브리프를 만드는 시스템입니다.

현재 구현 범위는 **Milestone 3 수집 파이프라인, Milestone 4 Content Intelligence, Milestone 4.5 Notion Editorial Sync, Milestone 5 Grounded Creative Generation**입니다. Edge Function은 DB의 active Instagram 계정을 읽어 concurrency 2로 격리 수집하고, 게시물 나이에 따른 cadence와 30분 bucket으로 메트릭 스냅숏을 갱신합니다. 이어서 intelligence Edge Function이 최근 게시물을 story cluster로 묶고 결정론적인 Priority Score·Data Confidence·FIRST_MOVER/MUST_COVER 결과를 생성합니다. M5는 M4 canonical evidence snapshot만 사용해 deterministic-first content mode를 분류하고, OpenAI Responses structured output을 검증한 뒤 append-only Creative Brief revision을 저장합니다. Notion sync Edge Function은 Supabase 후보를 `📡 Daily Intelligence` 데이터베이스에 editorial projection으로 upsert하며, Supabase가 canonical source이고 Notion의 human-owned 편집 필드는 보존합니다.

## 핵심 원칙

- Supabase가 백엔드 원본 데이터의 기준(source of truth)입니다.
- Notion은 이후 마일스톤에서 사람이 사용하는 편집 워크스페이스로 연결합니다.
- Priority Score는 측정 데이터와 버전이 지정된 설정만으로 결정합니다.
- AI는 분류·요약·편집 제안을 담당하지만 Priority Score 숫자를 변경하지 않습니다.
- `weighted_engagement`는 저장하지 않습니다. 선택된 `scoring_configs`의 `comment_multiplier`를 사용해 계산합니다.
- 팔로워 수 `0`과 `NULL`은 유효한 수집 상태입니다. 점수 계산 시 분모로 사용하지 않고 데이터 신뢰도에 반영해야 합니다.

## 데이터 모델

| 테이블 | 책임 |
|---|---|
| `source_accounts` | 모니터링할 글로벌·한국 Instagram 계정과 API 기능 상태 |
| `raw_posts` | Meta API에서 수집한 원본 게시물 및 원본 JSON |
| `media_assets` | 이미지·캐러셀·영상·썸네일 메타데이터 |
| `post_metric_snapshots` | 좋아요·댓글·조회수의 시간대별 스냅숏 |
| `story_clusters` | 동일 사건을 다룬 게시물의 대표 스토리 |
| `story_cluster_posts` | 스토리와 게시물의 연결 |
| `information_sources` | Manchester United, 기자, 매체 등 실제 정보 출처 엔티티 |
| `story_cluster_sources` | 스토리와 독립 정보 출처의 연결 및 근거 |
| `scoring_configs` | 버전별 점수 가중치, 구간, 플래그 조건 |
| `content_candidates` | 구성요소별 점수와 자동 합산된 Priority Score |
| `creative_briefs` | 슬라이드·디자인·캡션 실행안 |
| `published_posts` | 브리프와 실제 발행 Instagram 게시물의 연결 |
| `performance_metrics` | 발행 콘텐츠의 성과 스냅숏 |
| `app_private.notion_sync_state` | `story_cluster_id + ranking_date` 기준 Notion page identity·hash·lifecycle 상태 |

`content_candidates.priority_score`는 열 개 구성요소의 합으로 생성되는 Postgres generated column입니다. 계산 당시의 활성 계정, 기준선, 원시 비율과 결측 상태는 `score_inputs`에 보존해야 합니다.

## 실제 출처 엔티티

초기 레지스트리는 등급 이름이 아닌 실제 엔티티를 저장합니다.

- Manchester United — 10
- Fabrizio Romano — 9
- BBC Sport — 8
- Sky Sports — 8
- The Athletic — 8

AI는 게시물에서 이 엔티티를 추출할 수 있지만, 숫자 신뢰도는 `information_sources.reliability_score`만 사용합니다.

## 보안 모델

- 모든 애플리케이션 테이블에 RLS가 활성화되어 있습니다.
- Milestone 1에서는 `anon`, `authenticated` 역할의 테이블 권한을 모두 제거했습니다.
- 서버 전용 `service_role`만 CRUD를 수행합니다.
- `SUPABASE_SECRET_KEYS`의 secret key는 브라우저나 공개 클라이언트에 절대 노출하지 않습니다.
- 실제 키와 Meta 토큰은 커밋하지 않습니다. `.env.example`에는 빈 변수명만 제공합니다.

## Milestone 3 Core 수집 경로

```text
n8n Schedule (후속 연결)
  → collect-instagram Edge Function (active 계정 조회, concurrency 2)
  → Meta Business Discovery API
  → ingest_instagram_account_batch RPC
  → source_accounts + raw_posts + post_metric_snapshots
  → prepare media assets → private Storage → finalize media assets
```

body 없이 호출하면 DB의 모든 active 계정을 수집합니다. 필요하면 caller가 `source_account_ids` UUID 배열로 active 계정의 subset만 제한할 수 있지만 username은 지정할 수 없습니다. 한 계정의 Meta·validation·DB 실패는 다른 계정 commit을 막지 않으며, aggregate 응답은 계정별 성공/실패와 안전한 오류 category를 반환합니다. `IMAGE`, `CAROUSEL_ALBUM`, `VIDEO` + `REELS`를 처리하고, Meta가 Reel 조회수를 제공하지 않으면 `view_count`를 `NULL`로 보존합니다.

Meta 응답 전체가 검증된 후에만 계정별 RPC를 호출합니다. RPC는 계정 행을 잠그고 계정 업데이트, `raw_posts` upsert, cadence가 도래한 snapshot 생성을 한 트랜잭션으로 수행합니다. `(source_account_id, external_post_id)`가 게시물 중복을 막고 `(raw_post_id, capture_bucket_start)`가 같은 30분 bucket의 snapshot 중복을 막습니다. refresh cadence는 게시 후 0~2시간 30분, 2~6시간 1시간, 6~12시간 2시간, 12~24시간 4시간이며 24시간 이후에는 중단합니다.

RPC는 `SECURITY INVOKER`이며 `PUBLIC`, `anon`, `authenticated`의 실행 권한을 제거하고 `service_role`에만 허용합니다. Supabase secret key는 PostgREST에서 이 DB 역할로 매핑되지만 외부 caller에는 전달하지 않습니다. Edge Function은 `verify_jwt = false`로 gateway JWT 검사를 사용하지 않는 대신 `Authorization: Bearer <COLLECTOR_INVOKE_SECRET>`을 함수 내부에서 timing-safe 방식으로 검증합니다.

malformed/unsupported media 하나는 해당 계정 batch 전체를 실패시키는 보수적 경계를 유지합니다. 다른 계정 worker는 계속 실행되며 별도의 quarantine 원문 저장은 하지 않습니다.

media cache는 `instagram-analysis` private bucket만 사용합니다. 원본 이미지 형식을 변환하지 않고 `image/jpeg`, `image/png`, `image/webp`, `image/gif`만 asset당 최대 20MiB로 저장합니다. Storage path는 계정·게시물·media ID로 결정되며 duplicate upload는 안전한 재시도로 처리합니다. Storage 실패는 완료된 raw post와 metric transaction을 롤백하지 않습니다. 성공한 asset만 `storage_path`, MIME, fetch 시각과 30일 retention metadata를 기록하며 자동 삭제 job은 아직 없습니다.

### 환경 변수

실제 값은 로컬의 무시된 env 파일이나 Supabase secrets에만 둡니다.

## Milestone 6 Telegram Editorial Agent

n8n HTTP Request 노드를 UI에서 직접 설정할 때 Raw Body의 Expression에는
`{{ JSON.stringify($json) }}`를 입력합니다. 앞에 `=`를 붙이지 않습니다.
워크플로 JSON export의 `={{ ... }}`는 저장 형식이며, UI에 그대로 붙이면
실제 요청이 `={"update_id":...}`로 시작할 수 있습니다. 평가 결과가 `{`로 시작하는지 확인합니다.

M6는 Supabase를 canonical state로 유지하면서 Telegram을 운영 콘솔로 사용하는 계층입니다. API-Football 팀 ID 33(Manchester United) fixture를 match-day 상태에 따라 quota-aware cadence로 동기화하고, 매일 09:00 Asia/Seoul에 fixture 강제 갱신 후 상위 3개 후보의 frozen briefing을 보냅니다. private Storage thumbnail은 10분 signed URL로 전송하고, 사람 검증용 Instagram permalink는 canonical 원문 링크로 함께 표시합니다.

자연어 대화는 read-only입니다. 상태 변경은 `/hook`, `/slide`, `/caption`, `/select` 같은 명시적 slash command만 수행하며, LOCKED/APPROVED 상태의 변경은 10분 보호 확인과 최신 revision 재검증을 거칩니다. 최근 raw Telegram 메시지 12개를 컨텍스트에 사용하고, 20개 시점에 오래된 부분만 요약합니다. 과거 검색은 `지난 경기`, `지난주`, `last match`처럼 명시적인 history 요청에서만 structured-first로 최대 5건을 조회합니다.

주요 명령:

`/today`, `/open <1..3|uuid|alert>`, `/brief`, `/hook <1..3>`, `/slide <1..7> <지시>`, `/caption <지시>`, `/select`, `/status`, `/back`, `/reset`, `/confirm`, `/cancel`, `/help`

n8n은 `fixture-sync → telegram-alerts`, 09:00 `telegram-morning-brief`, Telegram Trigger → `telegram-agent` 호출만 담당합니다. 점수·선택·메모리·명령·dedupe 규칙은 Edge Function과 Supabase에 있습니다. 모든 M6 workflow는 git에서 `active: false`이며 credential value를 포함하지 않습니다.

필수 로컬 설정은 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`이며, 실제 연동에는 `FOOTBALL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_AGENT_INVOKE_SECRET`, `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_OWNER_CHAT_ID`, `TELEGRAM_OWNER_THREAD_ID`, `OPENAI_API_KEY`가 필요합니다. 키 값은 커밋하지 않습니다.

로컬 검증:

```bash
supabase db reset --local
supabase test db
node scripts/validate-n8n-workflow.mjs n8n/workflows/fixture-sync-schedule.json
node scripts/validate-n8n-workflow.mjs n8n/workflows/telegram-morning-brief.json
node scripts/validate-n8n-workflow.mjs n8n/workflows/telegram-editorial-agent.json
./scripts/run-milestone-6-smoke.sh
```

M6 범위에는 Telegram 발행/삭제, Instagram 자동 게시, 실시간 scorebot, vector-RAG 인프라, 복잡한 multi-user RBAC, 광범위한 Notion administration이 포함되지 않습니다.

```text
COLLECTOR_INVOKE_SECRET
META_ACCESS_TOKEN
META_BUSINESS_ACCOUNT_ID
META_API_VERSION
COLLECTOR_CONCURRENCY=2
COLLECTOR_ACCOUNT_BUDGET_MS=20000
COLLECTOR_RUN_BUDGET_MS=100000
MEDIA_STORAGE_BUCKET=instagram-analysis
MEDIA_DOWNLOAD_CONCURRENCY=2
MEDIA_ASSETS_PER_RUN=20
MEDIA_MAX_BYTES=20971520
SUPABASE_URL
SUPABASE_SECRET_KEYS={"default":"<sb_secret_...>"}
```

hosted Edge Runtime에서는 `SUPABASE_SECRET_KEYS`가 자동 주입됩니다. 로컬/CI에서 단일 키를 쓰는 경우 `SUPABASE_SECRET_KEY`도 지원합니다. 이 opaque secret key는 JWT가 아니므로 내부 RPC 요청의 `apikey` 헤더에만 넣으며 `Authorization` 헤더에는 넣지 않습니다.

n8n에는 이후 `COLLECTOR_INVOKE_SECRET`만 전달하며 Supabase secret key는 전달하지 않습니다.

### Milestone 4.5 Notion Editorial Sync

Notion의 `📡 MU Intelligence Hub` 아래에 생성한 `📡 Daily Intelligence` database를
`NOTION_DAILY_INTELLIGENCE_DATABASE_ID`로 주입합니다. database schema에는 다음 두
종류의 필드가 있습니다.

- 시스템 projection: Title, Sync Identity, Candidate/Cluster ID, Ranking Date, Rank,
  Priority Score, Data Confidence, FIRST_MOVER/MUST_COVER, Korea/Global coverage,
  score components, First Seen, Sync Lifecycle, Supabase Updated At, Last Synced At
- 사람 소유 필드: Editorial Status, Selected, Editor Headline, Editor Notes

sync identity는 `story_cluster_id:ranking_date`이며, 오늘의 `rank <= 10` 또는
`FIRST_MOVER`/`MUST_COVER` 후보만 `CURRENT`로 투영합니다. 기존 identity가 오늘
선정에서 빠지면 `DROPPED`, 이전 ranking date는 `EXPIRED`로 표시하고 Notion page는
삭제하지 않습니다. 업데이트 payload에는 사람 소유 필드를 넣지 않습니다.

로컬 함수는 다음처럼 실행합니다.

```bash
supabase functions serve sync-notion-intelligence --no-verify-jwt \
  --env-file supabase/functions/.env.local
```

환경에는 `NOTION_TOKEN`,
`NOTION_DAILY_INTELLIGENCE_DATABASE_ID`, `NOTION_CONTENT_PIPELINE_DATABASE_ID`, `OPENAI_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SECRET_KEY`/`SUPABASE_SECRET_KEYS`, `COLLECTOR_INVOKE_SECRET`을 설정합니다.
Notion token과 database ID는 workflow export나 git에 넣지 않습니다.

### Milestone 5 Grounded Creative Generation

M5는 `creative-generation`, `creative-generation-priority`, `creative-generation-selected-poll` server-only Edge Function으로 구성됩니다. 우선순위 후보와 Daily Intelligence의 `Selected` 후보가 같은 orchestrator를 통과하며, 성공한 브리프만 Content Pipeline에 투영됩니다. `EDITABLE` 페이지는 시스템 속성과 본문 블록을 갱신하고, `LOCKED`/`APPROVED` 페이지는 새 페이지로 만들어 사람의 편집 내용을 보존합니다.

로컬 구조·grounding·Notion 분기 스모크는 다음으로 실행합니다.

```bash
./scripts/run-milestone-5-smoke.sh
```

이 runner는 local DB assertion과 fixture integration test를 수행하며, 기본적으로 `supabase/functions/.env.local`을 자동 로드합니다. `OPENAI_API_KEY`가 없으면 외부 OpenAI 호출을 명시적으로 건너뜁니다. 실제 OpenAI/Notion smoke는 배포된 함수와 해당 credential 및 database ID가 준비된 환경에서 별도로 실행해야 합니다.

### 로컬 함수 실행

```bash
supabase functions serve collect-instagram --env-file supabase/functions/.env.local

curl --request POST 'http://127.0.0.1:55321/functions/v1/collect-instagram' \
  --header 'Authorization: Bearer <COLLECTOR_INVOKE_SECRET>'

curl --request POST 'http://127.0.0.1:55321/functions/v1/collect-instagram' \
  --header 'Authorization: Bearer <COLLECTOR_INVOKE_SECRET>' \
  --header 'Content-Type: application/json' \
  --data '{"source_account_ids":["<ACTIVE_SOURCE_ACCOUNT_UUID>"]}'
```

토큰, secret key, 전체 upstream 오류 본문은 응답이나 구조화 로그에 남기지 않습니다.

## 로컬 개발

필수 도구:

- Docker Desktop
- Supabase CLI 2.117.0 이상
- Git

이 프로젝트는 다른 로컬 Supabase 프로젝트와의 충돌을 피하기 위해 `55320`~`55329` 포트를 사용합니다.

```bash
supabase start
supabase db reset --local
supabase seed buckets
supabase test db
supabase db lint --local --schema public,app_private --level warning
```

로컬 Studio는 `http://127.0.0.1:55323`에서 확인할 수 있습니다.

## Milestone 4 Content Intelligence 검증

로컬 함수 실행에는 `supabase/functions/.env.local`을 사용합니다. 다음 값은 로컬
환경에만 설정하며 문서·workflow export·smoke 결과에는 남기지 않습니다.

```text
SUPABASE_URL=http://127.0.0.1:55321
SUPABASE_SECRET_KEY=<local-service-role-secret>
COLLECTOR_INVOKE_SECRET=<local-invoke-secret>
STORY_CLUSTER_AI_ENABLED=false
```

DB reset 후 intelligence 함수를 별도 터미널에서 실행합니다.

```bash
supabase functions serve intelligence --no-verify-jwt --env-file supabase/functions/.env.local
```

전체 검증과 TOP 5 smoke는 다음 순서로 실행합니다. `LOCAL_SUPABASE_URL`과
`LOCAL_SUPABASE_SECRET_KEY`는 로컬 환경의 URL·service-role secret이며, runner는
함수 호출에 `COLLECTOR_INVOKE_SECRET`을 사용합니다.

```bash
supabase db reset --local
supabase seed buckets
supabase test db
supabase db lint --local --schema public,app_private --level warning
docker run --rm --add-host=host.docker.internal:host-gateway \
  --env SUPABASE_URL="$LOCAL_SUPABASE_URL" \
  --env SUPABASE_SECRET_KEY="$LOCAL_SUPABASE_SECRET_KEY" \
  -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test --allow-env --allow-net functions/tests
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
./scripts/run-milestone-4-smoke.sh --output /tmp/milestone-4-smoke.json
./scripts/run-milestone-4-5-smoke.sh --output /tmp/milestone-4-5-smoke.json
```

`run-milestone-4-smoke.sh`는 intelligence Edge Function을 한 번 호출한 뒤
최근 후보 중 TOP 5의 `title`, member username, GLOBAL/KR region count, score
components, confidence, flags, Korea status만 출력합니다. token, secret, raw
payload, upstream error 본문은 응답·로그·파일에 출력하지 않습니다. 후보가 없거나
검증 assertion이 실패하면 runner도 실패합니다.

## 원격 Supabase

연결 대상:

```text
Project ref: byymtttpwmllqvggnddm
Region: Northeast Asia (Seoul)
```

새 환경에서 연결할 때:

```bash
supabase login
supabase link --project-ref byymtttpwmllqvggnddm
supabase migration list --linked
```

원격 적용 전에는 반드시 로컬 리셋과 전체 테스트를 통과시켜야 합니다.

```bash
supabase db push --linked
supabase db lint --linked --schema public,app_private --level warning
```

## 테스트 범위

pgTAP 테스트는 다음을 검증합니다.

- 13개 핵심 테이블과 기본키
- 실제 출처 엔티티 모델
- `scoring_configs` 참조 관계
- 팔로워 `0`과 `NULL` 허용, 음수 거부
- 결정적 weighted engagement 계산
- 동시에 하나의 점수 설정만 활성화
- 출처 신뢰도와 계정 가중치 제약
- 전 테이블 RLS 및 클라이언트 역할 권한 차단
- 초기 계정·출처·점수 설정 seed
- service-role 전용 ingest RPC 권한과 `SECURITY INVOKER`
- 계정·게시물·cadence snapshot의 원자적 저장과 30분 bucket 멱등성
- DB active 계정 조회, account-ID ingest, 안전한 probe failure 기록
- concurrency 2, 계정 실패 격리, 계정별 timeout과 전체 run budget
- private bucket, MIME/20MiB 제한, deterministic path와 duplicate retry
- media prepare/upload/finalize 실패 격리와 30일 retention metadata
- IMAGE, CAROUSEL_ALBUM, REELS 정규화와 nullable Reel 조회수
- Meta/API 및 DB transient retry와 영구 오류 비재시도
- collector secret 인증과 오류 응답의 비밀값 비노출

Edge Function 테스트는 Deno 2.1.4 컨테이너로 실행할 수 있습니다.

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test functions/tests
```

## n8n 운영 흐름

`n8n/workflows/instagram-collector-schedule.json`은 `Asia/Seoul` 30분 Schedule에서
다음 invoke-only chain을 실행합니다.

```text
Schedule → collect-instagram → intelligence → sync-notion-intelligence
```

Collector와 Intelligence의 성공 경로가 보장되어야 다음 단계로 진행합니다.
Notion sync HTTP node만 `continueOnFail`/`neverError`를 사용하므로 Notion 장애가
collector·intelligence 결과를 실패로 바꾸지 않습니다. 모든 HTTP node는 기존
`Instagram Collector Invoke Secret` Header Auth credential reference만 사용하며,
workflow JSON에는 secret 값이 없습니다.

```bash
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
node --test scripts/validate-n8n-workflow.test.mjs
```
