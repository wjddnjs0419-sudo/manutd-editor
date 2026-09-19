# Milestone 6 Telegram Editorial Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Telegram editorial operating layer that sends a 09:00 KST MU morning briefing with representative competitor thumbnails and source links, tracks Manchester United fixtures, pushes deduplicated priority/fixture alerts, remembers editorial context, answers grounded read-only questions, and performs explicit slash-command Creative Brief revisions.

**Architecture:** Supabase remains canonical. Two thin Edge Function entrypoints (`fixture-sync` and Telegram runtime endpoints) delegate to focused M6 modules; API-Football is the initial fixture provider behind an adapter, and existing private Supabase Storage provides signed reference thumbnails. n8n only schedules/invokes or forwards Telegram updates; all fixture interpretation, briefing selection, memory, alert dedupe, command validation, revision logic, and Telegram message composition live in version-controlled code.

**Tech Stack:** Supabase/Postgres 17/pgTAP, Supabase Edge Functions on Deno 2.1, TypeScript, `@supabase/supabase-js@2.116.0`, OpenAI Responses API using the project’s versioned M6 config, API-Football v3, Telegram Bot API, existing Notion client, n8n workflow JSON validation.

**Spec:** `docs/superpowers/specs/2026-09-19-milestone-6-telegram-editorial-agent-design.md`

## Global Constraints

- Supabase is canonical; Notion, Telegram, and n8n are bounded projections/interfaces.
- M6 v1 is single-user operationally, but user/chat/thread schema must remain multi-user extensible.
- Morning Brief default is exactly 09:00 KST and always sends, including a concise no-change report.
- Before compiling the 09:00 brief, force one fixture refresh.
- Normal fixture refresh slots are 03:00 and 15:00 KST; D-1 through kickoff is hourly; LIVE is every 15 minutes.
- The initial fixture provider is API-Football v3 behind a provider interface; Manchester United provider team id is `33`, verified during implementation against the provider response.
- Fixture sync stores UTC-compatible `timestamptz`; Telegram and Notion render Asia/Seoul.
- Briefing candidate identity/order is deterministic; the LLM may phrase supplied facts but cannot add candidates, change order, change scores, invent reasons, or introduce outside facts.
- Top candidates include one deterministic representative post thumbnail when a cached asset exists, plus the canonical Instagram permalink and source username for human verification.
- Telegram thumbnail delivery must use the existing private `instagram-analysis` bucket via a short-lived signed URL; never depend on expiring upstream Instagram media URLs.
- Natural-language Telegram messages are read-only. Every state-changing editorial action requires an explicit slash command.
- Recent prompt context contains exactly the latest 12 messages; after 20 unsummarized messages, older context is folded into the rolling summary while the newest 12 remain raw.
- Active context history retains at most 5 entries.
- Pending protected-state confirmations expire exactly 10 minutes after creation.
- Historical retrieval is structured/text-first and conditional; M6 v1 has no vector-first RAG and no external web search.
- Immediate alerts are limited to FIRST_MOVER, MUST_COVER, match status transitions, kickoff changes, POSTPONED, CANCELLED, and venue changes.
- Duplicate Telegram update delivery, alert generation, morning brief generation, fixture sync, and command execution must all be idempotent.
- Telegram edits reuse the existing M5 evidence snapshot and grounding rules. No new external facts or sources may appear in `/slide` or `/caption` revisions.
- Existing Creative Brief revisions are immutable; targeted edits create append-only revisions.
- EDITABLE Content Pipeline items may receive system-owned updates. LOCKED/APPROVED items require `/confirm` and create a protected new revision/item rather than overwrite.
- Notion projection failure must never roll back a canonical fixture, conversation record, alert state, or Creative Brief revision.
- `app_private` tables are service-only. New `public` M6 tables follow the existing backend-only RLS/grant pattern.
- Secrets never appear in git, n8n exports, response bodies, provider error storage, or logs.
- Before implementing Supabase changes, review the current Supabase changelog/docs relevant to Edge Functions, Data API exposure, and Storage signed URLs; run CLI commands through `--help` rather than assuming flags.
- Each task follows RED → minimal GREEN → focused regression → commit.

## File Structure

New M6 code is split by responsibility:

```text
supabase/functions/_shared/m6/
  types.ts                    shared runtime types
  config.ts                   M6 env + DB config validation
  repository.ts               Supabase REST/storage access for M6 state
  openai.ts                   read-only/summary/briefing phrasing provider
  telegram_client.ts          Bot API transport/retry/sendMessage/sendPhoto
  fixture_types.ts            provider-neutral fixture model
  api_football_provider.ts    API-Football adapter only
  fixture_service.ts          sync cadence, normalize/diff/persist
  match_calendar.ts           Notion Match Calendar projection
  reference_media.ts          deterministic reference post + cached media choice
  briefing.ts                 deterministic brief payload + safe rendering
  alerts.ts                   candidate transition state + event dedupe/dispatch
  memory.ts                   recent messages + rolling summary + active context
  retrieval.ts                structured/text historical retrieval
  commands.ts                 deterministic slash parser/validation
  revisions.ts                grounded targeted Creative Brief revision service

supabase/functions/fixture-sync/
  handler.ts
  index.ts

supabase/functions/telegram-morning-brief/
  handler.ts
  index.ts

supabase/functions/telegram-alerts/
  handler.ts
  index.ts

supabase/functions/telegram-agent/
  handler.ts
  index.ts
```

Tests mirror these boundaries under `supabase/functions/tests/m6/`.

## Review Focus

- Duplicate Telegram webhook/update delivery must never create two messages, two command events, or two Creative Brief revisions; Task 7 pins idempotency to `telegram_update_id`.
- A briefing’s `/open 2` must still resolve to the same candidate, representative post, thumbnail asset, and permalink after later M4 rescoring; Task 4 freezes and reopens that exact snapshot.
- A missing/expired cached thumbnail or failed signed-URL creation must degrade to text + Instagram permalink, not fail the entire brief or alert; Task 4 tests all media fallback branches.
- A LOCKED/APPROVED brief may change between command proposal and `/confirm`; Task 7 revalidates the latest production state at confirmation time and refuses stale destructive execution.
- API-Football quota/network failure or partial fixture data must preserve the last canonical match state, record a safe failure category, and still allow a text-only morning brief; Tasks 2 and 5 test stale-safe fallback.

---

### Task 1: M6 database contracts, configuration, and service-only security

**Files:**
- Create via CLI: `supabase/migrations/<generated>_milestone_6_telegram_editorial_agent.sql`
- Modify: `supabase/seed.sql`
- Create: `supabase/tests/database/012_milestone_6_telegram_editorial_agent_test.sql`
- Modify: `supabase/config.toml`
- Modify: `.env.example`

