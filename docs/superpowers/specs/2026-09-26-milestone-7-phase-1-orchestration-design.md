# Milestone 7 Phase 1 Supabase-Native Orchestration Design

## Goal

Introduce a server-only Supabase job queue and bounded Edge Function worker for
editorial orchestration while preserving all M1–M6 business logic, readiness
state, creative-generation leases, append-only revisions, and existing n8n
workflows.

This phase is local-only. It does not delete, edit, or deploy n8n workflows.

## Architecture

`app_private.editorial_jobs` is the canonical orchestration queue. Its unique
nonblank `dedupe_key` makes enqueue idempotent, and its lease timestamps allow a
new worker to reclaim jobs abandoned by a crashed worker. All queue operations
are service-role-only Postgres RPCs; the table remains invisible to
`anon`/`authenticated` roles.

The `orchestration-worker` Edge Function authenticates with a dedicated
`ORCHESTRATION_WORKER_INVOKE_SECRET`, claims a small batch, and invokes the
existing Edge Function HTTP boundaries. It never imports or duplicates M1–M6
domain logic. Each claimed job is completed or failed independently, and
failure metadata is bounded and redacted before persistence.

## Queue contract

Supported job types are exactly `COLLECT_INSTAGRAM`, `RUN_INTELLIGENCE`,
`GENERATE_PRIORITY`, `SYNC_NOTION`, `POLL_SELECTED`, `DISPATCH_ALERTS`,
`FIXTURE_SYNC`, and `MORNING_BRIEF`. Statuses are `PENDING`, `RUNNING`,
`SUCCEEDED`, `FAILED`, and `DEAD`.

The claim RPC uses `FOR UPDATE SKIP LOCKED`, claims available pending jobs, and
reclaims expired running leases. Claiming increments `attempt_count`, records
the worker and lock time, and preserves the first `started_at`. Completion
requires the current worker owner. Failure records only a safe category and
bounded message; attempt 1 retries after five minutes, attempt 2 after fifteen
minutes, and the default third failed attempt becomes `DEAD`. A caller may set
an explicit positive `max_attempts`; attempts beyond the first two use the
same fifteen-minute delay until that limit is reached.

## Pipeline chaining

Successful stages enqueue the next stage with a stable derived dedupe key:

`COLLECT_INSTAGRAM → RUN_INTELLIGENCE → GENERATE_PRIORITY → SYNC_NOTION →
POLL_SELECTED → DISPATCH_ALERTS`

The chain key is carried in the job payload so retrying a stage cannot enqueue
duplicate downstream work. An intelligence `202 already_running` response is a
safe completed invocation but does not start priority generation until a later
queue run. Notion failure is isolated and never rolls back successful
intelligence or creative generation. Fixture sync and morning brief are
independent job types.

## Security and compatibility

The migration enables RLS, revokes table and RPC access from `public`, `anon`,
and `authenticated`, and grants only the required service-role privileges.
The worker keeps service-role credentials inside the Edge Function runtime and
passes only existing downstream invoke secrets to existing function endpoints.
No service-role key is placed in n8n, responses, logs, or persisted payloads.

## Verification

Database pgTAP tests cover schema constraints, dedupe idempotency, concurrent
claiming, lease reclaim, retry timing, dead-letter transition, owner-checked
completion, unauthorized access, and malformed job types. Deno tests cover
worker authentication, independent per-job outcomes, safe errors, downstream
enqueueing, `already_running`, and repeated invocation. A local deterministic
smoke test uses the real local queue RPCs and mocked existing-function
boundaries to prove `COLLECT_INSTAGRAM` is claimed and completed and exactly
one `RUN_INTELLIGENCE` job is present.
