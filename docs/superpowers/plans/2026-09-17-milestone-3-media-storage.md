# Milestone 3 Media Asset·Private Storage 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IMAGE, CAROUSEL child와 Reel thumbnail metadata를 정규화하고, core ingest 성공 후 private Supabase Storage에 원본 형식으로 멱등 저장한다.

**Architecture:** normalizer가 post와 함께 asset descriptor를 만든다. 모든 계정의 core ingest가 먼저 끝난 뒤 account ingest RPC가 반환한 raw post ID와 descriptor를 media work queue로 연결한다. prepare RPC가 pending asset row를 만들고 bounded media worker가 private bucket에 업로드하며 finalize RPC가 성공한 경로만 기록한다. 어떤 media 실패도 raw post나 metric transaction을 롤백하지 않는다.

**Tech Stack:** Supabase Storage, `@supabase/supabase-js@2.116.0`, Supabase Edge Functions, Deno 2.1.4, TypeScript, PostgreSQL, pgTAP

**Spec:** `docs/superpowers/specs/2026-09-17-milestone-3-multi-account-ingestion-design.md`

**Prerequisite:** `docs/superpowers/plans/2026-09-17-milestone-3-core-metrics.md`의 완료 게이트와 커밋이 먼저 충족돼야 한다.

## Global Constraints

- bucket 이름은 `instagram-analysis`이고 public access는 비활성화한다.
- upload 가능한 MIME type은 `image/jpeg`, `image/png`, `image/webp`, `image/gif`다.
- asset당 최대 크기는 20MiB다.
- media download concurrency는 2이며 무제한 `Promise.all`을 사용하지 않는다.
- IMAGE는 parent image, CAROUSEL_ALBUM은 child 순서, REELS는 thumbnail만 저장한다.
- Reel video binary는 다운로드하지 않는다.
- 이미지 format을 변환하거나 재인코딩하지 않는다.
- `width`, `height`, `sha256`는 검증된 값이 없으면 `NULL`이다.
- `retention_until = fetched_at + interval '30 days'`로 기록하되 자동 삭제는 구현하지 않는다.
- Storage failure는 core account 성공을 실패로 바꾸지 않는다.
- Storage secret, signed URL, upstream CDN query와 원문 오류는 로그에 남기지 않는다.
- dependency는 exact version으로 고정하고 lockfile을 커밋한다.

---

### Task 1: Media asset descriptor 정규화

**Files:**
- Modify: `supabase/functions/collect-instagram/types.ts`
- Modify: `supabase/functions/collect-instagram/normalizer.ts`
- Modify: `supabase/functions/tests/collect-instagram/normalizer_test.ts`

**Interfaces:**
- Consumes: Meta `media_url`, `thumbnail_url`, `children.data`
- Produces: `NormalizedMediaAsset`, `NormalizedPost.assets`

- [ ] **Step 1: IMAGE, carousel, Reel asset failing tests 작성**

기존 fixture에 실제 URL을 넣고 다음 shape를 검증한다.

```ts
assert.deepEqual(batch.posts[0].assets, [{
  externalMediaId: "image-1",
  assetType: "IMAGE",
  carouselIndex: null,
  originalMediaUrl: "https://cdn.example/image-1.jpg",
}]);

assert.deepEqual(batch.posts[1].assets, [
  {
    externalMediaId: "child-1",
    assetType: "CAROUSEL_CHILD",
    carouselIndex: 0,
    originalMediaUrl: "https://cdn.example/child-1.jpg",
  },
  {
    externalMediaId: "child-2",
    assetType: "CAROUSEL_CHILD",
    carouselIndex: 1,
    originalMediaUrl: "https://cdn.example/child-2.jpg",
  },
]);

assert.deepEqual(batch.posts[2].assets, [{
  externalMediaId: "reel-1",
  assetType: "THUMBNAIL",
  carouselIndex: null,
  originalMediaUrl: "https://cdn.example/reel-1.jpg",
}]);
```

