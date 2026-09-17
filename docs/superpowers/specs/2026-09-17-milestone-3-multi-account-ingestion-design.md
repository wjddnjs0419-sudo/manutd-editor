# Milestone 3 다계정 수집·메트릭 갱신·미디어 저장 설계

## 1. 목적

Milestone 2의 단일 계정 Instagram 수집 vertical slice를 다음 운영 단위로 확장한다.

- `source_accounts.active = true`인 seed 계정을 다계정으로 수집한다.
- 한 계정의 실패가 다른 계정의 수집과 커밋을 막지 않게 한다.
- 기존 게시물의 최신 원본 필드와 메트릭을 갱신한다.
- 게시물 나이에 따른 cadence로 metric snapshot 시계열을 만든다.
- IMAGE, CAROUSEL_ALBUM, REELS의 분석용 자산을 private Supabase Storage에 저장한다.
- n8n은 schedule과 호출 결과 확인만 담당한다.

Story clustering, Priority Score 실행, Notion, OpenAI 분석, Creative Brief, Telegram 운영 UX는 범위에 포함하지 않는다.

## 2. 설계 원칙

1. 수집 대상의 기준은 DB의 active source account이며 코드나 n8n에 계정 목록을 중복 보관하지 않는다.
2. 계정 하나가 하나의 core transaction 경계다.
3. raw post와 metric은 core data이고 media caching은 보조 작업이다.
4. n8n에는 business logic을 넣지 않는다.
5. Meta token, Supabase secret key, 전체 Meta 응답과 원문 오류는 외부 응답이나 로그에 노출하지 않는다.
6. weighted engagement는 저장하지 않고 활성 `scoring_configs`의 `comment_multiplier`로 계산한다.
7. 관측성 요구가 실제로 커지기 전에는 run-log나 quarantine 테이블을 추가하지 않는다.

## 3. 검토한 대안

### 3.1 단일 endpoint와 단일 workflow — 채택

한 번의 Business Discovery 응답으로 게시물 upsert와 due metric snapshot 생성을 함께 수행한다. 신규 media asset은 core transaction이 끝난 뒤 별도 경계에서 저장한다.

장점은 Meta 요청 중복이 없고, n8n이 단순하며, 기존 Milestone 2 구조를 가장 적게 변경한다는 점이다. 단점은 다계정 수집과 일부 media caching이 한 함수 실행 안에 있으므로 실행시간 예산이 필요하다는 점이다.

### 3.2 collection과 metric-refresh endpoint 분리 — 보류

두 기능의 운영 cadence를 독립적으로 바꿀 수 있지만 둘 다 Business Discovery를 호출하면 같은 계정을 중복 조회한다. API quota 실측 근거가 없는 현재는 분리하지 않는다. 내부 모듈 경계는 추후 endpoint 분리가 가능하도록 유지한다.

### 3.3 n8n 계정별 fan-out — 기각

계정 목록, 반복, 실패 분류가 n8n으로 이동해 business logic과 상태가 이중화된다. n8n은 schedule과 Edge Function 호출만 담당한다.

## 4. 전체 아키텍처

```text
n8n Schedule Trigger
  -> POST /functions/v1/collect-instagram
  -> invoke secret 검증
  -> active source_accounts 조회
  -> bounded account worker pool
       -> Meta Business Discovery
       -> account batch 정규화
       -> account 단위 ingest RPC
            -> source_accounts probe 상태 갱신
            -> raw_posts upsert
            -> due metric snapshot insert
       -> core commit 후 media cache
  -> 계정별 결과와 전체 summary 반환
```

기존 `index -> collector -> meta-client -> normalizer -> repository` 경계를 유지하면서 다음 책임을 추가한다.

- `orchestrator`: 대상 계정 조회, bounded concurrency, 계정별 실패 격리, summary 집계
- `metric-cadence`: 게시물 나이와 마지막 snapshot을 기준으로 due 여부 계산
- `media-storage`: 원본 다운로드, 제한 검증, private Storage upload
- `asset-repository`: media asset 준비 및 저장 결과 기록

각 계정의 Meta fetch, 정규화, core RPC는 독립된 `try/catch` 경계에서 실행한다.

## 5. 수집 대상과 API

외부 API는 하나를 유지한다.

```text
POST /functions/v1/collect-instagram
```

