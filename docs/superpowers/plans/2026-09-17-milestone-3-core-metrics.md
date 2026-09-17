# Milestone 3 Core 다계정 수집·Metric Refresh 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DB의 active Instagram 계정을 concurrency 2로 격리 수집하고, 기존 post를 갱신하면서 게시물 나이별 cadence와 30분 bucket에 따라 metric snapshot을 멱등 생성한다.

**Architecture:** 기존 단일 계정 `Meta client -> normalizer -> ingest RPC`를 보존하고 그 앞에 active account repository와 bounded orchestrator를 둔다. 계정별 RPC transaction과 오류 경계를 독립시키며, handler는 일부 실패를 포함한 aggregate 결과를 HTTP 200으로 반환한다.

**Tech Stack:** Supabase Postgres 17, PL/pgSQL, pgTAP, Supabase Edge Functions, Deno 2.1.4, TypeScript

**Spec:** `docs/superpowers/specs/2026-09-17-milestone-3-multi-account-ingestion-design.md`

## Global Constraints

- 수집 대상은 `source_accounts.active = true`이며 username 목록을 코드에 추가하지 않는다.
- account worker concurrency 기본값은 2, 허용 최대값은 3이다.
- 계정별 실행 예산은 20,000ms, core run 예산은 100,000ms다.
- Meta transient 요청은 최대 3회 시도하고 `Retry-After`를 남은 계정 예산 안에서 우선한다.
- malformed media 하나는 해당 계정 batch 전체를 실패시키되 다른 계정은 계속 처리한다.
- metric cadence는 0–2시간 30분, 2–6시간 60분, 6–12시간 2시간, 12–24시간 4시간, 24시간 이후 중단이다.
- snapshot deduplication bucket은 고정 UTC origin 기준 30분이다.
- weighted engagement를 저장하지 않는다.
- secret, access token, 전체 Meta payload와 원문 upstream 오류를 로그·응답에 남기지 않는다.
- 기존 Deno 테스트와 pgTAP 테스트를 삭제하거나 약화하지 않는다.

---

### Task 1: Snapshot bucket과 cadence DB 계약

**Files:**
- Create: `supabase/tests/database/005_milestone_3_metric_refresh_test.sql`
- Create via CLI: `supabase migration new milestone_3_metric_refresh`
- Modify generated file: `supabase/migrations/*_milestone_3_metric_refresh.sql` (`supabase migration new`의 단일 출력)

**Interfaces:**
- Consumes: `public.raw_posts`, `public.post_metric_snapshots`, `public.source_accounts`, 기존 `public.ingest_instagram_batch`의 validation 규칙
- Produces: `public.ingest_instagram_account_batch(uuid, jsonb, jsonb, timestamptz) -> jsonb`, `app_private.metric_snapshot_interval(integer) -> interval`, `post_metric_snapshots.capture_bucket_start`

- [ ] **Step 1: cadence와 bucket의 실패하는 pgTAP 작성**

`005_milestone_3_metric_refresh_test.sql`에 transaction과 test plan을 만들고 다음 케이스를 실제 SQL 호출로 작성한다.

```sql
begin;
select plan(14);

select has_column(
  'public', 'post_metric_snapshots', 'capture_bucket_start',
  'metric snapshots expose a durable 30-minute bucket'
);

select is(app_private.metric_snapshot_interval(119), interval '30 minutes', '0-2h cadence');
select is(app_private.metric_snapshot_interval(120), interval '1 hour', '2-6h cadence');
select is(app_private.metric_snapshot_interval(360), interval '2 hours', '6-12h cadence');
select is(app_private.metric_snapshot_interval(720), interval '4 hours', '12-24h cadence');
select is(app_private.metric_snapshot_interval(1440), null::interval, '24h and older stops');
```

seed의 `utdreport` UUID를 조회해 `public.ingest_instagram_account_batch`를 01:01, 01:20, 01:31에 호출하고 다음을 검증한다.