Reel thumbnail, IMAGE URL, carousel child URL이 없거나 HTTPS가 아니면 해당 asset만 생략되고 core post 정규화는 성공하는지 검증한다. media caching은 auxiliary operation이므로 URL 문제로 account core batch를 실패시키지 않는다.

- [ ] **Step 2: normalizer test가 실패하는지 확인**

Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/collect-instagram/normalizer_test.ts`

Expected: `assets`가 없어 FAIL.

- [ ] **Step 3: descriptor 타입과 최소 정규화 구현**

`types.ts`에 다음 타입을 추가한다.

```ts
export type MediaAssetType = "IMAGE" | "CAROUSEL_CHILD" | "THUMBNAIL";

export interface NormalizedMediaAsset {
  externalMediaId: string;
  assetType: MediaAssetType;
  carouselIndex: number | null;
  originalMediaUrl: string;
}
```

`NormalizedPost`에 `assets: NormalizedMediaAsset[]`를 추가한다. URL은 `new URL()`로 parse한 뒤 protocol이 정확히 `https:`인 값만 descriptor로 만든다. 누락되거나 안전하지 않은 URL은 asset 배열에서 생략한다. query를 제거하거나 변형하지 않고 원본 URL을 descriptor에 보존하되 로그에는 전달하지 않는다.

- [ ] **Step 4: normalizer와 collector tests 실행**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test \
  functions/tests/collect-instagram/normalizer_test.ts \
  functions/tests/collect-instagram/collector_test.ts
```

Expected: PASS.

- [ ] **Step 5: descriptor 커밋**

```bash
git add supabase/functions/collect-instagram/types.ts \
  supabase/functions/collect-instagram/normalizer.ts \
  supabase/functions/tests/collect-instagram/normalizer_test.ts \
  supabase/functions/tests/collect-instagram/collector_test.ts
git commit -m "feat: normalize Instagram media assets"
```

---

### Task 2: Private bucket과 asset prepare/finalize DB 계약

**Files:**
- Modify: `supabase/config.toml`
- Create: `supabase/tests/database/006_media_asset_storage_test.sql`
- Create via CLI: `supabase migration new milestone_3_media_assets`
- Modify generated file: `supabase/migrations/*_milestone_3_media_assets.sql` (`supabase migration new`의 단일 출력)

**Interfaces:**
- Consumes: core plan의 `IngestedPost.rawPostId`, 기존 `public.media_assets`
- Produces: `public.prepare_instagram_media_assets(uuid, jsonb) -> jsonb`, `public.finalize_instagram_media_assets(uuid, jsonb) -> jsonb`, private bucket config

- [ ] **Step 1: asset RPC failing pgTAP 작성**

core RPC로 IMAGE, CAROUSEL, REEL post를 만든 뒤 `prepare_instagram_media_assets`를 호출한다.

```sql
select public.prepare_instagram_media_assets(
  (select id from public.source_accounts where username = 'utdreport'),
  jsonb_build_array(
    jsonb_build_object(
      'raw_post_id', (select id from public.raw_posts where external_post_id = 'image-1'),
      'external_media_id', 'image-1',
      'asset_type', 'IMAGE',
      'carousel_index', null,
      'original_media_url', 'https://cdn.example/image-1.jpg'
    )
  )
);
```

다음을 검증한다.

- metadata row가 한 번만 생성된다.
- 같은 descriptor 재실행은 row를 늘리지 않고 URL만 최신값으로 갱신한다.
- 다른 source account의 raw post ID는 거부한다.
- unsupported asset type, 음수 index, 빈 external ID, HTTP URL을 거부한다.
- storage_path가 있는 row는 prepare 결과의 pending 목록에서 제외된다.
- finalize는 `storage_path`, `mime_type`, `fetched_at`, `retention_until = fetched_at + 30 days`를 기록한다.
- finalize가 다른 계정의 asset ID를 갱신하지 못한다.
- client roles는 두 RPC를 실행할 수 없다.

