# Google News 원문 URL 복원 — 배포 환경 2차 검증

**검증일:** 2026-10-12 (KST)
**판정:** **CONDITIONAL** — GitHub-hosted Ubuntu에서 변환은 성공했지만, Supabase 운영 egress의 기존 429와 비공식 Google endpoint 의존성 때문에 바로 Google News를 재활성화할 근거로는 부족하다.

## 요약

- GitHub-hosted `ubuntu-latest`, Python 3.11에서 `gnews-decoder==0.1.1`로 이전 PoC의 고유 URL 30개를 `decode_many()` 처리했다. 변환은 **30/30 (100%)**, 기사별 resolver 시간 평균 **134.55ms**, 배치 wall time **2.137초**였다.
- Google 요청은 총 **61회**였다. HTTP **302 30회**, **200 31회**(30개 URL 조회와 batch RPC), **429 0회**. 이 한 번의 runner 실행 결과는 이전에 관찰된 Supabase egress의 429를 해소하지 않는다.
- 실제 언론사 뉴스 페이지로 볼 수 없는 YouTube 영상 URL 1개가 포함되어 있다. 따라서 decoder 성공은 30/30이지만, 뉴스 매체 URL로 엄격히 세면 **29/30 (96.7%)**이다.
- 같은 원문 페이지 10개를 페이지당 한 번 가져와 200/500/800KB 상한에 맞춰 비교했다. 개선 추출기의 유효 기사 본문은 **3/10 → 6/10 → 8/10**이었다. 구형 추출기는 500KB에서 7/10, 800KB에서 9/10을 표시했지만 Times of India 페이지의 “Be respectful · TOI community guidelines”를 본문으로 잘못 잡아 각 단계에서 한 건씩 오탐이다.
- 본문 테스트는 원문 페이지 HTTP 요청 10회, 429 없음이었다. New York Times는 403을 반환했고 우회하지 않았다. 전체 HTML은 파일로 저장하지 않았고, 결과에는 최대 500자 미리보기와 크기/상태만 남겼다.
- 기존 Supabase Edge fetch helper가 응답 본문을 최대 200,000바이트로 제한한다. 이 공용 hard cap을 올리는 대신, 운영 통합 시 기사 페이지 전용 800,000바이트 상한을 추가해야 한다.
- Google News 설정, Supabase 데이터, GDELT, cron, 배포, M8/M9 workflow는 변경하지 않았다.

## 1. GitHub Actions URL 변환

### 실행 결과

| 측정값 | 결과 |
|---|---:|
| 입력 | 이전 PoC의 실제 Google News URL fixture, 중복 제거 후 30개 |
| 실행 환경 | GitHub-hosted `ubuntu-latest`, Python 3.11 |
| 라이브러리 | `gnews-decoder==0.1.1` |
| 동시성 | 최대 2 |
| URL 변환 성공 | **30/30 (100%)** |
| 뉴스 매체 URL로 엄격히 판정 | **29/30 (96.7%)**; 나머지 1개는 `youtu.be` 영상 |
| 평균 기사별 처리시간 | 134.55ms |
| 배치 wall time | 2,136.8ms |
| 평균 Google signature GET | 67.28ms |
| batch RPC | 84.65ms |
| Google HTTP 요청 | 61: 302 × 30, 200 × 31, 429 × 0 |
| 오류 | fatal error 없음 |