**Interfaces:**
- Produces canonical `public.matches` and versioned `public.telegram_agent_configs`.
- Produces private runtime tables:
  - `app_private.fixture_sync_state`
  - `app_private.match_calendar_sync_state`
  - `app_private.telegram_users`
  - `app_private.telegram_threads`
  - `app_private.telegram_messages`
  - `app_private.telegram_briefings`
  - `app_private.telegram_alert_events`
  - `app_private.telegram_candidate_alert_state`
  - `app_private.telegram_command_events`
- Later tasks rely on `telegram_messages.telegram_update_id` as the inbound idempotency key and `telegram_alert_events.event_fingerprint` as the outbound alert idempotency key.

- [ ] **Step 1: Verify current tooling/docs before schema work**

Run:

```bash
supabase --version
supabase migration new milestone_6_telegram_editorial_agent
supabase db --help
supabase functions --help
```

Also review the current Supabase Edge Functions/Data API/Storage signed URL docs and breaking-change changelog. Do not continue if the installed CLI is older than the repo’s documented minimum or if the generated migration path is not present.

- [ ] **Step 2: Write the failing pgTAP contract**

Create `supabase/tests/database/012_milestone_6_telegram_editorial_agent_test.sql` with assertions equivalent to:

```sql
begin;
select plan(34);

select has_table('public', 'matches');
select has_table('public', 'telegram_agent_configs');
select has_table('app_private', 'telegram_users');
select has_table('app_private', 'telegram_threads');
select has_table('app_private', 'telegram_messages');
select has_table('app_private', 'telegram_briefings');
select has_table('app_private', 'telegram_alert_events');
select has_table('app_private', 'telegram_candidate_alert_state');
select has_table('app_private', 'telegram_command_events');
select has_table('app_private', 'fixture_sync_state');
select has_table('app_private', 'match_calendar_sync_state');

select col_is_pk('public', 'matches', 'id');
select has_column('public', 'matches', 'kickoff_at');
select has_column('public', 'matches', 'manual_override');
select has_column('app_private', 'telegram_messages', 'telegram_update_id');
select has_column('app_private', 'telegram_threads', 'context_history');
select has_column('app_private', 'telegram_threads', 'pending_action');
select has_column('app_private', 'telegram_briefings', 'candidate_snapshot');
select has_column('app_private', 'telegram_alert_events', 'event_fingerprint');

select isnt_empty(
  $$select 1 from pg_indexes where schemaname='public' and indexname='matches_provider_external_key'$$
);
select isnt_empty(
  $$select 1 from pg_indexes where schemaname='app_private' and indexname='telegram_messages_update_id_key'$$
);
select isnt_empty(
  $select 1 from pg_indexes where schemaname='app_private' and indexname='telegram_alert_events_fingerprint_key'$
);
select isnt_empty(
  $select 1 from pg_indexes where schemaname='app_private' and indexname='telegram_briefings_thread_date_key'$
);

select ok((select relrowsecurity from pg_class where oid='public.matches'::regclass), 'matches RLS');
select ok((select relrowsecurity from pg_class where oid='public.telegram_agent_configs'::regclass), 'agent config RLS');
select ok((select relrowsecurity from pg_class where oid='app_private.telegram_messages'::regclass), 'messages RLS');

select is((select count(*)::int from public.telegram_agent_configs where is_active), 1, 'one active config');
select is(
  (select timezone from public.telegram_agent_configs where is_active),
  'Asia/Seoul',
  'KST config'
);
select is(
  (select morning_brief_time::text from public.telegram_agent_configs where is_active),
  '09:00:00',
  '09:00 brief'
);
select is((select briefing_top_n from public.telegram_agent_configs where is_active), 3, 'top 3');
select is((select recent_message_limit from public.telegram_agent_configs where is_active), 12, '12 recent');
select is((select summary_trigger_count from public.telegram_agent_configs where is_active), 20, 'summary at 20');

select throws_ok(
  $$insert into public.matches(provider, external_match_id, competition, home_team, away_team, opponent, is_home, kickoff_at, status, last_synced_at)
    values ('API_FOOTBALL','x','PL','A','B','B',true,now(),'BAD',now())$$,
  '23514'
);
select throws_ok(
  $$insert into app_private.telegram_alert_events(thread_id,event_type,event_fingerprint,payload,status)
    values (gen_random_uuid(),'FIRST_MOVER','x','{}','BAD')$$,
  '23503'
);

select finish();
rollback;
```

Adjust the exact plan count after all assertions are present.

- [ ] **Step 3: Run focused pgTAP and verify RED**

Run:

```bash
supabase test db --file supabase/tests/database/012_milestone_6_telegram_editorial_agent_test.sql
```

Expected: FAIL because M6 tables/config do not exist.

- [ ] **Step 4: Implement the generated additive migration**

The generated migration must create:

```sql
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_match_id text not null,
  competition text not null,
  season text,
  home_team text not null,
  away_team text not null,
  opponent text not null,
  is_home boolean not null,
  kickoff_at timestamptz not null,
  venue text,
  status text not null check (status in ('SCHEDULED','LIVE','FINISHED','POSTPONED','CANCELLED')),
  home_score integer check (home_score is null or home_score >= 0),
  away_score integer check (away_score is null or away_score >= 0),
  provider_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_payload)='object'),
  provider_updated_at timestamptz,
  last_synced_at timestamptz not null,
  manual_override jsonb check (manual_override is null or jsonb_typeof(manual_override)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint matches_provider_external_key unique(provider, external_match_id)
);
```

Create `public.telegram_agent_configs` with one-active partial unique index and exact numeric constraints for Top 3, 12 recent messages, 20 summary trigger, and 60-minute alert cooldown.

Create the private tables from the spec plus:

```sql
create table app_private.telegram_candidate_alert_state (
  candidate_id uuid primary key references public.content_candidates(id) on delete cascade,
  first_mover_flag boolean not null default false,
  must_cover_flag boolean not null default false,
  first_mover_transition integer not null default 0 check (first_mover_transition >= 0),
  must_cover_transition integer not null default 0 check (must_cover_transition >= 0),
  candidate_calculated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table app_private.fixture_sync_state (
  provider text primary key,
  last_full_sync_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_category text,
  rate_limit_remaining integer,
  updated_at timestamptz not null default now()
);

create table app_private.match_calendar_sync_state (
  match_id uuid primary key references public.matches(id) on delete cascade,
  notion_page_id text unique,
  last_synced_hash text,
  last_synced_at timestamptz,
  last_error_category text,
  updated_at timestamptz not null default now()
);
```

Use partial unique indexes for nullable Telegram update/message ids:

```sql
create unique index telegram_messages_update_id_key
  on app_private.telegram_messages(telegram_update_id)
  where telegram_update_id is not null;

create unique index telegram_alert_events_fingerprint_key
  on app_private.telegram_alert_events(event_fingerprint);

create unique index telegram_briefings_thread_date_key
  on app_private.telegram_briefings(thread_id, briefing_date);
```

Enable RLS on every new table, revoke `public, anon, authenticated`, grant only `service_role`, and reuse `app_private.set_updated_at()` triggers.

- [ ] **Step 5: Seed the active M6 config**

Append an idempotent `m6-v1` row to `supabase/seed.sql`:

```json
{
  "version": 1,
  "timezone": "Asia/Seoul",
  "morning_brief_time": "09:00",
  "briefing_top_n": 3,
  "recent_message_limit": 12,
  "summary_trigger_count": 20,
  "alert_cooldown_minutes": 60,
  "model_config": {
    "conversation_model": "gpt-5.6-luna",
    "summary_model": "gpt-5.6-luna",
    "briefing_model": "gpt-5.6-luna",
    "reasoning": "low",
    "max_output_tokens": 1800,
    "timeout_ms": 20000,
    "max_retries": 2
  }
}
```

Do not silently substitute model names if the configured model is unavailable; deployment smoke must report the external model-access blocker.

- [ ] **Step 6: Register Edge Function auth boundaries and env names**

Add `verify_jwt = false` sections in `supabase/config.toml` for:

```toml
[functions.fixture-sync]
verify_jwt = false

[functions.telegram-morning-brief]
verify_jwt = false

[functions.telegram-alerts]
verify_jwt = false

[functions.telegram-agent]
verify_jwt = false
```

Add only empty/example values to `.env.example`:

```text
FOOTBALL_API_KEY=
FOOTBALL_TEAM_ID=33
TELEGRAM_AGENT_INVOKE_SECRET=
TELEGRAM_OWNER_USER_ID=
TELEGRAM_OWNER_CHAT_ID=
NOTION_MATCH_CALENDAR_DATABASE_ID=
```

Keep `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SECRET_KEY` server-side.

- [ ] **Step 7: Reset and verify GREEN**

Run:

```bash
supabase db reset --local
supabase test db --file supabase/tests/database/012_milestone_6_telegram_editorial_agent_test.sql
supabase test db
supabase db lint --local --schema public,app_private --level warning
```

Expected: focused test PASS, full existing pgTAP PASS, lint has no new warnings attributable to M6.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations supabase/seed.sql supabase/tests/database/012_milestone_6_telegram_editorial_agent_test.sql supabase/config.toml .env.example
git commit -m "feat: add milestone 6 runtime contracts"
```

---

### Task 2: API-Football adapter and canonical fixture sync

**Files:**
- Create: `supabase/functions/_shared/m6/fixture_types.ts`
- Create: `supabase/functions/_shared/m6/api_football_provider.ts`
- Create: `supabase/functions/_shared/m6/fixture_service.ts`
- Create: `supabase/functions/_shared/m6/repository.ts`
- Create: `supabase/functions/fixture-sync/handler.ts`
- Create: `supabase/functions/fixture-sync/index.ts`
- Create: `supabase/functions/tests/m6/api_football_provider_test.ts`
- Create: `supabase/functions/tests/m6/fixture_service_test.ts`
- Create: `supabase/functions/tests/m6/fixture_handler_test.ts`

**Interfaces:**
- `FixtureProvider.fetchFixtures(from: Date, to: Date): Promise<readonly ProviderFixture[]>`
- `FixtureProvider.fetchMatch(externalMatchId: string): Promise<ProviderFixture | null>`
- `normalizeApiFootballFixture(raw): CanonicalFixture`
- `deriveMatchDayMode(matches, now, timezone): MatchDayMode`
- `runFixtureSync({ mode: "AUTO" | "FORCE", now }, deps): Promise<FixtureSyncResult>`
- Repository methods: `listUpcomingMatches`, `getMatchByExternalId`, `upsertMatch`, `getFixtureSyncState`, `saveFixtureSyncState`, `insertAlertEventIfAbsent`.

- [ ] **Step 1: Write RED provider normalization tests**

Cover API-Football v3 response normalization with fixtures such as:

```ts
const raw = {
  fixture: {
    id: 12345,
    date: "2026-09-20T11:30:00+00:00",
    timestamp: 1789903800,
    venue: { name: "Old Trafford" },
    status: { short: "NS", long: "Not Started" }
  },
  league: { name: "Premier League", season: 2026 },
  teams: {
    home: { id: 33, name: "Manchester United" },
    away: { id: 42, name: "Arsenal" }
  },
  goals: { home: null, away: null }
};
assertEquals(normalizeApiFootballFixture(raw, 33), {
  provider: "API_FOOTBALL",
  external_match_id: "12345",
  competition: "Premier League",
  season: "2026",
  home_team: "Manchester United",
  away_team: "Arsenal",
  opponent: "Arsenal",
  is_home: true,
  kickoff_at: "2026-09-20T11:30:00.000Z",
  venue: "Old Trafford",
  status: "SCHEDULED",
  home_score: null,
  away_score: null
});
```

Add mappings:
- `NS` and the provider's documented second not-started short code -> `SCHEDULED`
- `1H/HT/2H/ET/BT/P/INT/LIVE -> LIVE`
- `FT/AET/PEN/AWD/WO -> FINISHED`
- `PST/SUSP -> POSTPONED`
- `CANC/ABD -> CANCELLED`

Unknown status must throw `UNSUPPORTED_FIXTURE_STATUS` instead of silently corrupting canonical state.

- [ ] **Step 2: Verify provider tests RED**

Run:

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4   deno test functions/tests/m6/api_football_provider_test.ts
```

Expected: FAIL because adapter does not exist.

- [ ] **Step 3: Implement API-Football transport**

Use the current provider contract:

```ts
const BASE_URL = "https://v3.football.api-sports.io";

await fetch(
  `${BASE_URL}/fixtures?team=${teamId}&from=${yyyyMmDd(from)}&to=${yyyyMmDd(to)}&timezone=UTC`,
  { headers: { "x-apisports-key": apiKey } }
);
```

For a specific match use `/fixtures?id=<id>`. Validate `errors`, `response`, and response HTTP status. Normalize provider failures to safe categories:
`RATE_LIMITED | AUTH | NETWORK | SERVER | MALFORMED | UNSUPPORTED_STATUS`.

Read `x-ratelimit-requests-remaining` when supplied and expose it to sync state. Never log the API key or provider body.

- [ ] **Step 4: Write RED cadence and diff tests**

Test `shouldSyncFixtures()` with exact cases:

```ts
assertEquals(shouldSyncFixtures(ctx("2026-09-19T00:00:00Z", "NORMAL_DAY", null)), true);  // 09:00 KST forced separately
assertEquals(shouldSyncFixtures(ctx("2026-09-19T06:00:00Z", "NORMAL_DAY", old("2026-09-19T00:00:00Z"))), true); // 15:00 KST slot
assertEquals(shouldSyncFixtures(ctx("2026-09-19T06:15:00Z", "NORMAL_DAY", old("2026-09-19T06:00:00Z"))), false);
assertEquals(shouldSyncFixtures(ctx("2026-09-19T11:00:00Z", "MATCH_DAY_PRE", old("2026-09-19T09:59:00Z"))), true);
assertEquals(shouldSyncFixtures(ctx("2026-09-19T11:15:00Z", "MATCH_LIVE", old("2026-09-19T11:00:00Z"))), true);
```

Also test:
- same fixture twice -> no duplicate,
- kickoff changed -> one match update + one `FIXTURE_KICKOFF_CHANGED` alert event,
- venue changed -> one event,
- `SCHEDULED -> LIVE -> FINISHED` -> one status event each,
- identical re-sync -> no duplicate event,
- provider failure preserves prior match row.

- [ ] **Step 5: Implement repository + fixture service**

The service must:
1. read current matches/sync state,
2. decide AUTO due/no-op or accept FORCE,
3. fetch a 60-day Manchester United range for full refresh,
4. for LIVE or near-kickoff refresh specific match ids when appropriate,
5. diff old/new canonical values before upsert,
6. insert alert events with fingerprints before returning,
7. write safe sync state.

Example fingerprint:

```ts
`FIXTURE_KICKOFF_CHANGED:${match.id}:${next.kickoff_at}`
`MATCH_STATUS:${match.id}:${next.status}`
`FIXTURE_VENUE_CHANGED:${match.id}:${sha256(next.venue ?? "")}`
```

- [ ] **Step 6: Implement fixture-sync handler**

Request contract:

```json
{"mode":"AUTO"}
```

or:

```json
{"mode":"FORCE"}
```

Require `Authorization: Bearer <TELEGRAM_AGENT_INVOKE_SECRET>` or the existing server invoke secret pattern with timing-safe comparison. Return only safe counts/state:

```json
{
  "status":"SYNCED",
  "matches_seen":8,
  "matches_changed":1,
  "alerts_created":1,
  "match_day_mode":"MATCH_DAY_PRE"
}
```

Never return provider payloads or keys.

- [ ] **Step 7: Verify Manchester United provider identity in credentialed smoke**

When `FOOTBALL_API_KEY` is available, perform one safe provider request for team id `33` and assert the returned team name is exactly `Manchester United`. If credentials are absent, record the external credential blocker; do not change the configured team id by guess.

- [ ] **Step 8: Run focused/full tests and commit**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4   deno test functions/tests/m6/api_football_provider_test.ts             functions/tests/m6/fixture_service_test.ts             functions/tests/m6/fixture_handler_test.ts

docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4   deno test functions/tests
```

Commit:

```bash
git add supabase/functions/_shared/m6 supabase/functions/fixture-sync supabase/functions/tests/m6
git commit -m "feat: add fixture intelligence sync"
```

---

### Task 3: Notion Match Calendar projection

**Files:**
- Create: `supabase/functions/_shared/m6/match_calendar.ts`
- Modify: `supabase/functions/notion-sync/notion_client.ts`
- Create: `supabase/functions/tests/m6/match_calendar_test.ts`
- Modify: `supabase/functions/tests/notion-sync/notion_client_test.ts`

**Interfaces:**
- `buildMatchCalendarProperties(match, mode): Record<string, NotionProperty>`
- `projectMatchToCalendar(match, existingState, notion): Promise<MatchCalendarProjectionResult>`
- Extend the existing Notion client only if needed for the minimal additive schema/property operations; do not fork a second generic client.

Current connected workspace schema already has `경기`, `날짜`, `상대팀`, `결과`, and human-owned `콘텐츠 여부`. M6 adds system-owned properties rather than changing existing property types:
- `Match ID` rich text
- `Competition` rich text
- `Home/Away` select
- `Status` select
- `Score` rich text
- `Content Phase` select
- `Last Synced At` date

`콘텐츠 여부` is never written by the sync.

- [ ] **Step 1: Write RED property ownership tests**

Assert payload contains the system fields and explicitly excludes `콘텐츠 여부`:

```ts
const payload = buildMatchCalendarProperties(match, "MATCH_DAY_PRE");
assertEquals(payload["Match ID"], rich(match.id));
assertEquals(payload["Content Phase"], select("MATCH_DAY_PRE"));
assertEquals("콘텐츠 여부" in payload, false);
```

Test result mapping from Manchester United perspective:
- home 2–1 -> `승`
- home 1–1 -> `무`
- away 0–2 where MU is away -> `승`
- scheduled -> `미정`

- [ ] **Step 2: Implement stable Match Calendar upsert**

Use `app_private.match_calendar_sync_state.match_id` as canonical Notion page identity. Never derive identity from title/date.

On create, write all system-owned fields. On update, update system-owned fields only. If Notion schema is missing an expected additive field, return `MATCH_CALENDAR_SCHEMA_MISMATCH` and leave canonical match state untouched.

- [ ] **Step 3: Add safe Notion retry coverage**

Reuse existing Notion client semantics:
- 429 -> `Retry-After`
- 5xx/network -> bounded retry
- 401/403/400 -> fail fast
- no token/body leakage.

Add tests for projection failure preserving existing `match_calendar_sync_state` success data until a new projection succeeds.

- [ ] **Step 4: Run tests and commit**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4   deno test functions/tests/m6/match_calendar_test.ts functions/tests/notion-sync/notion_client_test.ts
```

Commit:

```bash
git add supabase/functions/_shared/m6/match_calendar.ts supabase/functions/notion-sync/notion_client.ts supabase/functions/tests
git commit -m "feat: project fixtures to notion calendar"
```

---

### Task 4: Representative reference media, signed thumbnails, and frozen briefing selection

**Files:**
- Create: `supabase/functions/_shared/m6/reference_media.ts`
- Create: `supabase/functions/_shared/m6/briefing.ts`
- Extend: `supabase/functions/_shared/m6/repository.ts`
- Create: `supabase/functions/tests/m6/reference_media_test.ts`
- Create: `supabase/functions/tests/m6/briefing_test.ts`

**Interfaces:**
- `selectRepresentativeReference(posts): RepresentativeReference | null`
- `createReferenceSignedUrl(asset, storage, expiresInSeconds = 600): Promise<string | null>`
- `buildMorningBriefingSnapshot(input): MorningBriefingSnapshot`
- `resolveBriefingPosition(briefing, position): FrozenBriefingItem | null`