- [ ] **Step 2: 새 pgTAP이 실패하는지 확인**

Run: `supabase test db --local supabase/tests/database/006_media_asset_storage_test.sql`

Expected: 두 RPC가 없어 FAIL.

- [ ] **Step 3: CLI migration 생성과 local bucket 선언**

```bash
supabase migration new milestone_3_media_assets
```

`supabase/config.toml`에 다음을 추가한다.

```toml
[storage.buckets.instagram-analysis]
public = false
file_size_limit = "20MiB"
allowed_mime_types = ["image/jpeg", "image/png", "image/webp", "image/gif"]
```

bucket은 `supabase seed buckets --local`과 배포 시 `--linked`로 생성한다. bucket 정의는 코드와 함께 version control한다.

- [ ] **Step 4: prepare/finalize RPC 구현**

prepare 입력은 descriptor 배열이며 결과는 pending asset만 반환한다.

```json
{
  "pending": [
    {
      "media_asset_id": "uuid",
      "raw_post_id": "uuid",
      "external_media_id": "image-1",
      "asset_type": "IMAGE",
      "original_media_url": "https://cdn.example/image-1.jpg"
    }
  ]
}
```

finalize 입력은 성공한 upload만 받는다.

```json
[
  {
    "media_asset_id": "uuid",
    "storage_path": "instagram/account/post/image-1.jpg",
    "mime_type": "image/jpeg",
    "fetched_at": "2026-09-17T03:00:00Z"
  }
]
```

두 RPC 모두 source account ID와 raw post ownership을 재검증하며 `SECURITY INVOKER`, service-role 전용 grant를 사용한다. `original_media_url`이나 `storage_path`는 빈 문자열을 거부한다.

- [ ] **Step 5: bucket seed와 DB 검증 실행**

```bash
supabase stop
supabase start
supabase seed buckets --local
supabase db reset --local --yes
supabase test db --local
supabase db lint --local --schema public,app_private --level warning --fail-on warning
```

Expected: `instagram-analysis` bucket이 private/20MiB/허용 MIME 설정으로 존재하고 pgTAP, lint가 PASS.

- [ ] **Step 6: DB와 bucket 계약 커밋**

```bash
git add supabase/config.toml supabase/migrations/*_milestone_3_media_assets.sql \
  supabase/tests/database/006_media_asset_storage_test.sql
git commit -m "feat: prepare private media assets"
```

---

### Task 3: Storage adapter와 dependency 고정

**Files:**
- Modify: `supabase/functions/deno.json`
- Create: `supabase/functions/deno.lock`
- Create: `supabase/functions/collect-instagram/media_storage.ts`
- Create: `supabase/functions/tests/collect-instagram/media_storage_test.ts`

**Interfaces:**
- Consumes: `PendingMediaAsset`, Supabase secret key, `instagram-analysis` bucket
- Produces: `MediaStorage.store(asset, context) -> Promise<StoredMediaAsset>`

- [ ] **Step 1: download validation과 deterministic path failing tests 작성**

fake fetch와 fake Supabase Storage client로 다음을 검증한다.

```ts
const stored = await storage.store(asset, {
  sourceAccountId: "account-id",
  externalPostId: "post-id",
  fetchedAt: new Date("2026-09-17T03:00:00Z"),
  signal: AbortSignal.timeout(5_000),
});

assert.deepEqual(stored, {
  mediaAssetId: asset.mediaAssetId,
  storagePath: "instagram/account-id/post-id/image-1.jpg",
  mimeType: "image/jpeg",
  fetchedAt: "2026-09-17T03:00:00.000Z",
});
```

다음 실패를 각각 safe `MediaStorageError`로 검증한다.

- non-2xx download
- HTTPS 외 URL
- MIME allow-list 밖 응답
- `Content-Length`가 20MiB 초과
- body를 읽은 실제 byte 길이가 20MiB 초과
- timeout/abort
- Storage upload 오류

