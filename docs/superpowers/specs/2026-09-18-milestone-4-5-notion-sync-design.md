# MU Content Intelligence System — Milestone 4.5 설계

- 작성일: 2026-09-18
- 상태: 승인된 설계 문서화
- 대상 branch: `milestone-4-5-notion-sync`

## 1. 목적과 시스템 경계

M4가 Supabase canonical schema에 저장한 curated `content_candidates`를 사람이
매일 검토할 수 있는 Notion editorial surface로 안정적으로 projection한다.

```text
Meta Instagram API → Supabase Story Intelligence → content_candidates
  → sync-notion-intelligence Edge Function → Notion Daily Intelligence
```

- Supabase: canonical source of truth
- Notion: editorial projection과 human review surface
- n8n: scheduled orchestration only
- Edge Function: query, mapping, hash, Notion mutation, lifecycle, retry, state

Notion에서 score나 clustering을 재계산하지 않는다. raw post 전체 또는 모든
competitor post를 mirror하지 않으며, n8n Code Node에 sync business logic을 넣지
않는다.

## 2. Notion 대상

실제 workspace의 `📡 MU Intelligence Hub` 아래에 별도 `📡 Daily Intelligence`
database를 생성했다. 기존 `🛰 MU Competitor Feed`는 post-level database이므로
재사용하지 않는다.

Database ID는 secret/local environment의
`NOTION_DAILY_INTELLIGENCE_DATABASE_ID`로만 주입한다.

하나의 page는 하나의 curated candidate와 하나의 canonical `ranking_date`를
나타낸다. stable identity는 `story_cluster_id + ranking_date`이며 candidate UUID
단독은 identity가 아니다.

## 3. Curated query와 payload

동기화 대상은 다음을 모두 만족한다.

```sql
story_clusters.status <> 'ARCHIVED'
AND (
  content_candidates.rank <= 10
  OR content_candidates.first_mover_flag = true
  OR content_candidates.must_cover_flag = true
)
```

`ranking_date`는 intelligence run의 canonical date를 사용한다. 기존 page가
후속 run에서 curated 조건에서 빠져도 삭제하지 않고 `DROPPED`로 projection한다.
ARCHIVED cluster는 `EXPIRED`로 projection한다.

System-owned Notion properties는 title, sync identity, candidate/cluster IDs,
ranking date/rank, score/confidence, flags, Korea/coverage metrics, velocity,
reliability/source diversity, first seen, lifecycle, Supabase updated at,
last synced at이다. Page body에는 component breakdown, coverage, source 정보,
Instagram permalink, usernames, timing, deterministic evidence만 넣는다.
LLM summary는 만들지 않는다.

Human-owned properties는 `Editorial Status`, `Selected`, `Editor Headline`,
`Editor Notes`다. 모든 sync mutation에서 이 필드를 payload에 포함하지 않으며,
reverse sync도 구현하지 않는다.

## 4. Idempotency와 lifecycle

System-owned payload를 stable-key canonical serialization하고 SHA-256 hash한다.

| State lookup | Action |
|---|---|
| mapping 없음 | CREATE |
| hash 동일 | NOOP |
| hash 변경 | UPDATE |
| curated에서 제외 | DROPPED |
| cluster ARCHIVED | EXPIRED |

Notion page는 자동 삭제하지 않는다. System lifecycle(`CURRENT`, `DROPPED`,
`EXPIRED`)은 human editorial lifecycle과 분리한다.

`app_private.notion_sync_state`가 identity, candidate/cluster/date, Notion page ID,
last hash/time, sync status, safe error category를 저장한다. RLS를 활성화하고
public/anon/authenticated 접근을 revoke하며 service role만 사용한다.

## 5. Notion API와 failure policy

Notion client는 create/update와 response contract parsing을 캡슐화한다.

- 429: `Retry-After` 우선
- 5xx, network timeout: bounded exponential retry
- 400, 401, 403, malformed contract: retry하지 않음
- candidate별 독립 처리; 하나의 실패가 나머지를 중단하거나 upstream을 rollback하지 않음

응답은 `requested`, `created`, `updated`, `unchanged`, `failed`와 safe failure
category만 포함한다. full Notion response, token, raw error body는 log/response/state에
저장하지 않는다.

## 6. n8n integration

기존 flow를 다음처럼 확장한다.

```text
Schedule → Collector → Intelligence → Notion Sync
```

Notion Sync HTTP node는 candidate payload를 받지 않는다. Edge Function을 invoke해
Supabase canonical data를 직접 읽는다. Collector와 Intelligence 성공이 선행되어야
하며 Notion projection 실패가 두 upstream의 성공을 뒤집지 않는다. credential은
n8n credential reference에만 두고 workflow JSON에 secret을 넣지 않는다.

## 7. Verification / smoke criteria

Unit/integration/pgTAP와 실제 Notion smoke에서 다음을 증명한다.

- private sync-state schema/RLS/권한
- allowlist와 human-field exclusion
- canonical hash의 order stability와 value sensitivity
- retry classification, timeout, safe error
- CREATE → same-run NOOP → changed-value UPDATE
- second run duplicate page 없음
- human-owned 값 변경 후 sync 재실행해 보존
- 한 candidate failure가 나머지 sync를 막지 않음
- CURRENT/DROPPED/EXPIRED projection
- TOP 3~5 actual page와 UI-visible property 확인
- pgTAP, Deno, DB lint, n8n validator/tests, M4 smoke, secret scan

## 8. Out of scope

Creative Brief, LLM editorial summary/headline generation, Telegram UX, Figma,
Instagram auto-publishing, performance feedback loop, scoring/clustering 변경,
reverse sync, Supabase human-decision schema, automatic post generation은 M4.5에
포함하지 않는다.