```sql
select is((select count(*)::integer from public.post_metric_snapshots), 2,
  'retry inside a bucket and cadence creates no duplicate; next due bucket creates one');
select is((select count(distinct capture_bucket_start)::integer
  from public.post_metric_snapshots), 2, 'bucket key is unique per post');
```

동일 게시물의 `published_at`을 변경한 재수집은 `22023`으로 실패하고 기존 `published_at`이 유지되는 assertion도 포함한다.

- [ ] **Step 2: 새 DB 테스트가 예상대로 실패하는지 확인**

Run:

```bash
supabase test db --local supabase/tests/database/005_milestone_3_metric_refresh_test.sql
```

Expected: `capture_bucket_start`, `metric_snapshot_interval`, `ingest_instagram_account_batch`가 없어서 FAIL.

- [ ] **Step 3: CLI로 migration 파일 생성**

Run:

```bash
supabase migration new milestone_3_metric_refresh
```

Expected: `supabase/migrations/*_milestone_3_metric_refresh.sql` 파일 하나가 생성된다. 생성된 실제 경로를 이후 `git add`에 사용한다.

- [ ] **Step 4: snapshot schema와 cadence helper 구현**

생성된 migration에 다음 계약을 구현한다.

```sql
alter table public.post_metric_snapshots
  add column capture_bucket_start timestamptz;

update public.post_metric_snapshots
set capture_bucket_start = date_bin(
  interval '30 minutes', captured_at, '2000-01-01T00:00:00Z'::timestamptz
);

alter table public.post_metric_snapshots
  alter column capture_bucket_start set not null;

alter table public.post_metric_snapshots
  add constraint post_metric_snapshots_post_bucket_key
  unique (raw_post_id, capture_bucket_start);

create function app_private.metric_snapshot_interval(post_age_minutes integer)
returns interval
language sql immutable parallel safe
set search_path = ''
as $$
  select case
    when post_age_minutes < 0 then null
    when post_age_minutes < 120 then interval '30 minutes'
    when post_age_minutes < 360 then interval '1 hour'
    when post_age_minutes < 720 then interval '2 hours'
    when post_age_minutes < 1440 then interval '4 hours'
    else null
  end;
$$;
```

helper의 `PUBLIC`, `anon`, `authenticated` 실행 권한을 revoke하고 `service_role`에만 grant한다.

- [ ] **Step 5: account-ID 기반 ingest RPC 구현**

새 RPC는 다음 signature를 사용한다.

```sql
public.ingest_instagram_account_batch(
  p_source_account_id uuid,
  p_account jsonb,
  p_posts jsonb,
  p_collected_at timestamptz
) returns jsonb
```

기존 RPC의 payload validation과 upsert를 재사용하되 다음을 변경한다.

- `source_accounts.id = p_source_account_id and active` 행을 `for update`로 잠근다.
- 기존 post면 입력 `published_at`이 DB 값과 다를 때 `22023`을 발생시킨다.
- raw post의 mutable field만 update한다.
- 각 post의 최신 snapshot을 읽고 최초 snapshot이 없거나 cadence가 경과했을 때만 insert한다.
- `capture_bucket_start`는 `date_bin(interval '30 minutes', p_collected_at, fixed origin)`으로 계산한다.
- insert는 `(raw_post_id, capture_bucket_start) do nothing`으로 마지막 race를 차단한다.
- 반환 JSON은 기존 count와 post ID mapping을 포함한다.

```json
{
  "account_id": "uuid",
  "inserted_posts": 1,
  "updated_posts": 2,
  "inserted_snapshots": 1,
  "posts": [
    {"external_post_id": "media-1", "raw_post_id": "uuid"}
  ]
}
```

RPC는 `SECURITY INVOKER`, 빈 `search_path`, service-role 전용 grant를 유지한다. 기존 M2 RPC는 회귀 테스트를 위해 이 task에서 제거하지 않는다.

- [ ] **Step 6: 새 DB 테스트와 전체 pgTAP 실행**

