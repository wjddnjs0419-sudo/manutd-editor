# MU Instant Intelligence Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual n8n workflow and server-only Instant Telegram report path that reuses M6 behavior without changing the 09:00 Morning Brief contract.

**Architecture:** A new `telegram-instant-report` Edge Function composes and sends a source-tagged, request-idempotent report from current canonical data. Shared M6 reporting/context modules are extracted so Morning and Instant use the same candidate, media, phrasing, and rendering rules; a separate private persistence model protects Morning Brief daily snapshots. The n8n export remains orchestration-only and passes `$execution.id` as the Instant request id.

**Tech Stack:** Deno 2.1-compatible TypeScript, Supabase Edge Functions, PostgREST service-role access, PostgreSQL 17 migrations and pgTAP, Supabase private Storage signed URLs, Telegram Bot API, n8n workflow JSON, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-20-mu-instant-intelligence-run-design.md`

## Global Constraints

- Supabase remains canonical; n8n only orchestrates HTTP calls.
- The scheduled collector workflow is not modified to add manual behavior.
- The Morning Brief workflow and `telegram-morning-brief` daily dedupe remain intact.
- A new manual execution is allowed multiple times per day.
- A retry or duplicate delivery for the same `request_id` must not create another Instant report or resend delivery slots already recorded as sent.
- A new n8n Manual Execute receives a new execution id and is therefore a new report.
- Instant reports and Morning Briefs use separate persistence and explicit source/type metadata.
- `/open N` resolves the newest numbered report across both sources: the latest Instant report until a newer Morning Brief is sent, then the newer Morning Brief.
- Candidate ordering, representative reference selection, cached-media preference, signed URL generation, OpenAI phrasing, and deterministic fallback reuse existing M6 modules.
- Thumbnail delivery never depends directly on an expiring Instagram upstream URL.
- Partial collector failure, fixture refresh failure, Notion failure, phrasing failure, and signed-URL failure are isolated according to the existing M6 behavior.
- No credential value or secret is committed to workflow JSON, source code, test fixtures, or response payloads.
- New `app_private` tables enable RLS, revoke `public`, `anon`, and `authenticated`, and grant only `service_role`.
- Edge Function request authentication uses the existing `Telegram Agent Invoke Secret` credential reference.
- Repository workflow exports remain `active: false`; activation is an n8n deployment operation.

## Review Focus

- Same-day Morning Brief plus Instant report: Instant must send without changing Morning Brief dedupe; covered by Task 4 handler tests.
- Telegram failure after a partial report: already-sent delivery slots must not be resent; covered by Task 3 delivery repository tests.
- New Morning Brief after Instant: `/open N` must switch to the newer Morning snapshot; covered by Task 5 context resolver tests.
- Tied candidate scores and equal media confidence: order and representative post must remain deterministic; covered by Task 2 shared reporting tests.
- n8n export credential/body leakage: request id is an expression and secrets are absent; covered by Task 6 validator tests.

### Task 1: Add the private Instant report database contract

**Files:**
- Create via CLI: `supabase/migrations/<generated>_mu_instant_intelligence_run.sql`
- Test: `supabase/tests/database/014_mu_instant_intelligence_run_test.sql`
- Modify: `supabase/config.toml` only if the generated local schema requires an existing configuration entry

**Interfaces:**
- Produces `app_private.telegram_instant_reports` with unique `request_id` and `app_private.telegram_instant_report_deliveries` with unique `(report_id, slot)`.
- Later tasks depend on statuses `PENDING`, `SENDING`, `SENT`, `FAILED`, private-schema PostgREST access, and service-role-only grants.

- [ ] **Step 1: Create the migration shell with the Supabase CLI**

Run:

```bash
supabase migration new mu_instant_intelligence_run --workdir supabase
```

Use the generated timestamped path as the migration path in the remaining steps; do not hand-invent its filename.

- [ ] **Step 2: Write the failing pgTAP contract**

Create `supabase/tests/database/014_mu_instant_intelligence_run_test.sql` with this contract:

```sql
begin;
select plan(21);