Representative ordering is exact:

```text
has_cached_media DESC
match_confidence DESC NULLS LAST
cited_source_reliability DESC NULLS LAST
published_at DESC
raw_post_id ASC
```

Asset choice:
- REELS/VIDEO -> `THUMBNAIL` first, then image-compatible cached asset,
- CAROUSEL_ALBUM -> lowest `CAROUSEL_CHILD.carousel_index`,
- IMAGE -> `IMAGE`,
- otherwise text-only.

- [ ] **Step 1: Write RED deterministic reference tests**

Create shuffled inputs and assert they select the same post/asset regardless of input ordering. Include:
- higher match confidence wins,
- cached media beats otherwise comparable text-only post,
- reliability tie-break,
- newest tie-break,
- UUID/string final stable tie-break,
- Reel thumbnail,
- carousel first child,
- no asset returns permalink-only reference.

- [ ] **Step 2: Implement repository query for briefing candidates**

The briefing query must return candidate/cluster/creative state plus candidate posts with:
- `raw_post_id`
- `source_account.username`
- `story_cluster_posts.match_confidence`
- `raw_posts.permalink`
- `raw_posts.published_at`
- max reliability of an information source first cited by that post
- cached `media_assets` metadata.

Candidate ordering remains M4 rank/priority logic; representative media does not influence candidate rank.

- [ ] **Step 3: Implement private Storage signed URL**

Use the existing pinned Supabase client:

```ts
const { data, error } = await supabase.storage
  .from("instagram-analysis")
  .createSignedUrl(asset.storage_path, 600);
```

Store only `reference_media_asset_id` in the frozen briefing. Never persist the signed URL. A signed-URL error returns `null` and the candidate remains usable with its permalink.

- [ ] **Step 4: Write RED frozen snapshot tests**

Given a 09:00 brief:

```json
{
  "position": 2,
  "candidate_id": "candidate-b",
  "reference_post_id": "post-b",
  "reference_media_asset_id": "asset-b",
  "reference_username": "utddistrict",
  "reference_permalink": "https://www.instagram.com/p/abc/"
}
```

mutate live candidate ranking and representative post data, then assert `resolveBriefingPosition(savedBrief, 2)` still resolves exactly the frozen values above.

- [ ] **Step 5: Implement deterministic MorningBriefingSnapshot**

Snapshot fields must include:
- date/timezone/day mode,
- match context,
- overnight counts,
- exact Top 3 item order,
- score/flags/creative status captured at send time,
- frozen representative post/media/link/source identity,
- blocked/failed summary.

The LLM is not called in this function.

- [ ] **Step 6: Run tests and commit**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4   deno test functions/tests/m6/reference_media_test.ts functions/tests/m6/briefing_test.ts
```

Commit:

```bash
git add supabase/functions/_shared/m6/reference_media.ts supabase/functions/_shared/m6/briefing.ts supabase/functions/_shared/m6/repository.ts supabase/functions/tests/m6
git commit -m "feat: add visual morning briefing snapshots"
```

---

### Task 5: Telegram transport, morning briefing delivery, and priority/fixture alerts

**Files:**
- Create: `supabase/functions/_shared/m6/telegram_client.ts`
- Create: `supabase/functions/_shared/m6/openai.ts`
- Create: `supabase/functions/_shared/m6/alerts.ts`
- Create: `supabase/functions/telegram-morning-brief/handler.ts`
- Create: `supabase/functions/telegram-morning-brief/index.ts`
- Create: `supabase/functions/telegram-alerts/handler.ts`
- Create: `supabase/functions/telegram-alerts/index.ts`
- Create: `supabase/functions/tests/m6/telegram_client_test.ts`
- Create: `supabase/functions/tests/m6/morning_brief_handler_test.ts`
- Create: `supabase/functions/tests/m6/alerts_test.ts`

**Interfaces:**
- `TelegramClient.sendText(chatId, text): Promise<TelegramSendResult>`
- `TelegramClient.sendPhoto(chatId, photoUrl, caption): Promise<TelegramSendResult>`
- `phraseMorningBrief(snapshot, config): Promise<PhrasedBriefing>`
- `renderMorningBrief(snapshot, phrasing): TelegramMessagePlan[]`
- `scanCandidateAlertTransitions(now): Promise<number>`
- `dispatchPendingAlerts(): Promise<AlertDispatchSummary>`

M6 centralizes Telegram Bot API delivery in server-side Edge code so delivery success can atomically update `sent_at/status`; n8n remains trigger/forward orchestration only.

- [ ] **Step 1: Write RED Telegram client retry tests**

Mock Telegram API:
- `sendMessage` success,
- `sendPhoto` success,
- 429 with `parameters.retry_after` -> one bounded retry after requested delay,
- 500/network -> exponential retry,
- 401/403 -> no retry,
- response body/token never enters thrown/logged error text.

Use Bot API endpoints:
`https://api.telegram.org/bot<TOKEN>/sendMessage` and `/sendPhoto`.

- [ ] **Step 2: Implement safe Bot API transport**

Define outbound methods that accept already-rendered content only. Keep Telegram formatting deterministic; do not give the model direct access to chat ids, URLs, or API methods.

Candidate photo caption template includes direct source verification:

```text
1️⃣ Mainoo 부상 업데이트
Priority 88 · FIRST_MOVER
Reference: @utdreport
Creative Brief: READY

🔗 원문: https://www.instagram.com/p/...
/open 1
```

If `photoUrl === null`, call `sendText` with the same caption/link.

- [ ] **Step 3: Write RED constrained phrasing tests**

The model input contains a structured immutable payload with candidate ids/positions removed from prose generation authority. Require output shape:

```ts
interface PhrasedBriefing {
  intro: string;
  candidate_notes: Array<{ position: number; note: string }>;
  issue_note: string | null;
}
```

Validator rejects:
- unknown position,
- duplicate position,
- any URL,
- any ASCII digit in a candidate note,
- canonical status/flag tokens such as `Priority`, `FIRST_MOVER`, or `MUST_COVER` inside the generated note,
- note longer than configured bound.

This keeps all scores, flags, statuses, source links, and positions code-rendered rather than model-authored.

The final renderer always inserts canonical score/status/link itself.

- [ ] **Step 4: Implement LLM fallback behavior**

If OpenAI fails or returns invalid structured output:
- no retry beyond configured provider retries,
- use deterministic Korean templates,
- continue Telegram delivery,
- set `generation_metadata.render_mode = "FALLBACK_TEMPLATE"`.

No web-search tool is available to the M6 provider.

- [ ] **Step 5: Implement 09:00 delivery flow**