Run:

```bash
supabase db reset --local --yes
supabase test db --local
supabase db lint --local --schema public,app_private --level warning --fail-on warning
```

Expected: 기존 78개와 새 14개 assertion이 모두 PASS, DB lint 결과 0건.

- [ ] **Step 7: DB 계약 커밋**

```bash
git add supabase/migrations/*_milestone_3_metric_refresh.sql \
  supabase/tests/database/005_milestone_3_metric_refresh_test.sql
git commit -m "feat: add metric refresh cadence"
```

---

### Task 2: Active account repository와 probe failure RPC

**Files:**
- Modify: Task 1에서 생성한 `*_milestone_3_metric_refresh.sql`
- Modify: `supabase/tests/database/005_milestone_3_metric_refresh_test.sql`
- Modify: `supabase/functions/collect-instagram/types.ts`
- Modify: `supabase/functions/collect-instagram/repository.ts`
- Modify: `supabase/functions/tests/collect-instagram/repository_test.ts`

**Interfaces:**
- Consumes: `public.source_accounts`, `public.ingest_instagram_account_batch`
- Produces: `SourceAccount`, `AccountRepository.listActive()`, `AccountRepository.recordFailure()`, account-ID 기반 `IngestRepository.ingest()`

- [ ] **Step 1: source account와 repository interface 정의 테스트 작성**

`repository_test.ts`에 다음 동작을 검증하는 failing tests를 추가한다.

```ts
const accounts = await repository.listActive();
assert.deepEqual(accounts, [
  { id: "00000000-0000-4000-8000-000000000001", username: "utdreport" },
]);

await repository.ingest(accounts[0].id, batch);
assert.match(requestUrl, /rpc\/ingest_instagram_account_batch$/);

await repository.recordFailure({
  sourceAccountId: accounts[0].id,
  probedAt: "2026-09-17T01:00:00.000Z",
  category: "permission",
  markUnsupported: true,
});
```

list response에 inactive row가 섞이거나 UUID/username이 잘못되면 `DATABASE_INVALID_RESPONSE`로 거부하는 테스트도 작성한다.

- [ ] **Step 2: repository tests가 실패하는지 확인**

Run:

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test functions/tests/collect-instagram/repository_test.ts
```

Expected: `listActive`, 새 `ingest` signature, `recordFailure`가 없어서 FAIL.

- [ ] **Step 3: TypeScript interface 추가**

`types.ts`에 다음 타입을 추가한다.

```ts
export interface SourceAccount {
  id: string;
  username: string;
}

export type AccountFailureCategory =
  | "unsupported_account"
  | "permission"
  | "rate_limited"
  | "temporary_upstream"
  | "invalid_payload"
  | "database"
  | "run_budget_exhausted"
  | "internal";