select has_table('app_private', 'telegram_instant_reports', 'instant reports exist');
select has_table('app_private', 'telegram_instant_report_deliveries', 'instant delivery rows exist');
select has_column('app_private', 'telegram_instant_reports', 'request_id', 'request id exists');
select has_column('app_private', 'telegram_instant_reports', 'candidate_snapshot', 'snapshot exists');
select has_column('app_private', 'telegram_instant_reports', 'source', 'source exists');
select has_column('app_private', 'telegram_instant_report_deliveries', 'slot', 'delivery slot exists');
select has_column('app_private', 'telegram_instant_report_deliveries', 'storage_path', 'storage path exists');
select isnt_empty($$select 1 from pg_indexes where schemaname='app_private' and indexname='telegram_instant_reports_request_id_key'$$, 'request id is unique');
select isnt_empty($$select 1 from pg_indexes where schemaname='app_private' and indexname='telegram_instant_report_deliveries_report_slot_key'$$, 'delivery slot is unique');
select ok((select relrowsecurity from pg_class where oid='app_private.telegram_instant_reports'::regclass), 'instant reports RLS');
select ok((select relrowsecurity from pg_class where oid='app_private.telegram_instant_report_deliveries'::regclass), 'delivery RLS');
select is((select count(*) from information_schema.role_table_grants where table_schema='app_private' and table_name='telegram_instant_reports' and grantee in ('anon','authenticated','public')), 0::bigint, 'no public grants on reports');
select is((select count(*) from information_schema.role_table_grants where table_schema='app_private' and table_name='telegram_instant_report_deliveries' and grantee in ('anon','authenticated','public')), 0::bigint, 'no public grants on deliveries');
select has_check('app_private', 'telegram_instant_reports', 'telegram_instant_reports_source_check', 'source is explicit');
select has_check('app_private', 'telegram_instant_reports', 'telegram_instant_reports_status_check', 'report status is bounded');
select has_check('app_private', 'telegram_instant_report_deliveries', 'telegram_instant_report_deliveries_status_check', 'delivery status is bounded');
select has_check('app_private', 'telegram_instant_report_deliveries', 'telegram_instant_report_deliveries_type_check', 'delivery type is bounded');
select has_check('app_private', 'telegram_instant_reports', 'telegram_instant_reports_snapshot_object', 'snapshot is an object');
select has_check('app_private', 'telegram_instant_reports', 'telegram_instant_reports_metadata_object', 'metadata is an object');
select has_check('app_private', 'telegram_instant_report_deliveries', 'telegram_instant_report_deliveries_slot_positive', 'slot is nonnegative');
select col_is_fk('app_private', 'telegram_instant_report_deliveries', 'report_id', 'delivery references report');
select finish();
rollback;
```

- [ ] **Step 3: Run the focused pgTAP test and verify RED**

Run:

```bash
supabase test db --local supabase/tests/database/014_mu_instant_intelligence_run_test.sql
```

Expected: FAIL because the two tables and their constraints do not yet exist.

- [ ] **Step 4: Implement the minimal additive migration**

Create the two tables with these exact contracts:

```sql
create table app_private.telegram_instant_reports (
  id uuid primary key default gen_random_uuid(),
  request_id text not null,
  thread_id uuid not null references app_private.telegram_threads(id) on delete cascade,
  source text not null default 'INSTANT',
  report_date date not null,
  candidate_snapshot jsonb not null,
  rendered_message text not null,
  generation_metadata jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING',
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_instant_reports_request_id_not_blank check (btrim(request_id) <> ''),
  constraint telegram_instant_reports_source_check check (source = 'INSTANT'),
  constraint telegram_instant_reports_snapshot_object check (jsonb_typeof(candidate_snapshot) = 'object'),
  constraint telegram_instant_reports_metadata_object check (jsonb_typeof(generation_metadata) = 'object'),
  constraint telegram_instant_reports_status_check check (status in ('PENDING','SENDING','SENT','FAILED'))
);

create unique index telegram_instant_reports_request_id_key
  on app_private.telegram_instant_reports(request_id);

