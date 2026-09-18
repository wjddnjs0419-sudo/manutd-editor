# Milestone 4.5 Notion Editorial Sync Implementation Plan

> 승인된 M4.5 설계를 그대로 구현한다. 작업은 isolated branch에서 Task별 RED →
> GREEN → focused regression → commit 순서로 실행한다.

**Goal:** Supabase canonical curated intelligence를 stable identity와 private sync
state를 사용해 Notion `📡 Daily Intelligence`로 reliable/idempotent projection한다.

**Architecture:** n8n은 마지막 Edge Function invoke만 담당하고,
`sync-notion-intelligence`가 canonical query, deterministic mapper/hash, Notion API
client, lifecycle, retry, failure isolation, sync-state persistence를 담당한다.

**Tech Stack:** Supabase Postgres/pgTAP, Supabase Edge Functions, Deno 2.1.4,
TypeScript strict mode, `@supabase/supabase-js` 2.116.0, Notion REST API, n8n JSON.

**Spec:** `docs/superpowers/specs/2026-09-18-milestone-4-5-notion-sync-design.md`

## Global constraints

- Supabase가 canonical source of truth다.
- identity는 `story_cluster_id + ranking_date`다.
- system-owned allowlist만 Notion mutation payload에 포함한다.
- human-owned fields는 create/update 모두 보존한다.
- candidate page 삭제는 하지 않는다.
- Notion sync failure는 candidate-level downstream failure다.
- secret/raw Notion response/error body를 log, response, snapshot, workflow에 남기지 않는다.
- main에는 구현하지 않는다.

## Task 1 — Notion contract와 private sync state

**Files:**

- Create migration `supabase/migrations/20260918170000_milestone_4_5_notion_sync.sql`
- Create pgTAP `supabase/tests/database/009_m4_5_notion_sync_test.sql`
- Update `.env.example`, local configuration docs as needed

**RED:** pgTAP으로 private table, primary identity, required columns, RLS,
public/anon/authenticated revoke, service-role-only access와 duplicate identity
constraint를 먼저 검증해 migration 부재로 실패시킨다.

**GREEN:** `app_private.notion_sync_state`와 exact constraints/policies를 추가한다.
schema는 API exposed list에 넣지 않으며 `sync_identity`를 primary key로 둔다.

**Verify/commit:** `supabase db reset --local`, focused pgTAP, full pgTAP, DB lint.
Commit: `feat: add notion sync state`.

## Task 2 — deterministic candidate mapper와 canonical hash

**Files:**

- Create `supabase/functions/notion-sync/types.ts`
- Create `supabase/functions/notion-sync/mapper.ts`
- Create `supabase/functions/tests/notion-sync/mapper_test.ts`

**RED:** mapper 부재 상태에서 system allowlist, human-field exclusion, property
mapping, body evidence, object property order stability, semantic value change
sensitivity를 검증한다.

**GREEN:** candidate/cluster/reference input을 deterministic Notion property/body
payload로 만들고 stable canonical JSON SHA-256 hash를 반환한다. title은 canonical
cluster title 또는 representative title만 사용한다.

**Verify/commit:** focused Deno tests와 type check. Commit:
`feat: add deterministic notion mapping`.

## Task 3 — Notion API client, retry, safe errors

**Files:**

- Create `supabase/functions/notion-sync/notion_client.ts`
- Create `supabase/functions/tests/notion-sync/notion_client_test.ts`

**RED:** 429/Retry-After, 5xx, network timeout, 400/401/403, malformed response,
bounded attempts, timeout, secret non-leakage 테스트를 먼저 작성한다.

**GREEN:** fetch adapter를 주입 가능한 client로 구현한다. retryable status와
network error만 bounded exponential retry하며, permanent contract/auth failure는
safe categorized error로 반환한다. full response body는 버린다.

**Verify/commit:** focused Deno tests. Commit: `feat: add notion api client`.

## Task 4 — sync Edge Function orchestration

**Files:**

- Create `supabase/functions/sync-notion-intelligence/index.ts`
- Create `supabase/functions/sync-notion-intelligence/config.ts`
- Create `supabase/functions/sync-notion-intelligence/repository.ts`
- Create `supabase/functions/sync-notion-intelligence/orchestrator.ts`
- Create `supabase/functions/tests/notion-sync/orchestrator_test.ts`
- Create `supabase/functions/tests/notion-sync/handler_test.ts`
- Update `supabase/config.toml` function contract

**RED:** auth, canonical ranking date, curated filter, CREATE/UPDATE/NOOP, lifecycle,
state persistence, candidate isolation, aggregate summary test부터 작성한다.

**GREEN:** service-role Supabase client로 candidates/clusters/references를 query하고,
state/hash 비교 후 create/update/noop을 실행한다. dropped/expired page는 update하고
Notion page를 삭제하지 않는다. candidate failure는 집계 후 계속 진행한다. response는
safe summary만 반환한다.

**Verify/commit:** focused Deno tests, local function invocation contract, DB tests,
secret scan. Commit: `feat: add notion intelligence sync`.

## Task 5 — n8n integration

**Files:**

- Modify `n8n/workflows/instagram-collector-schedule.json`
- Modify `scripts/validate-n8n-workflow.mjs`
- Modify `scripts/validate-n8n-workflow.test.mjs`
- Modify `n8n/README.md`

**RED:** schedule → collector → intelligence → Notion Sync edge, upstream success
gates, continue-on-failure policy, invoke-only body, credential reference, and secret
marker rejection tests를 먼저 추가한다.

**GREEN:** Notion Sync HTTP node를 추가하되 workflow에 token/DB secret/candidate
payload를 저장하지 않는다. validator는 정확히 네 개 node와 연결/credential contract를
검증한다.

**Verify/commit:** validator tests와 workflow validator. Commit:
`feat: integrate notion sync workflow`.

## Task 6 — actual Notion smoke와 전체 regression

**Files:**

- Create `scripts/run-milestone-4-5-notion-smoke.sh`
- Create `scripts/verify-milestone-4-5-notion-smoke.sql` if needed
- Update README with local/secret/smoke instructions
- Add integration tests/fixtures only where non-destructive

**RED/GREEN:** safe local candidate fixture로 TOP 3~5를 sync한다. first run CREATE,
same run NOOP, controlled system value UPDATE, human-owned property preservation,
one controlled candidate failure isolation, lifecycle projection, duplicate absence,
secret/log scan, actual page readback을 증명한다.

**Verify:** full pgTAP, Deno, DB lint, n8n validator/tests, M4 scoring smoke with
fixture path, M4.5 tests/integration, actual Notion smoke. Production canonical score를
훼손하지 않는다.

**Commit:** `test: verify milestone 4.5 notion sync`.

## Completion checklist

- [ ] Task 1~6 separate commits
- [ ] design spec and plan committed
- [ ] Daily Intelligence DB ID captured in local secret environment only
- [ ] CREATE/UPDATE/NOOP/DROPPED/EXPIRED verified
- [ ] human-owned fields preserved
- [ ] n8n integration and safe logs verified
- [ ] actual Notion TOP candidate smoke verified
- [ ] full regression green and worktree clean
