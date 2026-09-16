# MU Content Intelligence System

맨체스터 유나이티드 관련 Instagram 콘텐츠를 수집·분석하고, 객관적인 우선순위 점수와 실행 가능한 콘텐츠 브리프를 만드는 시스템입니다.

현재 구현 범위는 **Milestone 1: Supabase/Postgres 데이터 기반**입니다. Meta 수집기, 스토리 클러스터링 실행 로직, 점수 계산 워커, OpenAI 분석, Telegram, Notion 동기화는 아직 구현하지 않았습니다.

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

## 다음 마일스톤

Milestone 2에서는 이미 검증된 Meta Business Discovery API를 사용해 다음 최소 흐름을 구현합니다.

```text
계정 1개 조회 → 최신 미디어 수집 → 중복 제거 → raw_posts 저장 → 최초 metric snapshot 저장
```

Meta API 가용성은 다시 조사하지 않으며, 실제 자격 증명은 환경 변수로만 전달합니다.