body를 생략하면 모든 active source account를 처리한다. 제한된 smoke test를 위해 다음 입력만 허용한다.

```json
{
  "source_account_ids": ["uuid", "uuid"]
}
```

- caller는 username을 전달할 수 없다.
- 지정 ID도 DB에서 active인지 다시 확인한다.
- 존재하지 않거나 inactive인 ID는 Meta 호출 전에 거부한다.
- 기본 실행 대상은 seed의 active 계정이며 별도 하드코딩 목록을 만들지 않는다.

응답은 일부 계정 실패를 포함해 실행 자체가 완료되면 HTTP 200을 사용한다.

```json
{
  "request_id": "uuid",
  "accounts_requested": 10,
  "accounts_success": 9,
  "accounts_failed": 1,
  "posts_created": 34,
  "posts_updated": 21,
  "snapshots_created": 18,
  "assets_stored": 12,
  "assets_failed": 2,
  "accounts": [
    {
      "source_account_id": "uuid",
      "status": "success",
      "posts_created": 3,
      "posts_updated": 4,
      "snapshots_created": 2,
      "assets_failed": 1
    },
    {
      "source_account_id": "uuid",
      "status": "failed",
      "error_category": "permission"
    }
  ]
}
```

HTTP 상태는 다음과 같이 제한한다.

- `200`: 실행 완료. 계정별 실패가 포함될 수 있다.
- `400`: body 또는 source account ID가 잘못됐다.
- `401`: invoke secret 인증이 실패했다.
- `500`: 구성 오류나 active account 목록 조회 실패처럼 실행을 시작할 수 없다.

## 6. 다계정 orchestration과 실행시간 예산

계정 worker pool의 초기 concurrency는 2다. 환경 설정으로 조절할 수 있지만 최대 3으로 제한한다. 무제한 `Promise.all`은 사용하지 않는다.

초기 실행 예산은 다음과 같다.

- Meta 계정별 총 시도: 최대 3회
- 계정별 시간 예산: 20초
- 전체 core ingest 예산: 약 100초
- media download concurrency: 2
- media caching은 남은 실행시간과 실행당 asset 상한 안에서만 수행

전체 예산 때문에 시작하지 못한 계정은 `run_budget_exhausted`로 결과에 포함한다. 해당 계정의 `api_supported`는 변경하지 않으며 다음 schedule에서 다시 처리한다.

Meta 429, 5xx, network error에는 제한된 exponential backoff와 jitter를 사용한다. 유효한 `Retry-After`는 남은 계정 예산 안에서 우선 적용한다. 인증, 권한, 잘못된 요청, validation 실패는 재시도하지 않는다.

## 7. 계정 단위 실패 격리

격리 단위는 계정이다.

```text
Meta fetch -> complete account normalization -> account ingest transaction
```

한 media item의 validation 실패는 해당 계정 batch를 실패시킨다. 다른 계정은 계속 실행한다. account batch 내부의 부분 저장이나 malformed item skip은 허용하지 않는다. rejected-item 또는 quarantine 테이블은 이번 범위에서 만들지 않는다.

외부 응답과 `source_accounts.probe_error`에는 다음 안전한 category만 사용한다.

- `unsupported_account`
- `permission`
- `rate_limited`
- `temporary_upstream`
- `invalid_payload`
- `database`
- `run_budget_exhausted`
- `internal`

상태 변경 규칙은 다음과 같다.

- 성공: `api_supported = true`, `last_probe_at` 갱신, `probe_error = null`
- 계정별 unsupported 또는 permission: `api_supported = false`
- 429, 5xx, network: 기존 `api_supported` 유지
- payload validation 실패: 기존 `api_supported` 유지
- global credential 오류: 각 계정을 unsupported로 표시하지 않음

Meta 오류에서는 HTTP status와 허용된 code, subcode, type만 분류에 사용한다. 원문 message, response body, 요청 URL, access token은 저장하거나 로그로 출력하지 않는다.

실패 상태 기록은 별도 service-role 전용 RPC로 수행한다. 실패 기록 RPC가 실패하더라도 다른 계정의 수집은 계속한다.

## 8. raw post upsert와 계정 transaction

기존 unique key를 유지한다.

```text
(source_account_id, external_post_id)
```

재수집 시 다음 값은 최신 응답으로 갱신한다.

- caption
- permalink
- like_count
- comments_count
- view_count
- followers_count_at_collection
- raw_payload
- collected_at