create table app_private.telegram_instant_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references app_private.telegram_instant_reports(id) on delete cascade,
  slot integer not null,
  message_type text not null,
  content text not null,
  storage_path text,
  status text not null default 'PENDING',
  telegram_message_id bigint,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_instant_report_deliveries_report_slot_key unique (report_id, slot),
  constraint telegram_instant_report_deliveries_slot_positive check (slot >= 0),
  constraint telegram_instant_report_deliveries_type_check check (message_type in ('TEXT','PHOTO')),
  constraint telegram_instant_report_deliveries_status_check check (status in ('PENDING','SENDING','SENT','FAILED')),
  constraint telegram_instant_report_deliveries_content_not_blank check (btrim(content) <> '')
);
```

Enable RLS, revoke all access from `public`, `anon`, and `authenticated`, grant full DML only to `service_role`, and attach the existing `app_private.set_updated_at()` trigger to both tables.

- [ ] **Step 5: Apply the migration locally and rerun pgTAP**

Run:

```bash
supabase db reset --local
supabase test db --local supabase/tests/database/014_mu_instant_intelligence_run_test.sql
```

Expected: PASS with 21 assertions.

- [ ] **Step 6: Commit the database contract**

```bash
git add supabase/migrations supabase/tests/database/014_mu_instant_intelligence_run_test.sql
git commit -m "feat: add instant telegram report persistence"
```

### Task 2: Extract shared report composition and deterministic Instant rendering

**Files:**
- Create: `supabase/functions/_shared/m6/reporting.ts`
- Modify: `supabase/functions/_shared/m6/briefing.ts`
- Modify: `supabase/functions/_shared/m6/openai.ts`
- Modify: `supabase/functions/_shared/m6/repository.ts`
- Test: `supabase/functions/tests/m6/reporting_test.ts`
- Test: `supabase/functions/tests/m6/briefing_test.ts`

**Interfaces:**
- Produces `composeM6Report(input): Promise<ComposedM6Report>` for Morning and Instant callers.
- Produces `renderInstantReport(snapshot, phrasing, stats): TelegramMessagePlan[]` while retaining `renderMorningBrief` output compatibility.
- Produces `sortBriefingCandidates(rows): BriefingCandidateRow[]` with explicit rank, score, candidate-id tie-breakers.

- [ ] **Step 1: Write failing tests for deterministic order and shared composition**

Add tests with these behaviors:

```ts
Deno.test("candidate ordering is deterministic when rank and score tie", () => {
  const rows = sortBriefingCandidates([
    { candidate_id: "candidate-b", rank: null, priority_score: 88, first_mover_flag: false, must_cover_flag: false, creative_status: "READY", reference_posts: [] },
    { candidate_id: "candidate-a", rank: null, priority_score: 88, first_mover_flag: false, must_cover_flag: false, creative_status: "READY", reference_posts: [] },
  ]);
  assertEquals(rows.map((row) => row.candidate_id), ["candidate-a", "candidate-b"]);
});

Deno.test("instant render preserves canonical fields and adds instant heading and summary", () => {
  const plans = renderInstantReport(snapshot, phrasing, { collected: 9, failed: 1, candidateCount: 14 });
  assert(plans[0]?.text.includes("MU Instant Intelligence"));
  assert(plans.some((plan) => plan.text.includes("Priority 88")));
  assert(plans.at(-1)?.text.includes("수집: 성공 9 / 실패 1"));
  assert(plans.some((plan) => plan.text.includes("/open 1")));
});

Deno.test("composition keeps signed URLs out of the frozen snapshot", async () => {
  const result = await composeM6Report({ source: "INSTANT", ...dependencies });
  assertEquals(result.snapshot.items[0]?.reference_media_url, undefined);
  assertEquals(result.renderSnapshot.items[0]?.reference_media_url, "https://signed.test/asset");
});
```

Use the existing M6 snapshot fixture and dependency seams; do not mock Telegram or OpenAI for these pure composition tests.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
deno test supabase/functions/tests/m6/reporting_test.ts supabase/functions/tests/m6/briefing_test.ts
```

Expected: FAIL because the new shared functions and Instant renderer do not exist.

- [ ] **Step 3: Implement deterministic ordering and report composition**

Implement `sortBriefingCandidates` using the ordered comparison:

1. non-null rank ascending;
2. null rank after ranked rows;
3. priority score descending with null last;
4. `must_cover_flag` true first;
5. `first_mover_flag` true first;
6. candidate id ascending.

Implement `composeM6Report` by reusing `buildMorningBriefingSnapshot`, `selectRepresentativeReference`, `createReferenceSignedUrl`, `phraseMorningBrief`, and the fixture service. The returned frozen snapshot must omit signed URLs; only the render snapshot receives them.

Extend `BriefingCandidateRow` only with data needed for deterministic ordering. Do not change Morning Brief's public response or daily-dedupe logic.

- [ ] **Step 4: Implement Instant rendering with backward-compatible Morning rendering**

Keep `renderMorningBrief(snapshot, phrasing)` as the existing entry point and output shape. Add a source-aware internal renderer used by both paths. Instant output must include:

```text
🔴 MU Instant Intelligence
방금 Instagram 경쟁계정 수집 완료
수집: 성공 X / 실패 Y
후보: Z
```

Candidate text must still come from the canonical renderer so score, flags, Creative Brief status, source username, permalink, and `/open N` cannot be invented by OpenAI. The final summary includes `FIRST_MOVER`, `MUST_COVER`, and `Brief READY` counts from canonical rows.

- [ ] **Step 5: Run focused tests and the existing M6 tests**

Run:

```bash
deno test supabase/functions/tests/m6/reporting_test.ts supabase/functions/tests/m6/briefing_test.ts supabase/functions/tests/m6/morning_brief_handler_test.ts
```

Expected: PASS, including all pre-existing Morning Brief renderer assertions.

- [ ] **Step 6: Commit shared reporting**

```bash
git add supabase/functions/_shared/m6 supabase/functions/tests/m6/reporting_test.ts supabase/functions/tests/m6/briefing_test.ts
git commit -m "feat: share M6 instant report composition"
```

### Task 3: Add report persistence, delivery claims, and latest snapshot resolution

**Files:**
- Create: `supabase/functions/_shared/m6/instant_report_repository.ts`
- Create: `supabase/functions/_shared/m6/latest_report.ts`
- Test: `supabase/functions/tests/m6/instant_report_repository_test.ts`
- Test: `supabase/functions/tests/m6/latest_report_test.ts`

**Interfaces:**
- `createInstantReportRepository(options)` exposes `claimReport`, `saveSnapshot`, `listDeliveries`, `claimDelivery`, `markDeliverySent`, `markDeliveryFailed`, and `markReportStatus`.
- `resolveLatestNumberedReport(inputs)` returns `{ source: "MORNING" | "INSTANT", snapshot, reportId } | null`.

- [ ] **Step 1: Write failing repository and resolver tests**

Cover these concrete cases:

```ts
Deno.test("same request id claims one report and second claim is already sent", async () => {
  const repository = createFakeInstantRepository();
  const first = await repository.claimReport("run-1", "thread-1", "2026-09-20");
  await repository.markReportStatus(first.reportId, "SENT");
  const second = await repository.claimReport("run-1", "thread-1", "2026-09-20");
  assertEquals(second.status, "ALREADY_SENT");
});

Deno.test("sent delivery slot is never claimed again", async () => {
  const repository = createFakeInstantRepository();
  const report = await repository.claimReport("run-1", "thread-1", "2026-09-20");
  assertEquals(await repository.claimDelivery(report.reportId, 1), true);
  await repository.markDeliverySent(report.reportId, 1, 42);
  assertEquals(await repository.claimDelivery(report.reportId, 1), false);
});

Deno.test("newer Morning snapshot wins over an older Instant snapshot", () => {
  const latest = resolveLatestNumberedReport({
    morning: { reportId: "morning", createdAt: "2026-09-20T09:00:00+09:00", snapshot: morningSnapshot },
    instant: { reportId: "instant", createdAt: "2026-09-20T08:00:00+09:00", snapshot: instantSnapshot },
  });
  assertEquals(latest?.source, "MORNING");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
deno test supabase/functions/tests/m6/instant_report_repository_test.ts supabase/functions/tests/m6/latest_report_test.ts
```

Expected: FAIL because the repository and resolver modules do not exist.