이미 존재하는 deterministic path의 duplicate 오류는 성공으로 간주하는 테스트도 작성한다.

- [ ] **Step 2: media storage test가 실패하는지 확인**

Run: `docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/collect-instagram/media_storage_test.ts`

Expected: module이 없어 FAIL.

- [ ] **Step 3: Supabase client exact version과 lockfile 설정**

`supabase/functions/deno.json`에 다음 import를 추가한다.

```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2.116.0"
  }
}
```

- [ ] **Step 4: Storage adapter 최소 구현**

`types.ts` 또는 `media_storage.ts`에 다음 경계 타입을 정확히 정의한다.

```ts
export interface PendingMediaAsset {
  mediaAssetId: string;
  rawPostId: string;
  externalMediaId: string;
  assetType: MediaAssetType;
  originalMediaUrl: string;
}

export interface StoredMediaAsset {
  mediaAssetId: string;
  storagePath: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  fetchedAt: string;
}

export interface MediaStorage {
  store(
    asset: PendingMediaAsset,
    context: {
      sourceAccountId: string;
      externalPostId: string;
      fetchedAt: Date;
      signal: AbortSignal;
    },
  ): Promise<StoredMediaAsset>;
}
```

파일 확장자는 검증된 MIME으로만 결정한다.

```ts
const extensionByMime = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;
```

path segment는 UUID와 Meta media ID 허용문자만 받으며 `/`, `..`, percent-encoded slash를 거부한다. upload option은 다음과 같다.

```ts
{
  contentType: mimeType,
  cacheControl: "2592000",
  upsert: false,
}
```

`MediaStorageError`에는 `category`, `statusClass`, `retriable`만 보관하고 원문 URL/error message는 포함하지 않는다.

- [ ] **Step 5: Storage adapter tests와 type-check 실행**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace/functions \
  denoland/deno:2.1.4 deno cache --lock=deno.lock collect-instagram/media_storage.ts
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test functions/tests/collect-instagram/media_storage_test.ts
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno check functions/collect-instagram/media_storage.ts
```

Expected: PASS.

- [ ] **Step 6: Storage adapter 커밋**

```bash
git add supabase/functions/deno.json supabase/functions/deno.lock \
  supabase/functions/collect-instagram/media_storage.ts \
  supabase/functions/tests/collect-instagram/media_storage_test.ts
git commit -m "feat: upload private Instagram assets"
```

---

### Task 4: Asset repository와 auxiliary coordinator

**Files:**
- Create: `supabase/functions/collect-instagram/media_cache.ts`
- Create: `supabase/functions/tests/collect-instagram/media_cache_test.ts`
- Modify: `supabase/functions/collect-instagram/orchestrator.ts`
- Modify: `supabase/functions/collect-instagram/repository.ts`
- Modify: `supabase/functions/collect-instagram/types.ts`
- Modify: `supabase/functions/tests/collect-instagram/repository_test.ts`
- Modify: `supabase/functions/collect-instagram/collector.ts`
- Modify: `supabase/functions/tests/collect-instagram/collector_test.ts`
- Modify: `supabase/functions/tests/collect-instagram/orchestrator_test.ts`

**Interfaces:**
- Consumes: core `IngestResult.posts`, normalized descriptors, prepare/finalize RPC, `MediaStorage`
- Produces: `cacheMediaAssets(options) -> Promise<{ assetsStored; assetsFailed }>`

- [ ] **Step 1: repository prepare/finalize failing tests 작성**

다음 method와 exact RPC body를 검증한다.

```ts
const pending = await repository.prepareMediaAssets(sourceAccountId, descriptors);
await repository.finalizeMediaAssets(sourceAccountId, [storedAsset]);
```

malformed pending response, 잘못된 UUID, duplicate media asset ID는 `DATABASE_INVALID_RESPONSE`로 거부하는 테스트를 포함한다.

- [ ] **Step 2: media cache isolation failing tests 작성**

3개 pending asset 중 하나의 download가 실패해도 나머지 두 개를 finalize하고 다음 summary를 반환하는지 검증한다.

```ts
assert.deepEqual(result, { assetsStored: 2, assetsFailed: 1 });
assert.equal(finalized.length, 2);
assert.equal(maxObservedConcurrency, 2);
```

prepare RPC 실패는 media summary 실패로만 반환하고 이미 완료된 core ingest result를 버리지 않는 orchestrator test를 작성한다. 느린 media worker가 있어도 모든 계정의 core worker가 먼저 끝났다는 event 순서를 assertion한다.

- [ ] **Step 3: repository와 coordinator tests가 실패하는지 확인**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test \
  functions/tests/collect-instagram/repository_test.ts \
  functions/tests/collect-instagram/media_cache_test.ts \
  functions/tests/collect-instagram/collector_test.ts \
  functions/tests/collect-instagram/orchestrator_test.ts
```

