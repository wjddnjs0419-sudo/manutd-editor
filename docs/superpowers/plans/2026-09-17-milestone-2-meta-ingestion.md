# Milestone 2 Meta Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify an atomic, idempotent Supabase Edge Function vertical slice that collects the latest `@utdreport` Instagram media through Meta Business Discovery and persists the account, raw posts, and first metric snapshots.

**Architecture:** The Deno Edge Function authenticates a dedicated collector bearer secret, fetches and strictly normalizes one complete Meta batch, then calls one `SECURITY INVOKER` Postgres RPC. The RPC locks the seeded source-account row and performs every database mutation in one transaction so retries cannot create duplicate posts or initial snapshots.

**Tech Stack:** Supabase CLI 2.117.0, Supabase Edge Runtime/Deno 2.1-compatible TypeScript, PostgreSQL 17 PL/pgSQL, PostgREST RPC, pgTAP, Docker

**Spec:** `docs/superpowers/specs/2026-09-17-milestone-2-meta-ingestion-design.md`

## Global Constraints

- The only account collected in Milestone 2 is `utdreport`.
- Do not implement the n8n workflow, scheduling, multi-account collection, pagination, carousel-child persistence, or later metric snapshots.
- n8n must never receive `SUPABASE_SERVICE_ROLE_KEY`; callers authenticate with `COLLECTOR_INVOKE_SECRET`.
- The RPC must be `SECURITY INVOKER`, use an empty search path and fully qualified names, revoke execution from `PUBLIC`, `anon`, and `authenticated`, and grant execution only to `service_role`.
- A malformed or unsupported post fails the whole Milestone 2 batch; preserve the normalizer boundary so Milestone 3 can quarantine individual rejected items.
- Never log or return authorization headers, Meta tokens, service-role keys, or complete upstream error bodies.
- Request `IMAGE`, `CAROUSEL_ALBUM`, and Reel (`VIDEO` plus `REELS`) media; Reel views remain nullable.
- Use tests first and observe each new test fail for the intended missing behavior before implementing it.

---

### Task 1: Atomic and service-role-only ingestion RPC

**Files:**
- Create: `supabase/tests/database/004_meta_ingest_rpc_test.sql`
- Create: `supabase/migrations/20260916184714_create_milestone_2_ingest_rpc.sql`

**Interfaces:**
- Consumes: seeded `public.source_accounts`, existing `public.raw_posts`, and existing `public.post_metric_snapshots`.
- Produces: `public.ingest_instagram_batch(p_username text, p_account jsonb, p_posts jsonb, p_collected_at timestamptz) returns jsonb`.

- [ ] **Step 1: Write the failing pgTAP contract**

Create a transaction-scoped test with literal image, carousel, and Reel fixtures. It must assert the exact function signature, `prosecdef = false`, `search_path = ''`, execution denied to `PUBLIC`/`anon`/`authenticated`, and execution allowed to `service_role`:

```sql
select ok(
  not exists (
    select 1
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.oid = 'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  )
  and not has_function_privilege('anon', 'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)', 'EXECUTE'),
  'only service_role can execute the ingest RPC'
);
```