- [ ] **Step 3: Implement the REST repository with conditional claims**

Use the existing M6 REST style and `app_private` profile. `claimReport` inserts with `resolution=ignore-duplicates`, then reads the existing row when the insert returns no row. `claimDelivery` updates `status=PENDING` to `SENDING` and returns true only when one row changed. `markDeliverySent` records the Telegram message id and timestamp. The repository never logs request ids with secret values and never stores signed URLs in `candidate_snapshot`.

- [ ] **Step 4: Implement the latest report resolver**

Add a pure resolver that compares `created_at` for the newest sent Morning Brief and newest sent Instant report. If timestamps tie, prefer the later `sent_at`, then Morning as a stable final tie-breaker. Preserve the source in the returned value so `/open` can resolve the correct snapshot without mixing tables.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
deno test supabase/functions/tests/m6/instant_report_repository_test.ts supabase/functions/tests/m6/latest_report_test.ts
```

Then commit:

```bash
git add supabase/functions/_shared/m6/instant_report_repository.ts supabase/functions/_shared/m6/latest_report.ts supabase/functions/tests/m6/instant_report_repository_test.ts supabase/functions/tests/m6/latest_report_test.ts
git commit -m "feat: add instant report idempotency and context resolution"
```

### Task 4: Implement and test the `telegram-instant-report` Edge Function

**Files:**
- Create: `supabase/functions/telegram-instant-report/handler.ts`
- Create: `supabase/functions/telegram-instant-report/index.ts`
- Test: `supabase/functions/tests/m6/instant_report_handler_test.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- `createInstantReportHandler(dependencies)` authenticates POST requests and invokes `run({ requestId })`.
- Runtime `runInstantReport(requestId)` returns `SENT`, `ALREADY_SENT`, or `FAILED` with safe counts and warnings.

- [ ] **Step 1: Write failing handler tests**

Test method rejection, unauthorized access, malformed/missing `request_id`, same-day Morning Brief coexistence, two different request ids, duplicate request retry, OpenAI fallback, fixture warning, and delivery failure behavior. The handler dependency contract must allow the tests to run without live Supabase, OpenAI, Telegram, or n8n credentials.

- [ ] **Step 2: Run handler tests and verify RED**

Run:

```bash
deno test supabase/functions/tests/m6/instant_report_handler_test.ts
```

Expected: FAIL because the handler module does not exist.

- [ ] **Step 3: Implement the authenticated handler**

Mirror the constant-time bearer-secret comparison already used by `telegram-morning-brief`. Accept only a JSON object containing a trimmed `request_id` between 1 and 200 characters. Return 405, 401, or 400 for invalid requests and 200 for `SENT`/`ALREADY_SENT`; return 502 for `FAILED`.

- [ ] **Step 4: Implement the runtime using shared M6 modules**

Load `SUPABASE_URL`, `SUPABASE_SECRET_KEY`/`SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_AGENT_INVOKE_SECRET`, `TELEGRAM_OWNER_THREAD_ID`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_BOT_TOKEN` using the existing environment names. Claim the report before composition, run the existing fixture service, call `composeM6Report({ source: "INSTANT" })`, insert delivery rows with stable slots, and send only rows successfully claimed by this attempt. Use `createTelegramClient` for bounded Telegram retry and private Storage signed URLs for photos. Never call `telegram-morning-brief` or alter its table.

- [ ] **Step 5: Register the function and run focused tests**

Add:

```toml
[functions.telegram-instant-report]
verify_jwt = false
```

Run:

```bash
deno test supabase/functions/tests/m6/instant_report_handler_test.ts supabase/functions/tests/m6/reporting_test.ts supabase/functions/tests/m6/instant_report_repository_test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the Edge Function**

```bash
git add supabase/functions/telegram-instant-report supabase/functions/tests/m6/instant_report_handler_test.ts supabase/config.toml
git commit -m "feat: add instant telegram report function"
```

### Task 5: Make Telegram `/open` use the latest source-tagged snapshot

**Files:**
- Modify: `supabase/functions/telegram-agent/index.ts`
- Test: `supabase/functions/tests/m6/telegram_agent_handler_test.ts`
- Test: `supabase/functions/tests/m6/latest_report_test.ts`