`decode_many()` 우선 호출, 동시성 2, Google 응답 429 즉시 중단, 자동 재시도 없음으로 설정했다. 각 HTTP 요청의 상태와 경과시간 및 각 기사별 변환시간은 [GitHub Actions 실행 결과와 JSON artifact](https://github.com/wjddnjs0419-sudo/manutd-editor/actions/runs/38160232680)에서 확인할 수 있다. workflow job은 약 17초였고 resolver batch 자체는 2.137초였다.

이 실행은 공개 저장소의 draft PR을 열었을 때 발생한 **실제 라이브 runner 실행**이며, fixture를 읽고 Google에 요청했다. Supabase에는 연결하지 않았고 비밀값도 사용하지 않았다. 현재 workflow는 이후 실수로 Google 요청을 반복하지 않도록 **수동 `workflow_dispatch` 전용**으로 정리했다. 실행된 테스트와 같은 job/스크립트가 들어 있지만, 이 수동 workflow를 직접 dispatch한 실행은 없다. GitHub는 `workflow_dispatch`를 시작하려면 workflow 파일이 default branch에 있어야 한다고 명시하므로, draft PR이 병합되지 않은 현재는 UI의 Run workflow 버튼으로 재실행할 수 없다. 병합은 이번 검증 범위에 포함하지 않았다.

단일 실행에서 429가 없었다는 것은 runner egress에서의 한 번의 성공 표본이다. 이전 Supabase 운영 환경의 429와는 네트워크 출구가 다르므로 같은 차단 여부라고 볼 수 없고, 반복 실행·시간대별 안정성도 아직 검증하지 않았다.

### 재현 파일

- `.github/workflows/gnews-decoder-deployment-validation.yml` — 수동 실행 전용, 30개 fixture 확인, 429/실패 시 job 실패, 요청 요약 및 7일 artifact 저장
- `scripts/gnews_decoder_poc.py` — URL 검증, 요청 계측, 동시성 제한, 429 중단, SSRF 방어
- `scripts/fixtures/gnews-decoder-input.json` — 30개 입력
- `scripts/requirements-gnews-decoder-poc.txt` — 버전 고정
- `scripts/test_gnews_decoder_poc.py` — 네트워크 없는 단위 테스트

테스트 workflow는 기존 `.github/workflows/m9-private-preview.yml`을 수정하지 않았다. 라이브 runner 실행 때 offline 단위 테스트와 30개 고유 URL 검사를 먼저 통과했고, workflow run은 성공했다.

## 2. 원문 본문 접근 및 추출

### 200KB 제한 위치

`supabase/functions/trend-discovery/search_provider_http.ts`의 `DEFAULT_MAX_BYTES`와 `HARD_MAX_BYTES`가 둘 다 `200_000`이다. 응답 `Content-Length`가 상한보다 크면 본문을 읽지 않고, 길이를 알 수 없을 때도 stream이 상한을 넘으면 취소한다. `article_enrichment.ts`에서 전달하는 크기 옵션으로도 이 공용 hard cap을 초과할 수 없다.

공용 helper는 기사 원문뿐 아니라 RSS 및 다른 discovery provider 호출에도 쓰인다. 따라서 이 상수를 800KB로 바꾸면 기사 이외의 응답도 넓게 허용한다. 운영 적용은 article page fetch에만 별도 상한을 주는 방식이 안전하다.

현재 `source-discovery/article_extractor.ts`는 script/style/nav/footer/header/aside를 제외하고 40자 이상의 `<p>`를 이어 붙인다. 광고·관련 기사 같은 `div` 영역은 걸러내지 않고, 제목과 본문 관련성도 검사하지 않는다. 이번 개선 비교는 이 동작을 기준으로 기존 방식으로 표기했다.

### 동일한 10개 페이지 결과

각 페이지를 HTTPS로 한 번만 요청하고, 최대 800,000바이트 안에서 받은 같은 HTML을 200/500/800KB 각각의 제한에 적용했다. 따라서 비교를 위해 매체 서버에 30번 요청하지 않았다. 개선 추출은 `<article>`/`<main>` 컨테이너를 우선하며, navigation/광고/프로모션/관련 기사 등으로 표시된 블록과 숨김 요소를 건너뛰고 제목 토큰 관련성도 확인한다.

| 상한 | 기존 추출기가 표시한 성공 | 기존 중 실제 기사 본문 | 개선 추출기 실제 기사 본문 |
|---:|---:|---:|---:|
| 200KB | 3/10 (30%) | 3/10 (30%) | **3/10 (30%)** |
| 500KB | 7/10 (70%) | 6/10 (60%) | **6/10 (60%)** |
| 800KB | 9/10 (90%) | 8/10 (80%) | **8/10 (80%)** |

기존의 표시 성공과 개선 성공 차이는 TOI의 커뮤니티 안내 문구가 기존 방식에서 기사 본문처럼 잡힌 오탐이다. 개선 추출기는 기대 제목과 맞지 않아 `TITLE_NOT_RELEVANT`로 거부했다. 새 extractor가 본문 수를 더 만들어낸 것은 아니며, noise를 제외하면서 본문 판정의 오탐을 줄였다. 200KB에서 800KB로 올리면 이 표본의 실제 본문 확보는 3건에서 8건으로 늘었다.

| 기사 | HTTP | 받은 바이트 | 기존 200/500/800KB | 개선 200/500/800KB | 비고 |
|---|---:|---:|---|---|---|
| Yahoo Sports — Brazilian talent / €80m | 200 | 552,796 | 실패/실패/성공 | 실패/실패/성공 | 800KB에서 기사 추출 |
| Transfermarkt — Bayern/Kane transfer live | 200 | 186,075 | 성공/성공/성공 | 성공/성공/성공 | 동일 페이지 fixture 2건 |
| Yahoo Sports — Newcastle injury update | 200 | 550,531 | 실패/실패/성공 | 실패/실패/성공 | 800KB에서 기사 추출 |
| Sky Sports — Paper Talk | 200 | 204,462 | 실패/성공/성공 | 실패/성공/성공 | 500KB부터 추출 |
| The False 9 — journalist tier list | 200 | 97,562 | 성공/성공/성공 | 성공/성공/성공 | 200KB 안에 포함 |
| Goal.com — Benjamin Sesko injury | 200 | 238,212 | 실패/성공/성공 | 실패/성공/성공 | 500KB부터 추출 |
| Times of India — unwanted record | 200 | 329,660 | 실패/오탐/오탐 | 실패/거부/거부 | 구형은 커뮤니티 안내 문구만 추출 |
| The New York Times — Tottenham draw | **403** | 0 | 제한/제한/제한 | 제한/제한/제한 | 제한 우회 없음 |
| Sports Illustrated — transfer rumors | 200 | 276,110 | 실패/성공/성공 | 실패/성공/성공 | 500KB부터 추출 |

각 매체 페이지에서 메뉴·광고·관련 기사 영역이 실제 페이지에 모두 나타나는 것은 아니다. 이 표본에서는 개선 parser가 일반 페이지 요소와 73개 noise block(Yahoo), 36개(SI), 74개(TOI) 등을 제외했다. 추출 미리보기와 HTML 전체를 함께 보존하지 않았다.

검증 스크립트는 Python 격리 환경에서 로컬 실행했다. 원문 HTTP 요청은 10회였고 매체 429는 없었다. 800KB 상한은 응답 원시 bytes만으로 메모리를 제한하지는 않는다. Python의 decoded string/DOM parser에는 추가 메모리가 들 수 있으므로 운영 전 peak RSS 측정과 페이지별 동시성 제한이 필요하다.

## 3. 운영 구조 검토

제안 구조는 구현 가능하지만, 지금 repository의 흐름과 바로 연결된 것은 아니다.

```text
Google News RSS
  → discovery_observations (원본 Google URL 보존)
  → 제한된 URL resolver batch
  → publisher URL 별도 저장
  → 기사 원문 HTTP 접근/추출 상태 저장
  → 기존 promotion / story cluster / source 연결
  → M8/M9
```

### 필요한 데이터 및 전달 계약

- 현재 `app_private.discovery_observations.canonical_url`에는 provider URL이 들어가고, row는 `provider_id`/`external_id` 조합으로 중복 방지된다. 이를 resolver 결과로 덮어쓰면 원래 Google RSS 링크와 출처 추적이 사라진다. `canonical_url`은 Google URL로 보존하고 `resolved_publisher_url`, `url_resolution_status`, `resolved_at`, `last_attempt_at`/오류 코드 같은 별도 필드를 추가해야 한다.
- Actions workflow는 현재 fixture JSON만 읽는다. Supabase와의 실제 연결은 미구현이다. public GitHub runner에 Supabase `service_role` 키를 저장하지 말고, 제한된 batch claim/read와 결과 write만 허용하는 인증 Edge Function 또는 권한이 좁은 전용 DB 경로를 추가한다. 한 번에 가져갈 건수, 요청 ID, 재실행 멱등성, batch lease 만료를 계약에 포함한다.
- 원문 URL 변환 성공, 원문 페이지 HTTP 접근, 본문 추출은 별도 상태로 기록한다. 예: `URL_RESOLVED`, `PAGE_FETCHED`, `ARTICLE_BODY_EXTRACTED`, `ACCESS_RESTRICTED`, `BODY_TOO_LARGE`, `URL_RESOLUTION_FAILED`, `RATE_LIMITED`. 403/paywall 및 변환 실패 URL은 원본 Google URL과 함께 남기고, 본문 추출 성공으로 표시하지 않는다.
- 중복은 전체 query string이 아니라 `/rss/articles/<article-id>`를 정규화해 제거한다. 변환 성공 결과를 영속 cache에 기록하고, 같은 ID는 다시 변환하지 않는다. 실패는 사유별 재시도 간격을 두고, Google 429에는 전역 cooldown을 둔다. GitHub Actions cache는 영속 DB 대신 쓰지 않는다.
- `promote-discovery`는 현재 discovery `canonical_url`을 source observation의 canonical URL로 넘긴다. 통합 시 원본 Google URL은 discovery에 계속 남기고, 검증된 publisher URL만 source observation에 반영하며, 원본은 metadata/source provenance로 보존해야 한다. `sourceCanonicalName`, `external_id`, `story_cluster_id`, `source_observation_id`, fingerprint/cluster 연결 계약도 유지한다.
- Google News 검색 결과 자체가 맨유 관련성을 보장하지 않는다. RSS 저장 전에 title/source로 명백한 비관련 결과를 걸러내고, 현재의 `calculateManutdRelevanceScore` 및 promotion 검토를 최종 gate로 유지한다. 현재 orchestrator는 관측치를 저장한 뒤 cluster 수용 여부를 계산하므로, resolver batch에서 관련성 필터를 별도로 적용할 여지가 있다.

### 실행 간격과 요청량

이 실측에서는 고유 URL 30개에 HTTP 요청 61회(대략 URL당 2회 + batch RPC 1회)가 발생했다. 따라서 캐시가 없는 batch 크기 `U`의 예산은 대략 `2U + 1` Google HTTP 요청이며, 30건은 61회, 100건은 약 201회다. 별도의 원문 본문 접근은 URL당 최소 1회 publisher request와 리다이렉트를 추가한다. 캐시 hit, 실패율, publisher redirects에 따라 실제 수는 달라진다.

처음 통합할 때는 기존 M9 실행과 겹치지 않는 저빈도 batch(예: 30분 간격, batch 상한 30)와 동시성 2를 권한다. 429가 오면 즉시 해당 run을 멈추고 Retry-After/cooldown을 저장한 뒤 다음 실행까지 기다린다. 매 실행에서 새 URL 수와 예상 `2U+1`을 먼저 계산해 예산을 넘으면 batch를 나눈다. GitHub scheduled workflow는 시간대 부하 때 지연되거나 누락될 수 있으므로 분 단위의 정확한 queue scheduler로 간주하면 안 된다. GitHub 문서도 정시 부하에서 scheduled workflow 지연 가능성을 안내한다.

### 비용과 주요 장애 위험

- 이 저장소는 public repository이고 실행은 standard GitHub-hosted Ubuntu runner를 사용했다. GitHub 문서 기준 public repository의 standard hosted runner 사용은 무료다. 라이브 실행은 약 17초, 결과 artifact는 작은 JSON이며 7일 후 만료한다. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- Supabase 호출/저장 비용은 현재 사용 중인 요금제와 실행 빈도에 따라 달라져 여기서 금액으로 추정하지 않았다. resolver 연동에는 batch read/write 몇 회와 page excerpt 저장이 추가된다. Google/언론사 측 rate limit은 요금과 별개 위험이다.
- 가장 큰 안정성 위험은 gnews-decoder가 Google News 내부 `batchexecute`/signature 흐름을 쓰는 점이다. Google이 비공식 내부 요청·응답 형식을 바꾸면 디코딩 실패, 429, CAPTCHA/consent 경로, 일괄 변환 실패가 생길 수 있다. 새 runner에서 한 번 성공한 사실은 Supabase Edge egress의 429나 endpoint 변경 위험을 해결하지 않는다.
- publisher별 robots/rate limit, 403, paywall, HTML 구조 변경, 지나치게 큰 페이지, 제목과 본문이 맞지 않는 페이지도 남는다. 본문 추출이 불가한 건은 원문 URL과 오류 상태만 제공하고 콘텐츠 생성을 위한 본문으로 취급하지 않아야 한다.

## 4. Google News 재활성화 판정 및 다음 변경 계획

### 판정: CONDITIONAL

**질문: “gnews-decoder로 ManUtd Editor가 Google News에서 수집한 기사의 실제 원문 URL을 자동으로 확보할 수 있는가?”**
**예: GitHub-hosted Ubuntu에서 이번 30개는 decoder 30/30, 엄격한 언론사 페이지는 29/30이었다.** 다만 Supabase 운영 환경은 기존에 429가 있었고 runner 검증도 단 한 번이어서, 오늘 운영 설정을 되돌리거나 Google News를 즉시 활성화하는 결론은 아니다. 본문은 800KB 표본에서 8/10만 확보됐고 1건은 403 제한으로 읽지 못했다.

재활성화 전 별도 통합 PR에서 다음을 구현/검증한다.

1. migration: 원본 URL은 유지하고 URL resolver/body 상태·결과·시도 시각을 분리 저장한다. 기존 discovery uniqueness와 cluster/source 외래 키를 보존한다.
2. 전용 batch claim/result 경로: Actions에는 제한된 token만 제공하고 `service_role`은 노출하지 않는다. 성공 cache, 실패 cooldown, URL article-ID dedupe, 실행별 최대 URL 수 및 idempotency를 추가한다.
3. Google resolver adapter: 429/consent/decoder 응답 구조 변경을 분류하고 즉시 중단한다. Supabase 환경과 GitHub 환경에서 반복 실행, 저속/소량 batch, 429 회복 동작을 따로 검증한 후 provider를 feature flag로 둔다.
4. 원문 fetch/extractor: 공유 `search_provider_http.ts`의 전역 200KB cap은 유지하고, 기사 원문 전용 800KB hard cap, public HTTPS/DNS 검증, redirect 3회 제한, HTML title relevance, 광고/관련 기사 제외를 추가한다. 403/paywall 우회는 구현하지 않는다.
5. promotion 연결: 검증된 publisher URL만 원문 canonical로 사용하고 Google URL은 discovery/provenance에 계속 남긴다. source name, external ID, clustering 및 기존 M8/M9 카드 생성 흐름의 회귀 검증을 넣는다.
6. 독립적인 통합 검증: 기존 M9 workflow와 cron을 바꾸지 않고, 중복 입력/429/403/body-too-large/저관련 결과를 fixture로 시험한다. 별도 승인 후 feature flag 활성화를 논의한다.

이번 PoC에서 실제 작업은 30개 URL의 GitHub runner 변환, 동일 10개 페이지의 본문 한도 실험, 네트워크 없는 단위 테스트, 수동 실행 workflow 및 이 보고서까지다. Production Supabase, Google News 운영 설정, GDELT, schedule, 자동 배포 및 M8/M9 코드 변경은 없었다.

## 참고 실행 산출물

- [GitHub Actions run 38160232680](https://github.com/wjddnjs0419-sudo/manutd-editor/actions/runs/38160232680) — 30 URL 실측 및 JSON artifact
- [GitHub workflow dispatch 안내](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) — workflow_dispatch는 default branch에 있어야 수동 실행 가능
- [GitHub scheduled workflow troubleshooting](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows) — workflow schedule 지연/누락 안내