`telegram-morning-brief` must:
1. authenticate invoke secret,
2. force fixture refresh through shared service before snapshot compilation,
3. build/freeze snapshot,
4. persist `telegram_briefings`,
5. phrase with LLM or fallback,
6. send one short header text,
7. send up to three candidate photo/text messages in frozen order,
8. send compact totals/issues footer,
9. write all outbound messages to `telegram_messages` as `BRIEFING`,
10. set `sent_at` only after successful delivery.

The `(thread_id, briefing_date)` unique key is the morning-delivery idempotency boundary. A duplicate scheduler invocation for the same day returns the stored briefing and must not send a second morning package.

Partial fixture failure adds a warning but does not suppress the briefing.

- [ ] **Step 6: Write RED candidate transition alert tests**

State machine example:

```ts
false -> true  // create FIRST_MOVER event, transition=1
true  -> true  // no event
true  -> false // update state, no alert
false -> true  // create new event, transition=2
```

Fingerprint:

```ts
`FIRST_MOVER:${candidateId}:${transition}`
`MUST_COVER:${candidateId}:${transition}`
```

Fixture alert events are inserted by Task 2 and dispatched here.

- [ ] **Step 7: Implement alert dispatch**

For pending alerts:
- resolve owner thread/chat,
- use representative reference helper for candidate alerts,
- include Instagram permalink when present,
- send fixture change alerts text-only,
- mark event `SENT` only after Telegram success,
- leave event `PENDING`/safe `FAILED` for retriable failure,
- never resend `SENT` fingerprint.

- [ ] **Step 8: Run focused/full tests and commit**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4   deno test functions/tests/m6/telegram_client_test.ts             functions/tests/m6/morning_brief_handler_test.ts             functions/tests/m6/alerts_test.ts
```

Commit:

```bash
git add supabase/functions/_shared/m6 supabase/functions/telegram-morning-brief supabase/functions/telegram-alerts supabase/functions/tests/m6
git commit -m "feat: deliver telegram briefings and alerts"
```

---

### Task 6: Conversation memory and structured/text historical retrieval

**Files:**
- Create: `supabase/functions/_shared/m6/memory.ts`
- Create: `supabase/functions/_shared/m6/retrieval.ts`
- Extend: `supabase/functions/_shared/m6/openai.ts`
- Extend: `supabase/functions/_shared/m6/repository.ts`
- Create: `supabase/functions/tests/m6/memory_test.ts`
- Create: `supabase/functions/tests/m6/retrieval_test.ts`

**Interfaces:**
- `buildConversationContext(threadId, message, deps): Promise<ConversationContext>`
- `shouldRetrieveHistory(message: string): boolean`
- `retrieveHistoricalContext(query, thread, deps): Promise<HistoricalContext[]>`
- `maybeRollSummary(threadId, config, provider): Promise<void>`

- [ ] **Step 1: Write RED recent/summary tests**

Pin exact behavior:
- latest 12 raw messages appear in context,
- 13th older raw message does not,
- at 20 unsummarized messages, summary folds older messages and preserves latest 12 raw,
- all source rows remain in `telegram_messages`,
- live candidate score/status overrides stale text in `conversation_summary`,
- `/reset` later clears active pointers but not summary/raw history.

- [ ] **Step 2: Implement summary provider contract**

Summary prompt may preserve only:
- current/previous editorial subject,
- user wording/tone preferences,
- explicit editorial decisions,
- unresolved conversational questions.

It must not be treated as authority for scores, flags, current match status, current brief revision, or production state.

Persist summary + `summary_updated_at` + `summary_message_count` only after valid model output.

- [ ] **Step 3: Write RED retrieval-gate tests**

`shouldRetrieveHistory` should return true for explicit history terms such as:
- `지난주`, `지난 경기`, `전에`, `예전에`, `이전에`, `previous`, `last week`, `last match`.

It should return false for:
- `왜 이게 88점이야?`
- `이 근거가 뭐야?`
- `오늘 경기 관련 뭐가 중요해?`

- [ ] **Step 4: Implement structured-first retrieval**

Order:
1. if query references `지난 경기/last match`, load most recent FINISHED match then candidates/briefs in that match window;
2. if a named candidate/brief is active or recently opened, use relational ids;
3. tokenize meaningful query terms and search story title, Creative Brief headline, briefing snapshot text, and Telegram message content with bounded `ilike`/text filters;
4. return at most 5 compact records.

Do not add pgvector/embeddings in M6.

- [ ] **Step 5: Build read-only agent input**

Compose exactly:
1. static MU Editorial Agent rules,
2. rolling summary,
3. latest 12 raw messages,
4. active candidate/brief/match state freshly loaded from Supabase,
5. optional historical retrieval records,
6. new user message.

System rule includes:

```text
Natural-language conversation is read-only.
Never claim that a mutation occurred.
Never use external web search.
Project facts must come from supplied canonical context.
If evidence is insufficient, say so.
```

- [ ] **Step 6: Run tests and commit**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4   deno test functions/tests/m6/memory_test.ts functions/tests/m6/retrieval_test.ts
```

Commit:

```bash
git add supabase/functions/_shared/m6/memory.ts supabase/functions/_shared/m6/retrieval.ts supabase/functions/_shared/m6/openai.ts supabase/functions/_shared/m6/repository.ts supabase/functions/tests/m6
git commit -m "feat: add telegram conversation memory"
```

---

### Task 7: Slash commands, active context, and grounded targeted revisions

**Files:**
- Create: `supabase/functions/_shared/m6/commands.ts`
- Create: `supabase/functions/_shared/m6/revisions.ts`
- Create: `supabase/functions/telegram-agent/handler.ts`
- Create: `supabase/functions/telegram-agent/index.ts`
- Modify only if required for reusable validation: `supabase/functions/creative-generation/quality_gate.ts`
- Create: `supabase/functions/tests/m6/commands_test.ts`
- Create: `supabase/functions/tests/m6/revisions_test.ts`
- Create: `supabase/functions/tests/m6/telegram_agent_handler_test.ts`

**Interfaces:**
- `parseCommand(text: string): ParsedCommand | null`
- `executeCommand(command, thread, deps): Promise<CommandResult>`
- `reviseSlide(baseBrief, slideNumber, instruction, deps): Promise<StoredCreativeBrief>`
- `reviseCaption(baseBrief, instruction, deps): Promise<StoredCreativeBrief>`
- `selectHook(baseBrief, hookNumber, deps): Promise<StoredCreativeBrief>`

Supported parser grammar:

```text
/today
/open <1..3|uuid|alert>
/brief
/hook <1..3>
/slide <1..7> <non-empty natural-language instruction>
/caption <non-empty natural-language instruction>
/select
/status
/back
/reset
/confirm
/cancel
/help
```