Call the RPC twice and assert three distinct raw posts, three total initial snapshots, and SQL null Reel views in both tables. Submit a second batch containing one valid post followed by a negative metric, assert the statement throws, and assert the tentative account-ID change, valid post, and snapshot were all rolled back.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
supabase test db supabase/tests/database/004_meta_ingest_rpc_test.sql
```

Expected: FAIL because `public.ingest_instagram_batch` does not exist.

- [ ] **Step 3: Confirm the CLI-generated migration scaffold**

The required CLI command was run while preparing this plan so the plan can name an exact path. Confirm that `supabase/migrations/20260916184714_create_milestone_2_ingest_rpc.sql` exists and is empty before adding production SQL. If it is missing, recreate it with `supabase migration new create_milestone_2_ingest_rpc` and update this plan to the resulting path before continuing.

- [ ] **Step 4: Implement the minimal transactional RPC**

Implement this exact header and privilege boundary:

```sql
create or replace function public.ingest_instagram_batch(
  p_username text,
  p_account jsonb,
  p_posts jsonb,
  p_collected_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
-- fixed username and JSON validation
-- active source account SELECT ... FOR UPDATE
-- account update, raw-post upsert, missing-initial-snapshot insert
-- jsonb summary return
$$;

revoke all on function public.ingest_instagram_batch(text, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ingest_instagram_batch(text, jsonb, jsonb, timestamptz)
  to service_role;
```

Fully qualify every `public.` and `pg_catalog.` object. Treat omitted nullable counts as SQL null; reject negative counts, duplicate IDs inside the RPC input, future publication timestamps, unsupported type/product combinations, and non-array post JSON. Return `account_id`, `inserted_posts`, `updated_posts`, and `inserted_snapshots`.

- [ ] **Step 5: Verify GREEN and run the full database suite**

```bash
supabase db reset --local
supabase test db supabase/tests/database/004_meta_ingest_rpc_test.sql
supabase test db
```

Expected: focused and complete pgTAP suites pass with zero failures.

- [ ] **Step 6: Commit the database slice**

```bash
git add supabase/migrations supabase/tests/database/004_meta_ingest_rpc_test.sql
git commit -m "feat: add atomic Instagram ingest RPC"
```

---

### Task 2: Strict normalization and collector orchestration

**Files:**
- Create: `supabase/functions/deno.json`
- Create: `supabase/functions/collect-instagram/types.ts`
- Create: `supabase/functions/collect-instagram/normalizer.ts`
- Create: `supabase/functions/collect-instagram/collector.ts`
- Create: `supabase/functions/tests/collect-instagram/normalizer_test.ts`
- Create: `supabase/functions/tests/collect-instagram/collector_test.ts`

**Interfaces:**
- Consumes: `MetaClient.fetchAccount(username)` and `IngestRepository.ingest(batch)`.
- Produces: `normalizeBusinessDiscovery(payload, expectedUsername, collectedAt): NormalizedBatch` and `collectInstagram(deps): Promise<CollectionSummary>`.

- [ ] **Step 1: Add the dependency-free Deno configuration**

```json
{
  "compilerOptions": { "lib": ["deno.ns", "dom", "dom.iterable"], "strict": true },
  "tasks": { "test": "deno test tests" }
}
```

Tests import `node:assert/strict`, avoiding third-party runtime dependencies.

- [ ] **Step 2: Write normalization tests first**

Use complete literal Meta fixtures and hand-derived expectations for image, carousel, Reel, null Reel views, post age, raw payload preservation, and capability flags:

```typescript
assert.deepEqual(batch.posts.map((post) => [post.externalPostId, post.mediaType, post.mediaProductType]), [
  ['image-1', 'IMAGE', null],
  ['carousel-1', 'CAROUSEL_ALBUM', null],
  ['reel-1', 'VIDEO', 'REELS'],
]);
assert.equal(batch.posts[2].viewCount, null);
assert.equal(batch.posts[2].postAgeMinutes, 90);
```

Separate tests must prove duplicate IDs collapse, a mismatched username fails, a negative count fails, an unsupported `VIDEO` product fails, a future timestamp fails, and one malformed item rejects the complete batch with only safe item/field context.

- [ ] **Step 3: Run normalization tests and verify RED**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 \
  deno test functions/tests/collect-instagram/normalizer_test.ts
```

Expected: FAIL because the production modules do not exist.

- [ ] **Step 4: Implement types and the minimal strict normalizer**

Define `NormalizedAccount`, `NormalizedPost`, `NormalizedBatch`, `MetaClient`, `IngestRepository`, `IngestResult`, and `CollectionSummary`. The post contract includes:

```typescript
export interface NormalizedPost {
  externalPostId: string;
  caption: string | null;
  permalink: string | null;
  mediaType: 'IMAGE' | 'CAROUSEL_ALBUM' | 'VIDEO';
  mediaProductType: 'REELS' | null;
  publishedAt: string;
  likeCount: number | null;
  commentsCount: number | null;
  viewCount: number | null;
  followersCountAtCollection: number | null;
  postAgeMinutes: number;
  rawPayload: Record<string, unknown>;
}
```

Normalize Meta `views` to `viewCount`, preserve a missing value as null, and retain the first occurrence when an ID repeats. Throw a typed `ValidationError` without embedding the raw payload.

- [ ] **Step 5: Run normalization tests and verify GREEN**

Run the same focused command and confirm all normalization behaviors pass.

- [ ] **Step 6: Write collector tests first**

Use narrow in-memory fakes and assert the collector result and saved batch. Cover success, Meta failure without repository use, validation failure without repository use, and safe repository failure propagation:

```typescript
const result = await collectInstagram({
  username: 'utdreport',
  collectedAt: new Date('2026-09-17T00:30:00Z'),
  metaClient,
  repository,
});
assert.equal(result.username, 'utdreport');
assert.equal(savedBatches.length, 1);
assert.equal(savedBatches[0].posts.length, 3);
```

- [ ] **Step 7: Run collector tests RED, implement minimal orchestration, then verify GREEN**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 \
  deno test functions/tests/collect-instagram/collector_test.ts
```

Implement only `fetchAccount -> normalizeBusinessDiscovery -> repository.ingest -> summary`, then run both Task 2 test files.

- [ ] **Step 8: Commit the application slice**

```bash
git add supabase/functions/deno.json supabase/functions/collect-instagram \
  supabase/functions/tests/collect-instagram/normalizer_test.ts \
  supabase/functions/tests/collect-instagram/collector_test.ts
git commit -m "feat: normalize Meta media batches"
```

---

### Task 3: Retryable Meta client and idempotent RPC repository

**Files:**
- Create: `supabase/functions/collect-instagram/meta_client.ts`
- Create: `supabase/functions/collect-instagram/repository.ts`
- Create: `supabase/functions/tests/collect-instagram/meta_client_test.ts`
- Create: `supabase/functions/tests/collect-instagram/repository_test.ts`

**Interfaces:**
- Consumes: injected `fetch`, sleep, random, Meta configuration, Supabase URL, and service-role key.
- Produces: `createMetaClient(config): MetaClient` and `createIngestRepository(config): IngestRepository`.

- [ ] **Step 1: Write Meta client tests first**

Exercise the real URL/request builder with injected fetch. Assert decoded success; three total attempts for `429`, `5xx`, and network failures; `Retry-After` delay precedence; one attempt for `400`/`401`; and safe errors that omit the access token and raw body.

```typescript
assert.equal(requestedUrl.origin, 'https://graph.facebook.com');
assert.equal(requestedUrl.pathname, '/v99.0/business-account-id');
assert.match(requestedUrl.searchParams.get('fields')!, /business_discovery\.username\(utdreport\)/);
assert.equal(attempts, 3);
```

- [ ] **Step 2: Run Meta tests RED, implement the client, then verify GREEN**

Run the focused Deno container command. Implement a bounded media limit and a fields query for account ID, username, followers, and media ID/caption/permalink/timestamp/type/product type/likes/comments/views. Retry only thrown network errors, `429`, and `5xx`; use valid `Retry-After` before exponential delay plus injected jitter. Parse JSON defensively and emit safe normalized errors. Rerun the test until it passes.

- [ ] **Step 3: Write repository tests first**

Test the real PostgREST request builder through injected fetch:

```typescript
assert.equal(url, `${supabaseUrl}/rest/v1/rpc/ingest_instagram_batch`);
assert.equal(init.method, 'POST');
assert.equal(init.headers.apikey, serviceRoleKey);
assert.equal(init.headers.Authorization, `Bearer ${serviceRoleKey}`);
assert.deepEqual(JSON.parse(init.body), {
  p_username: 'utdreport',
  p_account: expectedAccount,
  p_posts: expectedPosts,
  p_collected_at: '2026-09-17T00:30:00.000Z',
});
```

Prove one retry for network/`5xx` ambiguity, no retry for `4xx`, typed summary decoding, and key/body redaction from errors.

- [ ] **Step 4: Run repository tests RED, implement the adapter, then verify GREEN**

Use direct `fetch` to PostgREST without a runtime package. Retry once only for network errors and `5xx`. Return the typed summary and discard raw database details from caller-visible errors. Run both Task 3 files:

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 \
  deno test functions/tests/collect-instagram/meta_client_test.ts \
  functions/tests/collect-instagram/repository_test.ts
```

- [ ] **Step 5: Commit the adapters**

```bash
git add supabase/functions/collect-instagram/meta_client.ts \
  supabase/functions/collect-instagram/repository.ts \
  supabase/functions/tests/collect-instagram/meta_client_test.ts \
  supabase/functions/tests/collect-instagram/repository_test.ts
git commit -m "feat: add Meta and ingest adapters"
```

---

### Task 4: Authenticated Edge Function entrypoint and documentation

**Files:**
- Create: `supabase/functions/collect-instagram/handler.ts`
- Create: `supabase/functions/collect-instagram/index.ts`
- Create: `supabase/functions/tests/collect-instagram/handler_test.ts`
- Modify: `supabase/config.toml`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `Authorization: Bearer <COLLECTOR_INVOKE_SECRET>` and environment configuration.
- Produces: an HTTP `POST /functions/v1/collect-instagram` service-to-service endpoint with safe JSON results and errors.

- [ ] **Step 1: Write handler tests first**

Test the exported handler with an injected collector. Cover `405` for non-POST, `401` for absent/malformed/wrong bearer credentials, success for the exact secret, safe `502` for Meta failure, safe `500` for database failure, and omission of every supplied secret from response bodies. Prove unauthorized requests do not invoke the collector.

```typescript
const response = await handler(new Request(url, {
  method: 'POST',
  headers: { Authorization: 'Bearer collector-secret' },
}));
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), expectedSummary);
```

- [ ] **Step 2: Run handler tests and verify RED**

Run the focused Deno container command. Expected: FAIL because the handler does not exist.

- [ ] **Step 3: Implement timing-safe authentication and safe error mapping**

Hash both bearer values with `crypto.subtle.digest('SHA-256', ...)`, compare every digest byte without early return, and authenticate before any external dependency call. Generate a request ID with `crypto.randomUUID()`. Log only the request ID, safe error code, username, attempt count, and aggregate counts.

- [ ] **Step 4: Implement environment wiring**

`index.ts` requires the following and never logs their values:

```text
COLLECTOR_INVOKE_SECRET
META_ACCESS_TOKEN
META_BUSINESS_ACCOUNT_ID
META_API_VERSION
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Wire the real adapters into `Deno.serve`, fix the username to `utdreport`, and keep the media limit bounded.

- [ ] **Step 5: Configure custom service authentication**

Append:

```toml
[functions.collect-instagram]
verify_jwt = false
```

This disables only the gateway JWT check. The handler bearer-secret check remains mandatory.

- [ ] **Step 6: Verify GREEN across all Edge tests**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 \
  deno test functions/tests
```

Expected: zero failures.

- [ ] **Step 7: Update operator documentation**

Replace ambiguous legacy Meta names in `.env.example` with the six required variables while retaining unrelated future-service entries. Update `README.md` with architecture, supported media, RPC atomicity/idempotency, service-role isolation from n8n, local secret setup and invocation, test commands, the M2 fail-fast limitation, and the M3 quarantine/n8n boundary.

- [ ] **Step 8: Commit the endpoint and docs**

```bash
git add supabase/functions/collect-instagram/handler.ts \
  supabase/functions/collect-instagram/index.ts \
  supabase/functions/tests/collect-instagram/handler_test.ts \
  supabase/config.toml .env.example README.md
git commit -m "feat: expose authenticated Instagram collector"
```

---

### Task 5: Full local verification and real smoke test

**Files:**
- Modify only when verification exposes a tested defect in files owned by Tasks 1-4.

**Interfaces:**
- Consumes: local Docker/Supabase and approved environment secrets.
- Produces: fresh evidence for schema, unit, local HTTP, and real collection behavior.

- [ ] **Step 1: Run complete formatting, lint, and Edge tests**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno fmt --check functions
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno lint functions
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4 deno test functions/tests
```

- [ ] **Step 2: Rebuild and test the complete local database**

```bash
supabase db reset --local
supabase test db
supabase db lint --local --schema public,app_private --level warning
supabase migration list --local
```

Expected: reset succeeds, all pgTAP tests pass, no new actionable warning is introduced, and both migrations are applied.

- [ ] **Step 3: Exercise the locally served HTTP boundary**

Use an ignored `supabase/functions/.env.local`, then run:

```bash
supabase functions serve collect-instagram --env-file supabase/functions/.env.local
```

Invoke without the bearer secret and confirm `401`. Invoke with the secret and controlled invalid Meta credentials and confirm a safe upstream failure with no secret/token in response or logs.

- [ ] **Step 4: Run the real `@utdreport` smoke test**

Only when real secrets are present in the approved environment, invoke the function and verify:

```sql
select username, instagram_account_id, last_probe_at, probe_error
from public.source_accounts
where username = 'utdreport';

select count(*) as posts, count(distinct external_post_id) as distinct_external_posts
from public.raw_posts rp
join public.source_accounts sa on sa.id = rp.source_account_id
where sa.username = 'utdreport';

select count(*) as posts_without_snapshot
from public.raw_posts rp
join public.source_accounts sa on sa.id = rp.source_account_id
where sa.username = 'utdreport'
  and not exists (
    select 1 from public.post_metric_snapshots pms where pms.raw_post_id = rp.id
  );
```

Expected: real account ID is nonblank, post count equals distinct external-post count, and `posts_without_snapshot = 0`. Invoke again and verify retry alone does not increase post or initial-snapshot counts. If secrets are absent, report a credentials-only blocker without searching unapproved locations.

- [ ] **Step 5: Review diff and commit verification fixes**

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

If verification exposes a defect, first add a failing test, implement the minimum fix, rerun the full gate, and commit only verified files.