**Interfaces:**
- Numeric `/open` and `/today` queries use the latest report resolver; all existing command grammar and mutation safeguards remain unchanged.

- [ ] **Step 1: Add failing command-context tests**

Add tests that stub Morning and Instant report queries and assert:

```ts
assertEquals(await resolveOpenTarget("2", newestInstantContext), {
  candidate_id: "instant-candidate-2",
  reference_permalink: "https://www.instagram.com/p/instant-2/",
});
assertEquals(await resolveOpenTarget("2", newestMorningContext), {
  candidate_id: "morning-candidate-2",
  reference_permalink: "https://www.instagram.com/p/morning-2/",
});
```

Also assert that `/open alert` still reads `telegram_alert_events` and that UUID targets retain the current behavior.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
deno test supabase/functions/tests/m6/telegram_agent_handler_test.ts supabase/functions/tests/m6/latest_report_test.ts
```

Expected: FAIL because the agent still reads only `telegram_briefings`.

- [ ] **Step 3: Implement source-aware reads**

Add narrow REST reads for the newest sent Morning Brief and newest sent Instant report, pass them through `resolveLatestNumberedReport`, and use the returned snapshot for numeric `/open` and `/today`. Keep the existing thread active-candidate update and permalink response. Do not change the agent's incoming update dedupe, owner check, alert branch, revision flow, or natural-language read-only rules.

- [ ] **Step 4: Run M6 command tests and commit**

Run:

```bash
deno test supabase/functions/tests/m6/commands_test.ts supabase/functions/tests/m6/telegram_agent_handler_test.ts supabase/functions/tests/m6/latest_report_test.ts
```

Then commit:

```bash
git add supabase/functions/telegram-agent/index.ts supabase/functions/tests/m6/telegram_agent_handler_test.ts supabase/functions/tests/m6/latest_report_test.ts
git commit -m "feat: resolve telegram open from latest report snapshot"
```

### Task 6: Add and validate the manual n8n workflow

**Files:**
- Create: `n8n/workflows/mu-instant-intelligence-run.json`
- Create: `scripts/fixtures/n8n/mu-instant-intelligence-run.json`
- Modify: `scripts/validate-n8n-workflow.mjs`
- Modify: `scripts/validate-n8n-workflow.test.mjs`
- Modify: `n8n/README.md`

**Interfaces:**
- The workflow has exactly one `n8n-nodes-base.manualTrigger` first node and the eight-node HTTP chain ending at `/functions/v1/telegram-instant-report`.
- Existing scheduled-workflow validation branches remain unchanged.

- [ ] **Step 1: Write failing validator tests**

Add tests that mutate the loaded fixture and assert the validator result:

```js
test("rejects Instant workflow without Manual Trigger first", () => {
  const workflow = readInstantFixture();
  workflow.nodes[0].type = "n8n-nodes-base.scheduleTrigger";
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Manual Trigger/i);
});

test("rejects Instant report node without execution request id", () => {
  const workflow = readInstantFixture();
  const report = workflow.nodes.find((node) => node.name === "Send Instant Intelligence Report");
  delete report.parameters.jsonBody;
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /request_id/i);
});

test("rejects Instant workflow with a Code node", () => {
  const workflow = readInstantFixture();
  workflow.nodes.push({ name: "Business Logic", type: "n8n-nodes-base.code" });
  const result = runValidator(workflow);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Code nodes/i);
});

