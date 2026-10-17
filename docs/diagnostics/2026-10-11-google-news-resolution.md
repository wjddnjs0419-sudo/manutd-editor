# Google News 원문 URL 변환 장애 확인 — 2026-10-11

확인 범위: Supabase 운영 로그/DB 읽기, 실제 배포 소스 다운로드, 운영 기사 표본에 대한 로컬 네트워크 확인, 저장 로직의 모의 HTTP 재현. 이번 조사에서는 운영 코드 배포나 운영 데이터 변경을 하지 않았다.

## 결론

v14의 직접 실패 원인은 Google 기사 페이지 단계의 HTTP 429다. URL 해석 RPC 또는 출판사 본문 추출 단계에 도달하기 전에 중단된다. 로컬에서는 같은 배포 소스로 운영 기사 표본 4개가 모두 원문 주소로 해석됐다. 따라서 해석 알고리즘의 전면 고장이나 수정 코드의 배포 누락으로 설명할 수 없다.

현재 증거로 특정 Supabase IP의 영구 차단, 정확한 Google 제한 임계값, CAPTCHA 경유 여부를 확정할 수 없다. HTTP_STATUS 로그가 최종 요청 호스트/경로, Retry-After, 응답의 오류 종류를 기록하지 않기 때문이다. 429가 기사 페이지 단계에서 발생한 것은 확정이지만, news.google.com 자체인지 리다이렉트 뒤 www.google.com인지도 구분되지 않는다.

## 운영 증거 (KST)

| 실행 | 증거 |
| --- | --- |
| 16:52, v13 | 4건 UNSAFE_REDIRECT, HTTP 302, redirectHost=www.google.com |
| 16:54, v14 | 4건 article_page / HTTP_STATUS / 429 |
| 17:00 자동 실행 | 4건 article_page / HTTP_STATUS / 429 재발, 해당 최신 run에 남아 있는 Google 관측 23건 중 원문 변환 0, 본문 추출 0 |

v14 로그: https://supabase.com/dashboard/project/byymtttpwmllqvggnddm/functions/trend-discovery/logs?log=524ecaac-e049-46ff-a6dc-4f13b884d4ab

로그 상세에서 version=14, region=ap-northeast-2, execution_id=84d80233-8999-4a72-a3c8-096b4c339f69를 확인했다.

17:00 run: 03c396e3-cf8a-4fe8-b6cf-b971d9d1b8e7. status=COMPLETED, query_count=6, observation_count=37.

주의: discovery_observations.metadata.last_run_id는 다음 실행에서 갱신되는 값이다. 이 값을 기준으로 집계한 과거 실행의 행 수는 원래 실행 당시 총수와 다를 수 있다. append-only 실행별 결과 기록으로 취급하면 안 된다.

## 실제 배포 소스 확인

Supabase CLI functions download로 별도 임시 폴더에 다운로드했다. 운영 google_news_resolution.ts는 지난 세션 배포 작업 폴더의 파일과 byte 단위로 같았다.

- 다운로드 위치: /tmp/manutd-gnews-audit.lS6Ted
- google_news_resolution.ts SHA-256: ef3f1a517b1e8047696790abcee10741964f5fa41a80e8bb188defbade38d192
- repository.ts SHA-256: c5dd3a2c79025cf629fb8a192ccb42bdd393b0a4a38dd4d7c65602786486ffbf
- 주 작업 폴더는 과거 브랜치이고, 최신 변환기는 별도 worktree에 있다. 다음 구현에서 주 작업 폴더의 오래된 코드로 운영본을 덮어쓰지 않도록 주의한다.

## 로컬에서 실제 기사 4개 확인

17:00 run의 Google 관측 중 맨유 관련성/발행 시각으로 정렬한 표본이다. 다른 공급자의 후보까지 포함한 전체 스케줄을 재생한 실험은 아니다. 운영 로그에는 개별 기사 식별자가 없어 각 429와 표본을 일대일 매칭할 수 없다.

