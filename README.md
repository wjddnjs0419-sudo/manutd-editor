# MU Content Intelligence System

맨체스터 유나이티드 관련 Instagram 콘텐츠를 수집·분석하고, 객관적인 우선순위 점수와 실행 가능한 콘텐츠 브리프를 만드는 시스템입니다.

현재 구현 범위는 **Milestone 2: `@utdreport` Meta 수집 vertical slice**입니다. Supabase/Postgres 데이터 기반에 더해 Edge Function이 Meta Business Discovery 응답을 검증하고, 계정·원본 게시물·최초 메트릭 스냅숏을 원자적으로 저장합니다. 다계정 수집, n8n 스케줄링, 스토리 클러스터링, 점수 계산 워커, Notion 동기화는 아직 구현하지 않았습니다.

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
- `SUPABASE_SERVICE_ROLE_KEY`는 브라우저나 공개 클라이언트에 절대 노출하지 않습니다.
- 실제 키와 Meta 토큰은 커밋하지 않습니다. `.env.example`에는 빈 변수명만 제공합니다.

## Milestone 2 수집 경로

```text
n8n Schedule (Milestone 3)
  → collect-instagram Edge Function
  → Meta Business Discovery API
  → ingest_instagram_batch RPC
  → source_accounts + raw_posts + post_metric_snapshots
```

현재 함수는 `utdreport`만 수집하며 caller가 계정명을 바꿀 수 없습니다. `IMAGE`, `CAROUSEL_ALBUM`, `VIDEO` + `REELS`를 처리하고, Meta가 Reel 조회수를 제공하지 않으면 `view_count`를 `NULL`로 보존합니다. 캐러셀 child는 `raw_payload`에는 남지만 별도 `media_assets` 행으로 만들지 않습니다.

Meta 응답 전체가 검증된 후에만 RPC를 호출합니다. RPC는 계정 행을 잠그고 계정 업데이트, `raw_posts` upsert, 최초 snapshot 생성을 한 트랜잭션으로 수행합니다. `(source_account_id, external_post_id)`가 게시물 중복을 막고, 기존 snapshot 존재 여부가 재실행 시 최초 snapshot 중복을 막습니다.

RPC는 `SECURITY INVOKER`이며 `PUBLIC`, `anon`, `authenticated`의 실행 권한을 제거하고 `service_role`에만 허용합니다. 외부 caller에는 service-role key를 주지 않습니다. Edge Function은 `verify_jwt = false`로 gateway JWT 검사를 사용하지 않는 대신 `Authorization: Bearer <COLLECTOR_INVOKE_SECRET>`을 함수 내부에서 timing-safe 방식으로 검증합니다.

Milestone 2에서는 malformed/unsupported media 하나가 전체 batch를 실패시키는 것이 의도된 제한입니다. Milestone 3의 다계정 수집에서는 normalizer 경계를 유지한 채 rejected-item/quarantine 저장으로 바꿔, 항목 하나가 계정 전체나 다른 계정 수집을 막지 않게 합니다.

### 환경 변수

실제 값은 로컬의 무시된 env 파일이나 Supabase secrets에만 둡니다.

```text
COLLECTOR_INVOKE_SECRET
META_ACCESS_TOKEN
META_BUSINESS_ACCOUNT_ID
META_API_VERSION
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

n8n에는 이후 `COLLECTOR_INVOKE_SECRET`만 전달하며 `SUPABASE_SERVICE_ROLE_KEY`는 전달하지 않습니다.

### 로컬 함수 실행

```bash
supabase functions serve collect-instagram --env-file supabase/functions/.env.local

curl --request POST 'http://127.0.0.1:55321/functions/v1/collect-instagram' \
  --header 'Authorization: Bearer <COLLECTOR_INVOKE_SECRET>'
```

토큰, secret, service-role key, 전체 upstream 오류 본문은 응답이나 구조화 로그에 남기지 않습니다.

## 로컬 개발

필수 도구:

- Docker Desktop
- Supabase CLI 2.117.0 이상
- Git

이 프로젝트는 다른 로컬 Supabase 프로젝트와의 충돌을 피하기 위해 `55320`~`55329` 포트를 사용합니다.

```bash
supabase start
supabase db reset --local
supabase test db
supabase db lint --local --schema public,app_private --level warning
```

로컬 Studio는 `http://127.0.0.1:55323`에서 확인할 수 있습니다.

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
- 계정·게시물·최초 snapshot의 원자적 저장과 재실행 멱등성
- IMAGE, CAROUSEL_ALBUM, REELS 정규화와 nullable Reel 조회수
- Meta/API 및 DB transient retry와 영구 오류 비재시도
- collector secret 인증과 오류 응답의 비밀값 비노출

Edge Function 테스트는 Deno 2.1.4 컨테이너로 실행할 수 있습니다.

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test functions/tests
```

## 다음 마일스톤

Milestone 3에서는 검증된 Edge Function 앞에 n8n Schedule/orchestration을 연결하고, 다계정 수집과 rejected-item/quarantine 경로를 추가합니다.
