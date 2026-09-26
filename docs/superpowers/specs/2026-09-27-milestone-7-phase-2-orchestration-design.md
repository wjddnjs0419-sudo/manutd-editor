# Milestone 7 Phase 2 Supabase-Native Orchestration Design

## Goal

Remove the runtime dependency on n8n for the Instagram schedule, fixture
schedule, morning brief schedule, and Telegram inbound webhook while preserving
the existing M1-M6 business logic and the Phase 1 orchestration queue/worker.

This phase is local/schema/test work only. It does not deploy production, delete
n8n exports, or commit any bot token, webhook secret, or project secret key.

## Existing behavior and parity target

The current n8n exports define four runtime responsibilities:

| Old n8n responsibility | Current behavior | New Supabase-native owner |
| --- | --- | --- |
| Instagram Collector Schedule | Every 30 minutes, Asia/Seoul; invokes the full collector/intelligence/creative/Notion/alert chain | Supabase Cron enqueues `COLLECT_INSTAGRAM`; `orchestration-worker` runs the existing chain one bounded job at a time |
| Fixture Sync Schedule | Every 15 minutes, Asia/Seoul; runs `FIXTURE_SYNC`, then alerts on success | Supabase Cron enqueues `FIXTURE_SYNC`; worker enqueues `DISPATCH_ALERTS` only after successful fixture sync |
| Telegram Morning Brief | 09:00 Asia/Seoul daily | Supabase Cron enqueues `MORNING_BRIEF`; `telegram-morning-brief` remains the business logic owner |
| Telegram Trigger | Receives Telegram updates and forwards the raw update to `telegram-agent` | Telegram POSTs directly to `telegram-agent` with `X-Telegram-Bot-Api-Secret-Token` |

The old n8n workflow files remain in the repository as historical/export
fixtures. The parity test documents the mapping and verifies the new path does
not require n8n.

## Architecture

### Supabase Cron and root enqueueing

The Phase 2 migration registers three `pg_cron` jobs:

- `m7-instagram-collector-every-30-minutes`: `*/30 * * * *`
- `m7-fixture-sync-every-15-minutes`: `*/15 * * * *`
- `m7-morning-brief-0900-asia-seoul`: `0 0 * * *` in the database's UTC cron timezone, which is 09:00 Asia/Seoul

Each Cron command calls the narrowly scoped
`public.enqueue_scheduled_editorial_job(text, timestamptz)` RPC. The RPC accepts
only the three root job types, derives a Seoul-local business bucket, and calls
the existing idempotent `public.enqueue_editorial_job` RPC. It never invokes an
Edge Function or executes a business pipeline.

Root dedupe keys are deterministic:

- `instagram-pipeline:<YYYYMMDDHHMM>` for the 30-minute Seoul bucket
- `fixture-pipeline:<YYYYMMDDHHMM>` for the 15-minute Seoul bucket
- `morning-brief:<YYYY-MM-DD>` for the Seoul business date

The payload carries the root `chain_key` and schedule identifier for tracing;
the business functions do not depend on scheduler metadata. Cron invokes SQL,
so no service-role key or other project secret is stored in migration source.

### Worker chaining

The existing Phase 1 worker remains the only component that invokes downstream
Edge Functions. Its chain becomes:

```text
COLLECT_INSTAGRAM
  -> RUN_INTELLIGENCE
  -> GENERATE_PRIORITY
  -> SYNC_NOTION
  -> POLL_SELECTED
  -> DISPATCH_ALERTS
```

`FIXTURE_SYNC` is an independent root that enqueues `DISPATCH_ALERTS` only when
its boundary returns a successful 2xx response. A failed fixture sync is retried
as its own job and does not dispatch alerts. `MORNING_BRIEF` remains terminal:
the existing function continues to own `businessDate()`, the intelligence
readiness gate, ALREADY_SENT behavior, forced fixture refresh, briefing
snapshot, and Telegram persistence. The worker only invokes it.

### Direct Telegram webhook

`telegram-agent` authentication will accept either:

1. `X-Telegram-Bot-Api-Secret-Token` compared against
   `TELEGRAM_WEBHOOK_SECRET`; or
2. an exact `Authorization: Bearer ...` value compared against the existing
   `TELEGRAM_AGENT_INVOKE_SECRET` for explicitly secured internal/test calls.

Both paths use timing-safe comparison. If neither configured secret validates,
the request is rejected; there is no unauthenticated fallback. Direct webhook
requests must contain a single Telegram update object with an integer
`update_id`, a supported `message`, an owner `message.from.id`, and a valid chat
id. The secured bearer compatibility path may continue accepting the existing
single-item/JSON-string normalization used by old tests; direct Telegram
requests do not need that n8n wrapper behavior.

Owner authorization remains based on `TELEGRAM_OWNER_USER_ID`. The existing
atomic insert keyed by `telegram_update_id` remains the dedupe boundary and is
performed before agent logic. Malformed updates are rejected before owner or
dedupe processing.

### Webhook registration

`scripts/register-telegram-webhook.sh` will require the webhook URL, bot token,
and webhook secret through environment variables or explicit shell variables.
It will call Telegram `setWebhook` with `url` and `secret_token`, fail on
non-success responses, and never print secret values. README instructions will
show the command without embedding real values.

## Security and secret boundaries

- Cron migrations contain no service-role key, bot token, webhook secret, or project secret key.
- The scheduler RPC is restricted to the database scheduler/service-role boundary and accepts only known root job types.
- The worker continues to keep service-role credentials inside its Edge Function runtime.
- Telegram webhook authentication uses the Telegram secret header; owner authorization remains separate and mandatory.
- Existing bearer invocation is allowed only when the configured internal secret matches timing-safely.
- Webhook and worker responses/logs contain safe status metadata only, never request secrets or downstream response bodies.

## Verification

Database tests will verify the three Cron jobs, exact schedules/commands,
Seoul-local bucket boundaries, root-job idempotency, allowed scheduler job
types, and service-role-only scheduler access. Edge Function tests will verify
the fixture chain, morning-brief invocation contract, direct Telegram header
authentication, secured bearer compatibility, malformed update rejection,
owner rejection, and duplicate update short-circuiting.

A Phase 2 parity integration test will document and exercise the old/new
mapping. The expanded local smoke suite will reset only the local database and
verify:

- all required Cron jobs exist schema-wise;
- duplicate schedule invocations create one logical root job per bucket;
- fixture success creates exactly one alert job;
- morning brief is enqueued as a root job and the existing handler contract is preserved;
- direct Telegram webhook authentication and `telegram_update_id` dedupe work;
- the tested flow runs with the Supabase queue/worker and mocked business boundaries, without n8n.

Production deployment and Telegram webhook registration are explicitly outside
this phase.

