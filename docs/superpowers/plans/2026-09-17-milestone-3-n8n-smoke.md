# Milestone 3 n8n Scheduling·원격 Smoke 검증 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 단일 n8n Schedule workflow가 collector Edge Function을 안전하게 호출하도록 구성하고, 3계정·전체 active 계정·재실행의 원격 동작을 증명한다.

**Architecture:** n8n은 30분 Schedule Trigger와 Header Auth를 사용하는 HTTP Request만 가진다. DB migration, Storage bucket, Edge Function을 순서대로 배포한 뒤 scoped 3계정 smoke, 같은 bucket 재실행, 전체 active 실행, published schedule을 검증한다.

**Tech Stack:** n8n 2.x workflow JSON, Supabase CLI 2.117.0, Supabase Edge Functions, Postgres, Storage, curl, jq

**Spec:** `docs/superpowers/specs/2026-09-17-milestone-3-multi-account-ingestion-design.md`

**Prerequisites:** `docs/superpowers/plans/2026-09-17-milestone-3-core-metrics.md`와 `docs/superpowers/plans/2026-09-17-milestone-3-media-storage.md`의 완료 게이트와 커밋이 먼저 충족돼야 한다.

## Global Constraints

- n8n workflow timezone은 `Asia/Seoul`, schedule은 30분 간격이다.
- n8n에는 `COLLECTOR_INVOKE_SECRET`만 저장한다.
- Meta token, Supabase secret key, raw Meta response를 n8n으로 전달하지 않는다.
- Code Node, Telegram, OpenAI, Notion node를 추가하지 않는다.
- workflow export에는 credential 값이나 secret을 포함하지 않는다.
- 일부 계정 실패가 포함된 HTTP 200 응답을 정상적으로 보존한다.
- 원격 migration 전 local 전체 테스트가 통과해야 한다.
- 실제 secret 값을 stdout, shell trace, workflow JSON, 문서, 테스트 fixture에 출력하지 않는다.
- 원격 destructive reset은 사용하지 않는다.

---

### Task 1: n8n workflow contract와 version-controlled export

**Files:**
- Create: `n8n/workflows/instagram-collector-schedule.json`
- Create: `n8n/README.md`
- Create: `scripts/validate-n8n-workflow.mjs`

**Interfaces:**
- Consumes: deployed `POST /functions/v1/collect-instagram`, n8n Header Auth credential
- Produces: publish 가능한 `Instagram Collector Schedule` workflow

- [ ] **Step 1: workflow validator를 먼저 작성**

Node.js built-in module만 사용하는 validator를 작성해 다음을 검사한다.

```js
import fs from "node:fs";
import assert from "node:assert/strict";

const path = process.argv[2];
const workflow = JSON.parse(fs.readFileSync(path, "utf8"));
assert.equal(workflow.name, "Instagram Collector Schedule");
assert.equal(workflow.settings.timezone, "Asia/Seoul");
assert.deepEqual(workflow.nodes.map((node) => node.type).sort(), [
  "n8n-nodes-base.httpRequest",
  "n8n-nodes-base.scheduleTrigger",
].sort());

const serialized = JSON.stringify(workflow);
for (const forbidden of [
  "META_ACCESS_TOKEN",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SECRET_KEYS",
  "sb_secret_",
  "EAAB",
]) {
  assert.equal(serialized.includes(forbidden), false, `forbidden secret marker: ${forbidden}`);
}
```

validator는 endpoint URL에 `/functions/v1/collect-instagram`이 있고 HTTP method가 POST인지, HTTP node가 generic Header Auth 방식으로 설정됐으며 export 자체에는 credential value가 없는지도 검사한다.

- [ ] **Step 2: workflow 파일 부재로 validator가 실패하는지 확인**

Run:

```bash
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
```

Expected: workflow file을 열 수 없어 FAIL.

- [ ] **Step 3: 최소 workflow export 작성**

workflow는 두 node만 포함한다.