Expected: method와 coordinator가 없어 FAIL.

- [ ] **Step 4: asset repository와 media coordinator 구현**

`cacheMediaAssets`는 raw post mapping에 없는 descriptor를 안전 실패로 세고, 최대 `mediaLimitPerRun`개 pending asset만 concurrency 2로 실행한다. 각 upload를 개별 `try/catch`로 격리하고 성공 목록만 finalize RPC에 보낸다.

repository의 media interface는 다음 signature를 사용한다.

```ts
prepareMediaAssets(
  sourceAccountId: string,
  assets: Array<{
    rawPostId: string;
    externalMediaId: string;
    assetType: MediaAssetType;
    carouselIndex: number | null;
    originalMediaUrl: string;
  }>,
): Promise<PendingMediaAsset[]>;

finalizeMediaAssets(
  sourceAccountId: string,
  assets: StoredMediaAsset[],
): Promise<number>;
```

collector는 core 성공 뒤 외부 응답에 노출하지 않는 media work item을 반환한다.

```ts
const persisted = await repository.ingest(sourceAccount.id, batch);
return {
  summary: coreSummary,
  mediaWork: {
    sourceAccountId: sourceAccount.id,
    batch,
    ingestedPosts: persisted.posts,
  },
};
```

orchestrator는 모든 account core worker가 완료된 뒤 성공한 `mediaWork`만 모아 다음 두 번째 phase를 실행한다.

```ts
const coreResults = await runCoreAccounts();
const media = await cacheMediaAssets({
  workItems: coreResults.flatMap((result) => result.mediaWork ?? []),
  repository: dependencies.repository,
  storage: dependencies.mediaStorage,
  concurrency: dependencies.mediaConcurrency,
  limit: dependencies.mediaLimitPerRun,
  deadlineAt: runStartedAt + dependencies.runBudgetMs,
});
return mergeMediaCounts(coreResults, media);
```

media 단계에서 어떤 예외가 나도 core count와 account success는 그대로 반환한다. 남은 run budget이 없으면 upload를 시작하지 않고 pending asset은 다음 schedule에 남긴다.

- [ ] **Step 5: media tests 실행**

Run: 이전 Step 3의 세 테스트 파일.

Expected: PASS, 2 stored/1 failed와 concurrency 2 확인.

- [ ] **Step 6: auxiliary media pipeline 커밋**

```bash
git add supabase/functions/collect-instagram/media_cache.ts \
  supabase/functions/collect-instagram/collector.ts \
  supabase/functions/collect-instagram/orchestrator.ts \
  supabase/functions/collect-instagram/repository.ts \
  supabase/functions/collect-instagram/types.ts \
  supabase/functions/tests/collect-instagram/media_cache_test.ts \
  supabase/functions/tests/collect-instagram/collector_test.ts \
  supabase/functions/tests/collect-instagram/orchestrator_test.ts \
  supabase/functions/tests/collect-instagram/repository_test.ts
git commit -m "feat: isolate media asset caching"
```

---

### Task 5: Runtime wiring과 local Storage integration