- [ ] **Step 1: Write RED deterministic parser tests**

Examples:

```ts
assertEquals(parseCommand("/hook 3"), { type: "HOOK", hook: 3 });
assertEquals(parseCommand("/slide 3 더 짧고 직관적으로"), {
  type: "SLIDE",
  slide: 3,
  instruction: "더 짧고 직관적으로"
});
assertEquals(parseCommand("/caption 덜 자극적으로"), {
  type: "CAPTION",
  instruction: "덜 자극적으로"
});
assertEquals(parseCommand("훅 3번으로"), null);
```

Malformed commands return stable user-safe validation codes and never call OpenAI.

- [ ] **Step 2: Implement active context commands**

`/open 2`:
- resolve latest current-day frozen briefing,
- push current context onto a max-5 stack,
- set frozen candidate/brief/match pointers,
- return the frozen representative reference and create a fresh signed URL if the asset still exists.

`/open alert` resolves the most recent sent actionable alert.

`/back` pops one entry.

`/today` returns the latest stored morning briefing without creating a new briefing. `/brief` renders the latest active Creative Brief. `/status` loads current candidate score/flags, latest brief revision, pipeline state, and match context fresh from Supabase. `/help` returns the static v1 command reference.

`/reset` clears active pointers, context history, and pending action only; conversation messages/summary remain.

- [ ] **Step 3: Write RED revision immutability/grounding tests**

For base revision 3:
- `/hook 2` -> revision 4, `headline = hooks_json[1].text`, other content unchanged,
- `/slide 3 ...` -> revision 4 with only slide 3 changed,
- `/caption ...` -> revision 4 with only caption changed,
- base revision remains byte-equivalent,
- evidence snapshot stays identical,
- any new evidence id/source is rejected,
- modified FACT without valid evidence is rejected,
- modified INFERENCE without support is rejected.

- [ ] **Step 4: Implement targeted rewrite provider**

For `/slide`, the model receives:
- only base brief context needed to preserve style,
- target slide,
- frozen evidence snapshot,
- instruction,
- explicit rule that it may not add evidence/source ids.

Require strict output of one slide object. Reconstruct the full `CreativeBriefOutput`, then run the existing M5 deterministic `validateCreativeBrief` against the original evidence snapshot. If validation fails, reject the command; M6 does not run an automatic second creative rewrite.

For `/caption`, require only:

```json
{"body":"...","cta":"..."}
```

Then reconstruct/validate the full brief.

A successful `/hook`, `/slide`, or `/caption` insert creates `status = DRAFT`, preserves the original `evidence_snapshot`, records `generation_metadata.origin = "TELEGRAM_COMMAND"`, and then reuses the existing M5 Content Pipeline projection. If the current production item is EDITABLE, update its system-owned content. If it is LOCKED/APPROVED, projection occurs only through the confirmed protected branch and creates a new production item. Projection failure is recorded as a warning and never rolls back the new canonical revision.

- [ ] **Step 5: Implement append-only command fingerprint/idempotency**

Before executing a mutation, insert or load `telegram_command_events` keyed by inbound `telegram_update_id`. Derive revision fingerprint from stable inputs:

```ts
await sha256(canonicalJson({
  origin: "TELEGRAM_COMMAND",
  telegram_update_id,
  base_brief_id: base.id,
  command_type,
  args
}));
```

If the same Telegram update arrives again, return the previously stored `result_brief_id` and do not create another revision.

- [ ] **Step 6: Implement protected-state confirmation**

If pipeline state is `LOCKED` or `APPROVED`, store:

```json
{
  "command_event_id": "...",
  "command_type": "SLIDE",
  "base_brief_id": "...",
  "args": {"slide":3,"instruction":"..."},
  "requested_at": "..."
}
```

with `pending_action_expires_at = now + 10 minutes`.

`/confirm` must re-read:
- latest brief id/revision,
- latest pipeline state,
- pending expiry.

If base/latest state changed since proposal, return `STALE_PENDING_ACTION` and require a new command rather than applying against the wrong revision.

- [ ] **Step 7: Implement `/select` without parallel selection state**

Resolve `app_private.notion_sync_state.notion_page_id` for active candidate and update only:

```json
{"Selected":{"checkbox":true}}
```

on Daily Intelligence. Do not add a Supabase `selected` column. Existing M5 selected poll remains the generation contract.

- [ ] **Step 8: Implement Telegram agent handler**

Input is the Telegram update forwarded from n8n. Handler must:
1. authenticate `TELEGRAM_AGENT_INVOKE_SECRET`,
2. validate `from.id == TELEGRAM_OWNER_USER_ID`,
3. validate/initialize owner user + chat thread using server env and DB,
4. atomically claim the inbound `telegram_update_id` by inserting the USER message first,
5. if the unique claim already exists, return `ALREADY_PROCESSED` without a second model call or send,
6. route slash command or read-only conversation,
7. persist the assistant reply with `metadata.in_reply_to_update_id`,
8. send reply through server-side Telegram client,
9. update assistant delivery metadata after send,
10. roll summary when due.

Unauthorized user receives no project context and no mutation.

- [ ] **Step 9: Pin duplicate-delivery and stale-confirmation Review Focus tests**

Explicitly test:
- same update id twice -> one user row, one command event, one revision,
- same non-command update twice -> one assistant response recorded/sent,
- same morning scheduler invocation twice -> one stored/sent morning package,
- protected command proposed on r4, r5 created elsewhere, then `/confirm` -> `STALE_PENDING_ACTION`,
- confirmation after 10 minutes -> `PENDING_ACTION_EXPIRED`.

- [ ] **Step 10: Run tests and commit**

```bash
docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4   deno test functions/tests/m6/commands_test.ts             functions/tests/m6/revisions_test.ts             functions/tests/m6/telegram_agent_handler_test.ts

docker run --rm -v "$PWD/supabase:/workspace" -w /workspace denoland/deno:2.1.4   deno test functions/tests
```

Commit:

```bash
git add supabase/functions/_shared/m6 supabase/functions/telegram-agent supabase/functions/creative-generation/quality_gate.ts supabase/functions/tests/m6
git commit -m "feat: add telegram editorial commands"
```

---

### Task 8: n8n orchestration, production smoke, docs, and full regression

**Files:**
- Create: `n8n/workflows/fixture-sync-schedule.json`
- Create: `n8n/workflows/telegram-morning-brief.json`
- Create: `n8n/workflows/telegram-editorial-agent.json`
- Modify: `n8n/workflows/instagram-collector-schedule.json`
- Create: `scripts/fixtures/n8n/fixture-sync-schedule.json`
- Create: `scripts/fixtures/n8n/telegram-morning-brief.json`
- Create: `scripts/fixtures/n8n/telegram-editorial-agent.json`
- Modify: `scripts/validate-n8n-workflow.mjs`
- Modify: `scripts/validate-n8n-workflow.test.mjs`
- Create: `scripts/run-milestone-6-smoke.sh`
- Create: `scripts/verify-milestone-6-smoke.sql`
- Create: `supabase/tests/integration/milestone_6_telegram_integration_test.ts`
- Modify: `README.md`