```json
{
  "name": "Instagram Collector Schedule",
  "nodes": [
    {
      "name": "Every 30 Minutes",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.3,
      "parameters": {
        "rule": {
          "interval": [{ "field": "minutes", "minutesInterval": 30 }]
        }
      },
      "position": [0, 0]
    },
    {
      "name": "Collect Active Instagram Accounts",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "parameters": {
        "method": "POST",
        "url": "https://byymtttpwmllqvggnddm.supabase.co/functions/v1/collect-instagram",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendBody": false,
        "options": {
          "response": {
            "response": { "responseFormat": "json" }
          },
          "timeout": 120000
        }
      },
      "position": [260, 0]
    }
  ],
  "connections": {
    "Every 30 Minutes": {
      "main": [[{ "node": "Collect Active Instagram Accounts", "type": "main", "index": 0 }]]
    }
  },
  "settings": { "timezone": "Asia/Seoul", "executionOrder": "v1" },
  "active": false
}
```

import 후 credential ID는 n8n UI가 관리하므로 저장소 export를 다시 갱신할 때 실제 credential value가 포함되지 않는지 validator로 검사한다.

- [ ] **Step 4: n8n 운영 README 작성**

다음 절차를 한국어로 명시한다.

1. workflow JSON import
2. endpoint가 project `byymtttpwmllqvggnddm`의 `collect-instagram`인지 확인
3. Header Auth credential 생성: header name `Authorization`, value `Bearer <COLLECTOR_INVOKE_SECRET>`
4. HTTP node에 credential 연결
5. manual execution에서 aggregate JSON 확인
6. workflow timezone 확인
7. workflow publish
8. 기존 Telegram/OpenAI workflow와 연결하지 않음

- [ ] **Step 5: workflow validator 실행**

Run: `node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json`

Expected: exit 0, `workflow validation passed`.

- [ ] **Step 6: workflow artifact 커밋**

```bash
git add n8n/workflows/instagram-collector-schedule.json n8n/README.md \
  scripts/validate-n8n-workflow.mjs
git commit -m "feat: schedule Instagram collection in n8n"
```

---

### Task 2: 배포 전 전체 검증과 secret leak scan

**Files:**
- Modify only if documentation commands are stale: `README.md`

**Interfaces:**
- Consumes: core plan과 media plan의 모든 결과
- Produces: 원격 배포 가능한 green commit

- [ ] **Step 1: worktree clean 여부와 diff 범위 확인**

```bash
git status --short --branch
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
```

Expected: 계획된 파일 외 미커밋 변경 없음.

- [ ] **Step 2: 전체 Deno 검증 실행**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno fmt --check functions
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno lint functions
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno check functions/collect-instagram/index.ts
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/collect-instagram
```

Expected: exit 0, 0 failed.

- [ ] **Step 3: 전체 local Supabase 검증 실행**

```bash
supabase db reset --local --yes
supabase seed buckets --local
supabase test db --local
supabase db lint --local --schema public,app_private --level warning --fail-on warning
supabase migration list --local
```

Expected: pgTAP 0 failed, DB lint 0건, local migration 순서 정상.

- [ ] **Step 4: workflow와 secret marker 검사**

```bash
node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
if git grep -n -E '(sb_secret_[A-Za-z0-9_-]+|EAAB[A-Za-z0-9]+|Bearer [A-Za-z0-9._-]{24,})' -- .; then
  echo 'credential-like value detected' >&2
  exit 1