`created_at`, `published_at`, 최초 snapshot은 재수집으로 덮어쓰지 않는다. `published_at` 불일치는 payload 오류로 처리해 기존 최초 게시 시점을 보호한다.

RPC는 username 대신 DB에서 조회한 `source_account_id`를 입력으로 받는다. RPC가 account row를 `FOR UPDATE`로 잠그고 active 상태를 재검증한다. HTTP endpoint의 단일 계정 제한 실행도 같은 orchestration과 RPC를 사용한다.

## 9. Metric refresh cadence

초기 cadence는 다음과 같다.

| 게시물 나이 | 최소 snapshot 간격 |
|---|---:|
| 0–2시간 | 30분 |
| 2–6시간 | 60분 |
| 6–12시간 | 2시간 |
| 12–24시간 | 4시간 |
| 24시간 이후 | 중단 |

n8n은 30분마다 collector를 호출한다. Business Discovery에서 받은 각 게시물의 최신 metric을 raw post에는 항상 반영하고, RPC가 마지막 snapshot과 cadence를 비교해 due인 경우에만 새 snapshot을 만든다.

snapshot에는 다음 원본값만 저장한다.

- followers_count
- like_count
- comments_count
- view_count nullable
- captured_at
- post_age_minutes

weighted engagement는 저장하지 않는다. 계산 시 활성 `scoring_configs.config.comment_multiplier`와 기존 `app_private.calculate_weighted_engagement`를 사용한다.

## 10. Snapshot 멱등성

`post_metric_snapshots`에 다음 컬럼을 추가한다.

```text
capture_bucket_start timestamptz not null
```

bucket은 Edge Function이나 n8n이 임의로 전달하지 않고 RPC가 관측 시각을 기준으로 계산한다.

```text
date_bin('30 minutes', captured_at, fixed UTC origin)
```

다음 unique constraint를 추가한다.

```text
unique (raw_post_id, capture_bucket_start)
```

기존 snapshot은 해당 규칙으로 backfill한 후 `NOT NULL`과 unique constraint를 적용한다. 현재 데이터는 게시물당 최초 snapshot 하나이므로 backfill collision이 없어야 하며 migration test로 확인한다.

멱등성은 두 단계로 보장한다.

1. account row lock 안에서 마지막 snapshot을 확인해 cadence가 지나지 않았으면 insert하지 않는다.
2. bucket unique constraint로 동시 실행과 retry race를 차단한다.

`captured_at`은 실제 관측 시각이고 bucket은 deduplication key다. 최초 snapshot은 가장 이른 `captured_at` 행으로 계속 보존한다.

## 11. Media asset 정규화

정규화된 post는 core data와 별도로 asset descriptor 배열을 갖는다.

- IMAGE: `asset_type = IMAGE`, parent `media_url`
- CAROUSEL_ALBUM: child 순서를 0부터 보존하고 `asset_type = CAROUSEL_CHILD`
- REELS: `asset_type = THUMBNAIL`, `thumbnail_url` 우선

Reel video binary는 이번 milestone에서 다운로드하지 않는다. video metadata와 원본 payload는 raw post에 남는다. JPEG, WebP 등 upstream format을 그대로 저장하고 PNG로 변환하지 않는다.

Meta가 제공하지 않거나 다운로드 과정에서 확정할 수 없는 width, height, sha256는 `NULL`로 둔다. MIME type은 HTTP `Content-Type`의 허용된 image type만 수용한다.

## 12. Storage와 transaction boundary

core ingest와 media caching은 분리한다.

```text
1. account ingest RPC commit
2. media descriptor 준비 또는 upsert
3. remote asset download
4. private Storage upload
5. media_assets에 성공 결과 기록
```

Storage bucket은 private이며 public read policy를 만들지 않는다. 서버의 Supabase secret key로만 upload한다.

Storage path는 재실행에 안전한 결정적 경로를 사용한다.

```text
instagram/{source_account_id}/{external_post_id}/{external_media_id}.{ext}
```

업로드는 `upsert = false`로 수행한다. 동일 path가 이미 존재하면 같은 asset의 이전 성공으로 취급하고 DB linkage를 복구한다. `storage_path`가 이미 있는 asset은 다시 다운로드하지 않는다.

성공한 asset은 다음을 기록한다.