| 표본 | 원문 주소 |
| --- | --- |
| Goal | https://www.goal.com/en/lists/man-utd-benjamin-sesko-injury-michael-carrick/bltc7df89decd2be5d2 |
| Football365 | https://www.football365.com/news/16-conclusions-manchester-united-spurs-carrick-sack-de-zerbi |
| BBC | https://www.bbc.com/sport/football/articles/c62e9g09e781o |
| Sky Sports | https://www.skysports.com/football/live-blog/13025492/man-utd-transfer-news-rumours-and-gossip-live-updates-and-latest-on-deals-signings-loans-and-contracts |

모두 GET news.google.com/articles → 같은 호스트 302 → 200 → POST batchexecute 200 순서로 성공했다. 재시도 없이 순차 실행했다. 이는 URL 변환 검증이며 출판사 본문 확보 성공까지 뜻하지 않는다. 실행 파일: 임시 폴더의 probe.ts.

## 추가로 재현한 저장 결함

repository.ts의 upsertObservation은 기존 행에서 id,story_cluster_id만 읽는다. 기존 원문 URL, 긴 본문, 변환 성공 metadata를 읽거나 보존하지 않고 새 RSS 관측으로 다시 upsert한다.

모의 저장소에 원문 URL/본문/성공 표시가 있는 행을 넣은 뒤 같은 external_id의 미변환 RSS 관측을 저장한 결과:

```json
{"lookupFields":"id,story_cluster_id","previousPublisherUrlOverwritten":true,"previousArticleExcerptOverwritten":true,"previousResolutionFlagLost":true,"productionWrites":0}
```

즉 성공한 기사도 다음 실행에서 변환 실패하거나 보강 후보에서 빠지면 원래 Google 링크로 돌아갈 수 있다. 이 문제는 코드 재현으로 확인했으며, 운영에서 실제로 과거 성공 데이터가 손실됐다는 이력 증거까지 확보한 것은 아니다. 실행 파일: 임시 폴더의 persistence-probe.ts.

## 장애가 정상 완료처럼 보이는 이유

- Google 변환 후보는 실행당 최대 4건이며 전체 보강 후보 제한은 12건이다. 40건 수집과 40건 변환 시도는 다르다.
- resolver는 429에서 null을 반환하고 article_enrichment.ts는 기존 관측을 반환한다.
- orchestrator.ts의 COMPLETED/PARTIAL은 공급자 수집 실패 여부로 정한다. 보강 실패는 여기에 반영하지 않는다.
- Google 변환에는 공유 캐시, 실행 간 속도 제한/휴지기, 실패별 재시도 예약이 없다.

## 후속 수정에 필요한 기준

1. 429 진단에 쿼리/토큰을 제외한 요청 호스트, 허용된 경로 분류, redirect 횟수, Retry-After 및 제한 페이지 분류를 남긴다. ARTICLE_PAGE/RPC를 유지하고 실행/기사의 비가역 식별자로 연결한다.
2. 이미 확보한 원문 URL/본문은 수집 실패나 후보 제외 때문에 덮어쓰지 않는다. 저장된 성공 결과를 재사용한다.
3. 실행별 attempted/resolved/extracted/rate_limited/not_attempted를 따로 기록한다. 수집 완료만으로 원문 확보 성공을 표현하지 않는다.
4. 429에 무제한 즉시 재시도하지 않는다. 공급자 범위 휴지기와 지연 재시도를 두되, 이것만으로 Google 접근이 복구된다고 보장하지 않는다.
5. 핵심 원문 확보 경로는 출판사 RSS/공식 원문 주소를 우선 사용하고 Google 해석 실패를 견딜 수 있어야 한다. 대체 서비스는 실제 서버에서 성공률과 비용을 검증한 뒤 선택한다.
6. 완료 판단은 실제 운영 환경의 URL 전환, 별도의 본문 추출, 후속 실행에서 성공 결과 보존까지 확인한 뒤 내린다. 로컬 테스트 성공만으로 해결됐다고 판단하지 않는다.

Google은 네트워크의 자동화 검색 트래픽 때문에 접근이 제한될 수 있음을 설명한다. 이는 환경별 차이의 가능한 설명이지 이 프로젝트의 특정 IP 차단을 입증하는 자료는 아니다: https://support.google.com/websearch/answer/86640?hl=en