fi
```

Expected: validator PASS, grep는 실제 credential 후보를 출력하지 않음. 예시 placeholder만 있는 파일은 사람이 다시 확인한다.

- [ ] **Step 5: linked migration과 project ref 확인**

```bash
supabase migration list --linked
```

Expected: linked project가 `byymtttpwmllqvggnddm`이고 local의 신규 migration만 remote pending으로 표시된다. 다른 project면 즉시 중단한다.

---

### Task 3: 원격 DB·bucket·Edge Function 배포

**Files:**
- No source changes expected

**Interfaces:**
- Consumes: green local migrations, bucket config, Edge Function bundle
- Produces: linked Supabase project의 M3 backend

- [ ] **Step 1: remote migration 적용**

```bash
supabase db push --linked
supabase migration list --linked
```

Expected: 신규 M3 migration이 local/remote 양쪽에 표시된다. push 오류 시 function과 bucket 배포를 진행하지 않는다.

- [ ] **Step 2: remote private bucket seed**

```bash
supabase seed buckets --linked
```

Expected: `instagram-analysis` bucket 생성 또는 설정 일치. public은 false다.

- [ ] **Step 3: remote DB lint**

```bash
supabase db lint --linked --schema public,app_private --level warning --fail-on warning
```

Expected: 0건. warning/error가 있으면 function 배포 전에 수정한다.

- [ ] **Step 4: Edge Function 배포 명령 확인 후 배포**

```bash
supabase functions deploy --help
supabase functions deploy collect-instagram --project-ref byymtttpwmllqvggnddm --no-verify-jwt
```

Expected: deploy 성공. command output에 secret 값이 없어야 한다.

- [ ] **Step 5: 배포 상태 확인**

```bash
supabase functions list --project-ref byymtttpwmllqvggnddm
```

Expected: `collect-instagram`이 ACTIVE이며 새 배포 timestamp를 가진다.

---

### Task 4: 3계정 scoped smoke와 멱등성 검증

**Files:**
- Create: `scripts/verify-milestone-3-smoke.sql`
- Create: `scripts/run-milestone-3-smoke.sh`

**Interfaces:**
- Consumes: deployed function, 실제 Meta/Supabase secrets, 3개 active source account
- Produces: secret을 출력하지 않는 smoke summary와 DB invariant 검증

- [ ] **Step 1: DB 검증 SQL 작성**

SQL은 username 3개를 기준으로 다음을 aggregate만 출력한다.

```sql
select sa.username,
       sa.instagram_account_id is not null as has_instagram_id,
       max(rp.followers_count_at_collection) as followers,
       count(distinct rp.id) as posts,
       count(distinct pms.id) as snapshots,
       count(distinct ma.id) as media_assets,
       count(distinct ma.id) filter (where ma.storage_path is not null) as stored_assets,
       count(distinct rp.id) filter (where rp.media_product_type = 'REELS' and rp.view_count is null)
         as reels_with_nullable_views
from public.source_accounts sa
left join public.raw_posts rp on rp.source_account_id = sa.id
left join public.post_metric_snapshots pms on pms.raw_post_id = rp.id
left join public.media_assets ma on ma.raw_post_id = rp.id
where sa.username in ('utdreport', 'utddistrict', 'manunitedzone')
group by sa.username
order by sa.username;
```

별도 query로 `(source_account_id, external_post_id)` duplicate와 `(raw_post_id, capture_bucket_start)` duplicate가 0인지 검사한다.

- [ ] **Step 2: secret-safe smoke runner 작성**

script는 `set -euo pipefail`을 사용하고 `set -x`를 금지한다. env 존재 여부만 검사하고 값을 출력하지 않는다.

```bash
: "${SUPABASE_FUNCTIONS_URL:?required}"
: "${COLLECTOR_INVOKE_SECRET:?required}"
: "${SUPABASE_DB_URL:?required}"
```

DB에서 3개 account UUID를 JSON 배열로 읽고 다음 body로 호출한다.

```json
{"source_account_ids":["uuid-1","uuid-2","uuid-3"]}
```

curl은 header 값을 출력하지 않고 response body를 임시 파일에 저장한다. jq로 다음 조건을 검사한다.

```bash
jq -e '
  .accounts_requested == 3 and
  (.accounts_success + .accounts_failed == 3) and
  (.accounts | length == 3)
' "$response_file"
```

- [ ] **Step 3: 첫 번째 3계정 smoke 실행**

```bash
set +x
bash scripts/run-milestone-3-smoke.sh --scope three --output /tmp/m3-smoke-first.json
```

Expected: HTTP 200, requested 3, 이전 PoC 지원 계정 3개 core success, DB SQL에서 account ID/followers/posts/metrics/media type 확인.

- [ ] **Step 4: 같은 bucket에서 즉시 재실행**

```bash
bash scripts/run-milestone-3-smoke.sh --scope three --output /tmp/m3-smoke-second.json
```

Expected:

- `posts_created = 0`
- duplicate raw post query = 0
- duplicate snapshot bucket query = 0
- 최초 snapshot의 `captured_at`과 metric 값 보존
- 이미 저장된 Storage path의 object 중복 생성 없음

- [ ] **Step 5: smoke artifact에서 secret marker 검사 후 삭제**

```bash
if rg -n '(sb_secret_|EAAB|Bearer )' /tmp/m3-smoke-first.json /tmp/m3-smoke-second.json; then
  echo 'secret marker detected' >&2
  exit 1