- original_media_url
- storage_path
- mime_type
- fetched_at
- `retention_until = fetched_at + 30 days`

다운로드나 upload가 실패하면 core post와 snapshot은 유지한다. asset metadata는 original URL과 함께 남길 수 있지만 `storage_path`와 `fetched_at`은 성공 시에만 채운다. 다음 schedule에서 `storage_path IS NULL`인 asset을 재시도한다.

Storage upload 성공 뒤 DB 기록이 실패한 경우에도 결정적 path 덕분에 다음 실행에서 object duplicate를 동일 asset으로 판정하고 linkage를 복구할 수 있다.

30일 retention 자동 삭제 job은 이번 범위에 포함하지 않는다.

## 13. 스키마 변경 범위

새 테이블은 추가하지 않는다.

필요한 변경은 다음과 같다.

1. `post_metric_snapshots.capture_bucket_start` 추가와 backfill
2. `(raw_post_id, capture_bucket_start)` unique constraint
3. hardcoded username을 제거한 account-ID 기반 ingest RPC
4. safe probe failure 기록 RPC
5. media asset batch prepare/finalize 또는 동등한 service-role 전용 RPC
6. private Storage bucket 설정

모든 public RPC는 `SECURITY INVOKER`를 유지하고 `PUBLIC`, `anon`, `authenticated`의 실행 권한을 제거하며 `service_role`에만 허용한다. 기존 테이블 RLS와 client role 권한 차단을 유지한다.

별도 run-log 테이블은 추가하지 않는다. 계정의 마지막 probe 상태, Edge Function 구조화 로그, n8n execution history로 초기 운영 관측성을 충족한다.

## 14. n8n workflow

초기 workflow는 하나다.

```text
Schedule Trigger (30분, Asia/Seoul)
  -> HTTP Request
       POST /functions/v1/collect-instagram
       Authorization: Bearer <COLLECTOR_INVOKE_SECRET>
       Response: JSON
```

- workflow를 publish해야 schedule이 작동한다.
- `COLLECTOR_INVOKE_SECRET`은 n8n Header Auth credential로 관리한다.
- Meta token과 Supabase secret key는 n8n에 저장하지 않는다.
- Code Node를 사용하지 않는다.
- 계정 일부 실패는 HTTP 200 response의 summary와 account result에서 확인한다.
- 기존 Telegram/OpenAI workflow는 수정하거나 결합하지 않는다.
- version-controlled workflow export에는 secret 값이나 credential payload를 넣지 않는다.

## 15. 관측성과 로그

각 실행은 request ID를 갖고 다음 수준의 구조화 로그만 남긴다.

```text
event=collector_run_started accounts_requested=10
event=account_succeeded source_account_id=... posts_created=3 posts_updated=4 snapshots_created=2 duration_ms=...
event=account_failed source_account_id=... error_category=permission duration_ms=...
event=collector_run_completed accounts_success=9 accounts_failed=1 duration_ms=...
```

username은 운영 편의를 위해 허용할 수 있지만 secret, access token, 전체 Meta payload, raw upstream error message, signed URL은 로그에 남기지 않는다.

`accounts_success`는 core ingest 성공 계정 수다. media 일부 실패는 해당 계정의 `assets_failed`에 반영하지만 core 성공을 실패로 바꾸지 않는다.

## 16. 테스트 전략

### 16.1 Deno unit tests

- active account 조회와 ID scope 검증
- bounded concurrency가 설정값을 초과하지 않음
- 한 계정 failure 뒤 다른 계정의 성공
- account result와 전체 summary 합산
- Meta 429, 5xx, network retry
- permanent Meta 오류 비재시도
- Retry-After와 계정 실행시간 예산
- IMAGE asset normalization
- CAROUSEL child 순서와 ID
- REELS thumbnail과 nullable view count
- metric cadence 경계값
- snapshot bucket 계산
- media download/upload 실패가 core result를 변경하지 않음
- deterministic Storage path와 duplicate recovery
- secret과 원문 오류 redaction

### 16.2 pgTAP

- 여러 source account의 독립 ingest
- repeated post upsert와 기존 post 갱신
- 최초 snapshot 보존
- cadence 미도달 시 snapshot 미생성
- 같은 bucket duplicate 방지
- 다음 due window snapshot 생성
- 실패 계정 probe 상태
- transient 실패 시 `api_supported` 보존
- media asset unique와 constraint
- account transaction rollback
- RPC 권한, RLS, client role 차단 회귀