test("accepts the complete inactive Instant workflow fixture", () => {
  const result = runValidator(readInstantFixture());
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
```

Extend the validator with a dedicated `MU Instant Intelligence Run` branch. Require POST, JSON response, 120-second timeout, Telegram credential on the final report node, `sendBody: true`, and a JSON expression containing `$execution.id`. Require all edges to be linear and preserve the existing scheduled workflow branches exactly.

- [ ] **Step 2: Run validator tests and verify RED**

Run:

```bash
node --test scripts/validate-n8n-workflow.test.mjs
```

Expected: FAIL because the Instant fixture and validator branch do not exist.

- [ ] **Step 3: Create the workflow export**

Create the inactive export with these nodes and credential references:

```text
Manual Trigger
Collect Active Instagram Accounts       Instagram Collector Invoke Secret
Run Content Intelligence                Instagram Collector Invoke Secret
Trigger Priority Creative Generation    Instagram Collector Invoke Secret
Sync Daily Intelligence to Notion      Instagram Collector Invoke Secret
Poll Selected Creative Generation       Instagram Collector Invoke Secret
Dispatch Telegram Alerts                Telegram Agent Invoke Secret
Send Instant Intelligence Report        Telegram Agent Invoke Secret
```

The final node sends:

```json
{
  "request_id": "={{ $execution.id }}"
}
```

All upstream failure isolation and timeout settings match the existing schedule workflow. No secret value, Code node, or Morning Brief endpoint may appear.

- [ ] **Step 4: Update README and run validator tests**

Document import, credential resolution, Manual Execute, and activation steps without printing any secret values. Run:

```bash
node --test scripts/validate-n8n-workflow.test.mjs
node scripts/validate-n8n-workflow.mjs n8n/workflows/mu-instant-intelligence-run.json
```

Expected: all validator tests pass and the workflow validator prints `workflow validation passed`.

- [ ] **Step 5: Commit the workflow contract**

```bash
git add n8n/workflows/mu-instant-intelligence-run.json scripts/fixtures/n8n/mu-instant-intelligence-run.json scripts/validate-n8n-workflow.mjs scripts/validate-n8n-workflow.test.mjs n8n/README.md
git commit -m "feat: add manual instant intelligence workflow"
```

### Task 7: Run full regression, security checks, and deployment probes

**Files:**
- Modify only files required by failing verification output; do not alter Morning Brief semantics to make unrelated checks pass.

**Interfaces:**
- The complete repository passes its available automated checks, or failures are reported with exact command output and classified as pre-existing/environmental.

- [ ] **Step 1: Run all Deno function tests**

Run:

```bash
deno test supabase/functions/tests
```

Record the exit code and every failing test. If a failure is introduced by this change, return to the owning task and fix it with a new failing test first.

- [ ] **Step 2: Run database reset and all pgTAP tests**

Run:

```bash
supabase db reset --local
supabase test db --local
```

If the local container is unavailable, record that exact blocker and still run SQL syntax checks available from the CLI.

- [ ] **Step 3: Run n8n validation and repository hygiene checks**

Run:

```bash
node --test scripts/validate-n8n-workflow.test.mjs
for workflow in n8n/workflows/*.json; do node scripts/validate-n8n-workflow.mjs "$workflow"; done
git diff --check
rg -n --hidden --glob '!supabase/functions/deno.lock' --glob '!*.md' 'sb_secret_|TELEGRAM_BOT_TOKEN\s*[:=]\s*[^$\{]|OPENAI_API_KEY\s*[:=]\s*[^$\{]|SUPABASE_SECRET_KEY\s*[:=]\s*[^$\{]' .
```

The secret scan must return no committed secret values. Existing variable names and credential names are allowed; values are not.

- [ ] **Step 4: Inspect the Morning Brief regression boundary**

Run:

```bash
git diff 80db8bb^..HEAD -- n8n/workflows/telegram-morning-brief.json supabase/functions/telegram-morning-brief supabase/functions/tests/m6/morning_brief_handler_test.ts
```

The diff must show no changes to the existing Morning Brief workflow/function unless a shared-module import was required, and any such import must preserve the existing daily `ALREADY_SENT` path and response contract.

- [ ] **Step 5: Attempt real local/credential E2E without fabricating success**

If local Supabase and required environment variables are present, serve/deploy the new function and invoke it with a generated request id after running the existing collector pipeline. Confirm the final response and Telegram delivery. If credentials or deployed project access are unavailable, report `E2E NOT RUN` with the missing variable/access condition and cite the passing local/unit checks instead.

- [ ] **Step 6: Run final verification before claiming completion**

Re-run the full commands from Steps 1-3 after the final edit, inspect `git status --short`, and report:

- all added/modified files;
- architecture and idempotency behavior;
- test counts and failures;
- whether real E2E ran;
- external credential blockers;
- n8n operator steps;
- whether the branch is merge-ready.