fi
rm /tmp/m3-smoke-first.json /tmp/m3-smoke-second.json
```

Expected: grep 결과 없음. 임시 response 삭제.

- [ ] **Step 6: smoke scripts 커밋**

```bash
git add scripts/verify-milestone-3-smoke.sql scripts/run-milestone-3-smoke.sh
git commit -m "test: add Milestone 3 smoke verification"
```

---

### Task 5: 전체 active 계정과 failure isolation smoke

**Files:**
- Modify only if a verified operational note is needed: `README.md`

**Interfaces:**
- Consumes: default body-less collector execution
- Produces: 전체 active 계정 결과와 failure isolation 증거

- [ ] **Step 1: 전체 active 실행 전 계정 수 확인**

DB read-only query로 active count가 seed 기준 10인지 확인한다. 10이 아니면 실제 count와 변경 이유를 기록하고 기대값을 동적으로 사용한다.

- [ ] **Step 2: body 없이 전체 active 실행**

```bash
set +x
bash scripts/run-milestone-3-smoke.sh --scope all --output /tmp/m3-smoke-all.json
```

Expected: `accounts_requested`가 DB active count와 같고 success+failed 합이 requested와 같다.

- [ ] **Step 3: failure isolation DB 검증**

실패 계정 각각에 대해 safe `probe_error` category와 `last_probe_at`이 존재하는지 확인한다. 성공 계정에는 raw posts가 commit됐는지 확인한다. response와 DB 어디에도 전체 upstream error나 token이 없어야 한다.

- [ ] **Step 4: 동일 전체 workflow 재실행**

30분 bucket 내 다시 실행해 raw post와 snapshot bucket duplicate가 0인지 검증한다. 성공 계정의 기존 post metric은 최신 raw 값으로 갱신되지만 최초 snapshot은 유지돼야 한다.

- [ ] **Step 5: 임시 artifact 삭제**

secret marker scan 후 `/tmp/m3-smoke-all.json`을 삭제한다.

---

### Task 6: n8n import·manual run·publish 검증

**Files:**
- Modify only after verified UI differences: `n8n/README.md`

**Interfaces:**
- Consumes: `n8n/workflows/instagram-collector-schedule.json`, deployed Edge Function
- Produces: published 30분 workflow와 실행 기록

- [ ] **Step 1: workflow import와 credential 연결**

n8n UI에서 JSON을 import하고 `Instagram Collector Invoke Secret` Header Auth credential을 만든다. credential에는 `Authorization: Bearer <COLLECTOR_INVOKE_SECRET>`만 저장한다. workflow export나 screenshot에 value를 노출하지 않는다.

- [ ] **Step 2: manual execution**

HTTP node를 manual 실행하고 response가 다음을 만족하는지 확인한다.

- HTTP 200
- `accounts_requested = active source account count`
- `accounts_success + accounts_failed = accounts_requested`
- account failure에는 safe `error_category`만 존재

- [ ] **Step 3: timezone과 schedule publish**

workflow timezone이 `Asia/Seoul`, interval이 30분인지 확인한 뒤 publish한다. 기존 Telegram/OpenAI workflow에는 node나 connection을 추가하지 않는다.

- [ ] **Step 4: 첫 scheduled execution 확인**

최대 35분 안에 한 번의 scheduled execution이 생기는지 확인한다. 실행 결과 summary와 Supabase Function log의 request ID가 대응하는지 확인한다.

- [ ] **Step 5: 최종 전체 검증과 문서 commit**

소스 변경이 있었다면 전체 Deno/pgTAP/lint를 다시 실행한다. 실제 UI 차이로 `n8n/README.md`를 수정했다면 다음으로 커밋한다.

```bash
git add n8n/README.md README.md
git commit -m "docs: record Milestone 3 operations"
```

변경이 없으면 빈 commit을 만들지 않는다.

## Milestone 3 최종 완료 게이트

- [ ] active source account 다계정 수집
- [ ] 한 계정 실패가 다른 계정 commit에 영향 없음
- [ ] raw post 중복 0, 기존 post 갱신 확인
- [ ] cadence snapshot과 bucket deduplication 확인
- [ ] IMAGE, carousel child, Reel thumbnail 저장
- [ ] Reel view count nullable 보존
- [ ] private Storage와 30일 retention metadata 확인
- [ ] Storage 실패가 core ingest를 롤백하지 않음
- [ ] secret marker scan clean
- [ ] n8n manual 및 published schedule 호출 성공
- [ ] 같은 workflow 재실행 안전
- [ ] 전체 Deno, pgTAP, format, lint, type-check, local/linked DB lint 통과
- [ ] 3계정과 전체 active 실제 Meta smoke 성공