**Files:**
- Modify: `supabase/functions/collect-instagram/config.ts`
- Modify: `supabase/functions/collect-instagram/index.ts`
- Modify: `supabase/functions/tests/collect-instagram/config_test.ts`
- Create: `supabase/functions/tests/integration/media_storage_integration_test.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `SUPABASE_URL`, `SUPABASE_SECRET_KEYS` 또는 `SUPABASE_SECRET_KEY`, bucket config
- Produces: 실행당 asset 상한이 적용된 실제 Storage pipeline

- [ ] **Step 1: media config failing tests 작성**

다음 설정을 검증한다.

```text
MEDIA_STORAGE_BUCKET=instagram-analysis
MEDIA_DOWNLOAD_CONCURRENCY=2
MEDIA_ASSETS_PER_RUN=20
MEDIA_MAX_BYTES=20971520
```

bucket 이름이 `instagram-analysis`와 다르거나 concurrency가 1..2 밖, asset limit이 1..100 밖, max bytes가 20MiB를 넘으면 configuration error를 발생시키는 테스트를 작성한다.

- [ ] **Step 2: config와 index wiring 구현**

`createClient(SUPABASE_URL, resolvedSecretKey)`로 server-side client를 한 번 생성하고 Storage adapter에 주입한다. secret은 log나 error object에 포함하지 않는다. orchestrator account result의 `assetsStored/assetsFailed`와 top-level aggregate를 연결한다.

- [ ] **Step 3: 실제 local Storage integration test 작성**

integration test는 env가 없으면 skip하지 않고 명시적 오류로 종료한다. test용 1x1 JPEG byte fixture를 local HTTP response로 제공하거나 fetch fake를 사용하되 upload는 실제 local Storage에 수행한다.

검증 항목:

- upload 후 private bucket object 존재
- 같은 path 두 번째 upload가 안전 성공
- object path와 DB `media_assets.storage_path` 일치
- public object URL GET은 성공하지 않음
- test가 만든 object와 row만 `finally`에서 삭제

- [ ] **Step 4: local integration 실행**

secret 값을 출력하지 않는 shell에서 local env를 export한다.

```bash
set +x
eval "$(supabase status -o env)"
export SUPABASE_URL="http://host.docker.internal:55321"
export SUPABASE_SECRET_KEY="$SECRET_KEY"
supabase seed buckets --local
docker run --rm \
  -e SUPABASE_URL -e SUPABASE_SECRET_KEY \
  -v "$PWD/supabase:/workspace" -w /workspace \
  denoland/deno:2.1.4 deno test --allow-env --allow-net \
  functions/tests/integration/media_storage_integration_test.ts
```

Expected: PASS. 실행 로그에 key/token 값이 없어야 한다.

- [ ] **Step 5: 전체 media 검증 실행**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno fmt --check functions
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno lint functions
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno check functions/collect-instagram/index.ts
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests/collect-instagram
supabase db reset --local --yes
supabase seed buckets --local
supabase test db --local
supabase db lint --local --schema public,app_private --level warning --fail-on warning
```

Expected: 모든 명령 exit 0.

- [ ] **Step 6: runtime과 문서 커밋**

```bash
git add .env.example README.md supabase/functions/collect-instagram \
  supabase/functions/tests supabase/functions/deno.json supabase/functions/deno.lock
git commit -m "feat: cache Instagram assets privately"
```

## Media 계획 완료 게이트

- [ ] IMAGE, carousel child, Reel thumbnail descriptor가 정확하다.
- [ ] bucket은 private이고 MIME/20MiB 제한이 있다.
- [ ] Storage path는 결정적이며 duplicate retry가 안전하다.
- [ ] 원본 format을 변환하지 않는다.
- [ ] Storage 실패가 core ingest를 롤백하지 않는다.
- [ ] 성공 asset만 storage path와 30일 retention을 기록한다.
- [ ] local Storage integration과 전체 회귀 테스트가 통과한다.