export interface IngestedPost {
  externalPostId: string;
  rawPostId: string;
}
```

`IngestResult`에 `posts: IngestedPost[]`를 추가하고 `IngestRepository.ingest(sourceAccountId, batch)`로 변경한다.

- [ ] **Step 4: repository method 구현**

`repository.ts`에서 다음 endpoint를 사용한다.

```text
GET /rest/v1/source_accounts?select=id,username&active=eq.true&order=username.asc
POST /rest/v1/rpc/ingest_instagram_account_batch
POST /rest/v1/rpc/record_instagram_probe_failure
```

모든 요청은 기존과 동일하게 secret key를 `apikey` header에만 넣고 원문 DB error body를 폐기한다. active account ID filtering은 10개 전체 목록을 안전하게 decode한 뒤 orchestrator에서 수행한다.

- [ ] **Step 5: safe failure RPC의 pgTAP을 먼저 추가**

다음 호출을 `service_role`로 실행하고 `last_probe_at`, `probe_error`, `api_supported`를 검증한다.

```sql
select public.record_instagram_probe_failure(
  (select id from public.source_accounts where username = 'utddistrict'),
  '2026-09-17T02:00:00Z', 'permission', true
);
```

transient 호출의 `markUnsupported = false`가 기존 `api_supported`를 보존하고, 임의 문자열 category가 `22023`으로 실패하는 assertion을 추가한다.

- [ ] **Step 6: safe failure RPC 구현 후 전체 테스트 실행**

RPC는 active account 한 행만 update하고 category allow-list를 SQL에서 다시 검증한다. `probe_error`에는 category 문자열만 저장한다.

Run:

```bash
supabase db reset --local --yes
supabase test db --local
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test functions/tests/collect-instagram/repository_test.ts
```

Expected: pgTAP과 repository tests PASS.

- [ ] **Step 7: repository와 failure 상태 커밋**

```bash
git add supabase/migrations/*_milestone_3_metric_refresh.sql \
  supabase/tests/database/005_milestone_3_metric_refresh_test.sql \
  supabase/functions/collect-instagram/types.ts \
  supabase/functions/collect-instagram/repository.ts \
  supabase/functions/tests/collect-instagram/repository_test.ts
git commit -m "feat: load active Instagram accounts"
```

---

### Task 3: Meta 오류 분류와 계정 timeout

**Files:**
- Modify: `supabase/functions/collect-instagram/types.ts`
- Modify: `supabase/functions/collect-instagram/meta_client.ts`
- Modify: `supabase/functions/tests/collect-instagram/meta_client_test.ts`

**Interfaces:**
- Consumes: 기존 `createMetaClient`, `META_ACCESS_TOKEN`, `META_BUSINESS_ACCOUNT_ID`, `META_API_VERSION`
- Produces: `MetaClient.fetchAccount(username, { signal })`, category가 포함된 `MetaApiError`

- [ ] **Step 1: safe error category와 AbortSignal 테스트 작성**

다음 table-driven cases를 추가한다.

```ts
const cases = [
  { status: 400, body: { error: { code: 100 } }, category: "unsupported_account", retriable: false },
  { status: 403, body: { error: { code: 10 } }, category: "permission", retriable: false },
  { status: 429, body: { error: { code: 4 } }, category: "rate_limited", retriable: true },
  { status: 503, body: { error: { message: "secret raw detail" } }, category: "temporary_upstream", retriable: true },
];
```

error 객체와 loggable fields 어디에도 `message`와 access token이 포함되지 않는지 assertion한다. aborted fetch는 `temporary_upstream`, retriable false로 즉시 끝나며 추가 sleep을 하지 않는 테스트도 작성한다.

- [ ] **Step 2: Meta tests가 실패하는지 확인**

Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/collect-instagram/meta_client_test.ts`

Expected: category와 signal 지원이 없어 FAIL.

- [ ] **Step 3: 최소 오류 decoder와 timeout 지원 구현**

`MetaApiError`에 `category: AccountFailureCategory`를 추가한다. 실패 body는 64KiB 상한으로 읽고 JSON의 numeric `error.code`, `error.error_subcode`와 string `error.type`만 내부 분류에 사용한 뒤 폐기한다. `fetchAccount`는 전달된 signal을 모든 fetch에 연결하고 sleep 전에도 `signal.aborted`를 확인한다.

- [ ] **Step 4: Meta tests와 기존 collector tests 실행**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test \
  functions/tests/collect-instagram/meta_client_test.ts \
  functions/tests/collect-instagram/collector_test.ts
```

Expected: PASS, 기존 최대 3회 retry와 `Retry-After` 테스트 유지.

- [ ] **Step 5: Meta policy 커밋**

```bash
git add supabase/functions/collect-instagram/types.ts \
  supabase/functions/collect-instagram/meta_client.ts \
  supabase/functions/tests/collect-instagram/meta_client_test.ts
git commit -m "feat: classify Meta account failures"
```

---

### Task 4: Bounded 다계정 orchestrator

**Files:**
- Create: `supabase/functions/collect-instagram/orchestrator.ts`
- Create: `supabase/functions/tests/collect-instagram/orchestrator_test.ts`
- Modify: `supabase/functions/collect-instagram/collector.ts`
- Modify: `supabase/functions/collect-instagram/types.ts`
- Modify: `supabase/functions/tests/collect-instagram/collector_test.ts`

**Interfaces:**
- Consumes: `AccountRepository.listActive`, `collectInstagram`, `recordFailure`
- Produces: `runInstagramCollection(options) -> Promise<CollectionRunSummary>`, `mapWithConcurrency<T,R>()`

- [ ] **Step 1: bounded concurrency와 isolation failing tests 작성**

`orchestrator_test.ts`에 5개 active account와 controllable promises를 사용해 동시 실행 수를 측정한다.

```ts
const summary = await runInstagramCollection({
  requestedSourceAccountIds: undefined,
  collectedAt,
  concurrency: 2,
  runBudgetMs: 100_000,
  accountBudgetMs: 20_000,
  accountRepository,
  collectAccount,
  now,
});

assert.equal(maxObservedConcurrency, 2);
assert.equal(summary.accountsRequested, 5);
assert.equal(summary.accountsSuccess, 4);
assert.equal(summary.accountsFailed, 1);
```

한 worker가 `MetaApiError(permission)`을 던져도 나머지 4개가 완료되는지, requested ID subset이 DB active 목록 밖 ID를 포함하면 input error가 나는지, run budget 소진 계정이 `run_budget_exhausted`가 되는지 검증한다.

- [ ] **Step 2: orchestrator tests가 실패하는지 확인**

Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/collect-instagram/orchestrator_test.ts`

Expected: module과 함수가 없어 FAIL.

- [ ] **Step 3: 결과 타입과 bounded worker 구현**

`types.ts`에 다음 aggregate shape를 정의한다.

```ts
export interface AccountCollectionResult {
  sourceAccountId: string;
  status: "success" | "failed";
  errorCategory?: AccountFailureCategory;
  insertedPosts: number;
  updatedPosts: number;
  insertedSnapshots: number;
  assetsStored: number;
  assetsFailed: number;
}

export interface CollectionRunSummary {
  accountsRequested: number;
  accountsSuccess: number;
  accountsFailed: number;
  postsCreated: number;
  postsUpdated: number;
  snapshotsCreated: number;
  assetsStored: number;
  assetsFailed: number;
  accounts: AccountCollectionResult[];
}
```

`mapWithConcurrency`는 공유 index를 증가시키는 정확히 `min(limit, items.length)`개의 async worker를 만들고 결과 배열 index를 보존한다. orchestrator는 각 계정에 `AbortController` timeout을 만들고 `finally`에서 timer를 해제한다.

기존 `CollectInstagramDependencies`의 `username`은 다음 DB-derived account로 교체한다.

```ts
sourceAccount: SourceAccount;
```

collector는 `sourceAccount.username`으로 Meta를 조회하고 `sourceAccount.id`를 ingest repository에 전달한다.

- [ ] **Step 4: 계정별 오류 기록과 aggregate 구현**

Meta/validation/repository/unknown 오류를 safe category로 변환하고 `recordFailure`는 별도 `try/catch`로 호출한다. failure 기록 실패는 원래 account result를 덮어쓰지 않는다. 결과 배열은 DB username 정렬 순서를 보존한다.

- [ ] **Step 5: orchestrator와 기존 collector tests 실행**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test \
  functions/tests/collect-instagram/orchestrator_test.ts \
  functions/tests/collect-instagram/collector_test.ts
```

Expected: PASS.

- [ ] **Step 6: orchestrator 커밋**

```bash
git add supabase/functions/collect-instagram/orchestrator.ts \
  supabase/functions/collect-instagram/collector.ts \
  supabase/functions/collect-instagram/types.ts \
  supabase/functions/tests/collect-instagram/orchestrator_test.ts \
  supabase/functions/tests/collect-instagram/collector_test.ts
git commit -m "feat: isolate multi-account collection"
```

---

### Task 5: 다계정 HTTP API와 runtime wiring

**Files:**
- Modify: `supabase/functions/collect-instagram/config.ts`
- Modify: `supabase/functions/collect-instagram/handler.ts`
- Modify: `supabase/functions/collect-instagram/index.ts`
- Modify: `supabase/functions/tests/collect-instagram/config_test.ts`
- Modify: `supabase/functions/tests/collect-instagram/handler_test.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `runInstagramCollection`, `CollectionRunSummary`
- Produces: `POST /functions/v1/collect-instagram` aggregate API, optional `source_account_ids`

- [ ] **Step 1: request validation과 aggregate response failing tests 작성**

handler tests에 다음 body cases를 추가한다.

```ts
{ body: undefined, expectedIds: undefined }
{ body: { source_account_ids: [validUuid1, validUuid2] }, expectedIds: [validUuid1, validUuid2] }
```

빈 배열, 중복 UUID, 비문자열, 임의 key, malformed JSON은 400이며 collect를 호출하지 않는지 검증한다. 일부 계정 실패 summary도 HTTP 200으로 그대로 반환하고 log에는 account count와 safe category만 포함되는지 검증한다.

- [ ] **Step 2: handler tests가 실패하는지 확인**

Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/collect-instagram/handler_test.ts`

Expected: handler가 body와 aggregate 결과를 지원하지 않아 FAIL.

- [ ] **Step 3: config integer parser 테스트와 구현**

다음 환경 변수를 엄격한 integer로 읽는다.

```text
COLLECTOR_CONCURRENCY=2        # 1..3
COLLECTOR_ACCOUNT_BUDGET_MS=20000
COLLECTOR_RUN_BUDGET_MS=100000
```

0, 음수, 소수, 숫자가 아닌 값과 concurrency 4 이상을 configuration error로 거부하고 값 자체는 오류 메시지에 포함하지 않는다.

- [ ] **Step 4: handler와 index wiring 구현**

handler dependency는 다음 signature로 바꾼다.

```ts
collect: (
  collectedAt: Date,
  requestedSourceAccountIds?: string[],
) => Promise<CollectionRunSummary>;
```

`index.ts`의 `const username = "utdreport"`를 제거하고 repository, Meta client, orchestrator를 연결한다. account username은 반드시 `listActive()` 결과에서만 온다.

- [ ] **Step 5: API 문서와 env template 갱신**

README의 Milestone 2 단일 계정 설명을 M3 core 진행 상태로 변경하고 전체 active 호출과 3개 account ID 제한 호출 예시를 추가한다. 예시에는 placeholder secret만 사용한다.

- [ ] **Step 6: 전체 core 검증 실행**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno fmt --check functions
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno lint functions
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno check functions/collect-instagram/index.ts
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests
supabase db reset --local --yes
supabase test db --local
supabase db lint --local --schema public,app_private --level warning --fail-on warning
```

Expected: 모든 명령 exit 0, Deno 0 failed, pgTAP 0 failed, DB lint 0건.

- [ ] **Step 7: core slice 커밋**

```bash
git add .env.example README.md supabase/functions/collect-instagram \
  supabase/functions/tests/collect-instagram
git commit -m "feat: expose multi-account collector"
```

## Core 계획 완료 게이트

- [ ] 모든 active 계정이 DB에서 로드된다.
- [ ] concurrency 2와 계정별 timeout이 테스트로 증명된다.
- [ ] 한 계정 실패 뒤 다른 계정 commit이 유지된다.
- [ ] raw post는 중복 없이 갱신된다.
- [ ] 최초 snapshot과 cadence snapshot이 함께 보호된다.
- [ ] 같은 30분 bucket 재시도가 중복 snapshot을 만들지 않는다.
- [ ] 외부 caller가 username을 지정할 수 없다.
- [ ] Deno, pgTAP, format, lint, type-check, DB lint가 모두 통과한다.