**Interfaces:**
- Fixture schedule: every 15 minutes → `fixture-sync {"mode":"AUTO"}` → `telegram-alerts`.
- Morning schedule: exactly 09:00 Asia/Seoul → `telegram-morning-brief`; the function itself force-refreshes fixtures before compiling.
- Telegram update: Telegram Trigger → HTTP POST raw update to `telegram-agent`; the Edge Function sends the response via Bot API.
- Existing collector chain gains a non-blocking Telegram alert dispatch after successful intelligence/priority processing; alert failure must not invalidate collection/intelligence/Notion/M5 success.

- [ ] **Step 1: Write RED n8n validator tests**

Validator must assert:
- all new workflows `active:false` in git,
- timezone `Asia/Seoul`,
- morning schedule exactly 09:00,
- fixture schedule exactly 15-minute invocation cadence,
- Telegram Trigger forwards to `/functions/v1/telegram-agent`,
- HTTP nodes use credential references only,
- no bot token, API-Football key, Supabase secret, OpenAI key, or Notion token literal appears,
- M6 HTTP nodes use `Telegram Agent Invoke Secret`,
- alert dispatch branch is `continueOnFail:true`,
- no Code node contains scoring/selection/command logic.

- [ ] **Step 2: Create the three thin workflows**

Workflow intent only:

```text
Fixture Sync Schedule
Every 15 Minutes
  → POST fixture-sync {"mode":"AUTO"}
  → POST telegram-alerts
```

```text
Telegram Morning Brief
09:00 Asia/Seoul
  → POST telegram-morning-brief
```

```text
Telegram Editorial Agent
Telegram Trigger
  → POST telegram-agent with original update payload
```

Do not place memory, prompt, command parsing, candidate ranking, or alert fingerprint code in n8n.

- [ ] **Step 3: Add candidate-alert invocation to the existing collector flow**

After the M4/M5 success segment, invoke `telegram-alerts` as a non-blocking integration branch. Existing core pipeline order and failure semantics remain unchanged. The alert service itself performs the candidate false→true transition scan before dispatch, so n8n contains no flag-diff logic.

- [ ] **Step 4: Write RED integration smoke fixtures**

The local integration test must exercise controlled fixtures for:
1. one normal-day morning brief,
2. one MATCH_DAY_PRE brief,
3. three frozen candidates with representative image/carousel/reel assets,
4. one candidate without media but with permalink,
5. FIRST_MOVER transition + dedupe,
6. fixture kickoff change + dedupe,
7. `/open 2` after live ranking mutation,
8. read-only current question,
9. historical `지난 경기` lookup,
10. `/slide 3 ...` append-only revision,
11. duplicate Telegram update,
12. LOCKED confirmation stale race,
13. OpenAI phrasing failure fallback,
14. fixture provider failure with preserved previous state.

External APIs are mocked in the integration test. Real credential smoke is separate.

- [ ] **Step 5: Implement milestone smoke runner**

`scripts/run-milestone-6-smoke.sh` must:
- load ignored local env only,
- fail if required local Supabase vars are absent,
- run DB assertions and M6 integration tests,
- run n8n validators,
- run secret scan,
- optionally run real API-Football/OpenAI/Telegram/Notion smoke only when their required secrets are present,
- never print secret values.

Real Telegram smoke sends only to `TELEGRAM_OWNER_CHAT_ID`.

- [ ] **Step 6: Run the complete fresh regression**

Run from a clean M6 worktree:

```bash
supabase db reset --local
supabase seed buckets
supabase test db
supabase db lint --local --schema public,app_private --level warning

docker run --rm --add-host=host.docker.internal:host-gateway   -v "$PWD/supabase:/workspace" -w /workspace   denoland/deno:2.1.4 deno test --allow-env --allow-net functions/tests

node scripts/validate-n8n-workflow.mjs n8n/workflows/instagram-collector-schedule.json
node scripts/validate-n8n-workflow.mjs n8n/workflows/fixture-sync-schedule.json
node scripts/validate-n8n-workflow.mjs n8n/workflows/telegram-morning-brief.json
node scripts/validate-n8n-workflow.mjs n8n/workflows/telegram-editorial-agent.json
node --test scripts/validate-n8n-workflow.test.mjs

./scripts/run-milestone-4-smoke.sh --output /tmp/m4.json
./scripts/run-milestone-4-5-smoke.sh --output /tmp/m45.json
./scripts/run-milestone-5-smoke.sh
./scripts/run-milestone-6-smoke.sh
```

Then run a secret scan covering at least:
`FOOTBALL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_AGENT_INVOKE_SECRET`, `OPENAI_API_KEY`, `NOTION_TOKEN`, `SUPABASE_SECRET_KEY`, `sb_secret_`, and `Bearer `.

- [ ] **Step 7: Run real end-to-end smoke where credentials are available**

Verify actual behavior:
1. API-Football team 33 resolves to Manchester United.
2. fixture sync populates `public.matches`.
3. Match Calendar projection creates/updates without touching `콘텐츠 여부`.
4. Telegram receives a test Morning Brief with at least one source permalink; cached media candidate includes a thumbnail.
5. `/open 1` reopens the same frozen representative reference.
6. a natural-language question produces a read-only grounded response.
7. a safe test `/caption` or `/slide` creates one new revision only.
8. repeated same update does not create another revision.
9. a synthetic fixture/candidate transition sends one alert and repeated dispatch sends none.

If any external credential or API access is unavailable, report the exact blocker and keep local mocked verification green rather than substituting another provider/model.

- [ ] **Step 8: Update README**

Document:
- M6 architecture,
- API-Football provider and quota-aware cadence,
- required env vars,
- 09:00 brief behavior,
- thumbnail + Instagram permalink behavior,
- read-only natural language vs slash mutation commands,
- command quick reference,
- memory policy,
- local/real smoke commands,
- explicit M6 non-goals.

- [ ] **Step 9: Final branch review and commit**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -12
```

Confirm:
- no secret values,
- no unresolved implementation placeholders,
- all M6 spec requirements map to tests,
- existing M4/M4.5/M5 regressions are green.

Commit:

```bash
git add n8n scripts supabase/tests/integration README.md
git commit -m "test: verify milestone 6 end to end"
```

Do not merge `main` automatically. Offer local merge, push/PR, or keep the branch after a final whole-branch review.