### 16.3 Storage integration

- private bucket 생성
- 실제 image upload
- 동일 path 재실행 안전성
- `media_assets.storage_path` 연결
- download 또는 upload 실패 뒤 raw post 유지
- public URL 접근 불가

### 16.4 실제 smoke test

먼저 다음 3개 계정 ID로 제한 실행한다.

- utdreport
- utddistrict
- manunitedzone

계정 ID, followers, posts, likes, comments, media type, Reel view count와 DB 반영을 검증한다. 같은 bucket에서 즉시 재실행해 raw post, snapshot, media asset 중복이 없는지 확인한다.

그 다음 전체 active source account를 실행한다. unsupported 계정이 있어도 다른 계정의 commit이 유지되는지 확인한다. 마지막으로 n8n manual execution과 published schedule invocation을 검증한다.

실제 secret 값은 명령 출력, 로그, 테스트 fixture, 문서에 남기지 않는다.

## 17. 구현 순서

1. snapshot cadence와 deduplication pgTAP을 먼저 실패시킨다.
2. migration과 account-ID 기반 RPC를 최소 구현한다.
3. 다계정 orchestrator와 bounded concurrency unit test를 먼저 실패시킨다.
4. active account repository와 worker pool을 구현한다.
5. failure taxonomy와 probe failure 경로를 구현한다.
6. media descriptor normalization test를 먼저 실패시킨다.
7. Storage adapter와 auxiliary asset transaction을 구현한다.
8. handler request/response와 aggregate logging을 확장한다.
9. n8n workflow export와 운영 문서를 추가한다.
10. 전체 Deno, pgTAP, format, lint, type-check, DB lint를 실행한다.
11. 로컬 Storage integration을 실행한다.
12. 원격 migration 적용과 DB lint 후 3계정 smoke test를 실행한다.
13. 전체 active 계정과 n8n schedule을 검증한다.

모든 구현 단계는 failing test, 최소 구현, green, 리팩터링 순서로 진행한다.

## 18. Milestone 2 회귀 보호

다음 동작은 그대로 유지한다.

- 단일 계정 제한 실행
- account batch transactional ingest
- `(source_account_id, external_post_id)` 기반 멱등 upsert
- 최초 metric snapshot 보호
- collector invoke secret 인증
- Meta transient retry와 Retry-After
- DB ambiguous response retry
- IMAGE, CAROUSEL_ALBUM, REELS 타입 검증
- nullable Reel view count
- secret 및 원문 오류 비노출

변경되는 부분은 다음과 같다.

- `utdreport` 하드코딩 제거
- 단일 collector 앞에 다계정 orchestrator 추가
- RPC 식별자를 username에서 source account ID로 변경
- 최초 snapshot 전용 로직을 cadence 기반 snapshot 로직으로 확장
- normalizer에 media asset descriptor 추가
- handler 응답을 다계정 aggregate 형식으로 변경
- core ingest 이후 독립 Storage 경계 추가

## 19. 완료 조건

- active source account 다계정 수집
- 계정 단위 failure isolation
- raw post 중복 방지와 기존 row 갱신
- 최초 snapshot 보존과 cadence 기반 반복 snapshot
- 같은 bucket snapshot 중복 방지
- IMAGE, CAROUSEL child, REELS thumbnail 처리
- nullable Reel view count
- private Storage와 media asset linkage
- Storage 실패 시 core ingest 보존
- safe structured logging
- 단일 n8n schedule workflow
- workflow 재실행 안전성
- 전체 Deno와 pgTAP 통과
- format, lint, type-check, DB lint 통과
- 3계정 및 전체 active 계정 smoke test
- n8n published schedule 호출 성공

## 20. 참고 문서

- Supabase Edge Function Storage 연동: https://supabase.com/docs/guides/functions/storage-caching
- Supabase Storage access control: https://supabase.com/docs/guides/storage/security/access-control
- Supabase private bucket serving: https://supabase.com/docs/guides/storage/serving/downloads
- Supabase Edge Function 실행 제한: https://supabase.com/docs/guides/troubleshooting/edge-function-wall-clock-time-limit-reached-Nk38bW
- n8n Schedule Trigger: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/
- n8n HTTP Request: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/
