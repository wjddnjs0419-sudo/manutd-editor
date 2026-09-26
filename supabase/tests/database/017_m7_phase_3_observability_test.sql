begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(26);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'app_private.editorial_jobs'::regclass
      and pg_get_constraintdef(oid) ilike '%PROJECT_NOTION%'
  ),
  'editorial jobs support independent Notion projection'
);
select ok(to_regclass('public.editorial_job_status') is not null, 'editorial job status view exists');
select has_function('public', 'get_editorial_job_status', array[]::text[], 'editorial job status RPC exists');
select has_table('app_private', 'editorial_job_dead_alerts', 'dead alert outbox exists');
select has_column('app_private', 'editorial_job_dead_alerts', 'job_id', 'dead alert outbox stores job ids');
select has_column('app_private', 'editorial_job_dead_alerts', 'event_fingerprint', 'dead alert outbox stores fingerprints');
select has_column('app_private', 'editorial_job_dead_alerts', 'event_id', 'dead alert outbox stores materialized event ids');

select ok(
  has_function_privilege('service_role', 'public.get_editorial_job_status()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_editorial_job_status()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_editorial_job_status()', 'EXECUTE'),
  'status RPC is service-role-only'
);
select ok(
  has_table_privilege('service_role', 'public.editorial_job_status', 'SELECT')
    and not has_table_privilege('anon', 'public.editorial_job_status', 'SELECT')
    and not has_table_privilege('authenticated', 'public.editorial_job_status', 'SELECT'),
  'status view is service-role-only'
);

select public.enqueue_editorial_job(
  'PROJECT_NOTION',
  '{"creative_brief_id":"brief-1","stage":"PROJECT_NOTION"}'::jsonb,
  'creative-brief:brief-1:PROJECT_NOTION',
  3,
  '2026-09-27T00:00:00Z'::timestamptz
) as projection_job_id \gset
select is(
  public.enqueue_editorial_job(
    'PROJECT_NOTION',
    '{"creative_brief_id":"brief-1","stage":"PROJECT_NOTION"}'::jsonb,
    'creative-brief:brief-1:PROJECT_NOTION',
    3,
    '2026-09-27T00:01:00Z'::timestamptz
  ),
  :'projection_job_id'::uuid,
  'READY projection enqueue is idempotent'
);
select is(
  (select count(*)::integer from app_private.editorial_jobs where dedupe_key = 'creative-brief:brief-1:PROJECT_NOTION'),
  1,
  'READY projection stores one logical job'
);

insert into app_private.editorial_jobs (id, job_type, payload, dedupe_key, status, attempt_count, max_attempts, available_at, created_at, finished_at)
values
  ('00000000-0000-0000-0000-000000000101', 'COLLECT_INSTAGRAM', '{"chain_key":"status-instagram"}', 'status-instagram', 'SUCCEEDED', 1, 3, '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z', '2026-09-26T00:10:00Z'),
  ('00000000-0000-0000-0000-000000000102', 'RUN_INTELLIGENCE', '{"chain_key":"status-intelligence"}', 'status-intelligence', 'SUCCEEDED', 1, 3, '2026-09-26T01:00:00Z', '2026-09-26T01:00:00Z', '2026-09-26T01:10:00Z'),
  ('00000000-0000-0000-0000-000000000103', 'MORNING_BRIEF', '{"chain_key":"status-morning"}', 'status-morning', 'SUCCEEDED', 1, 3, '2026-09-26T02:00:00Z', '2026-09-26T02:00:00Z', '2026-09-26T02:10:00Z'),
  ('00000000-0000-0000-0000-000000000104', 'FIXTURE_SYNC', '{"chain_key":"status-pending"}', 'status-pending', 'PENDING', 1, 3, '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z', null),
  ('00000000-0000-0000-0000-000000000105', 'SYNC_NOTION', '{"chain_key":"status-running"}', 'status-running', 'RUNNING', 1, 3, '2026-09-26T03:00:00Z', '2026-09-26T03:00:00Z', null),
  ('00000000-0000-0000-0000-000000000106', 'PROJECT_NOTION', '{"chain_key":"status-failed"}', 'status-failed', 'FAILED', 1, 3, '2026-09-26T04:00:00Z', '2026-09-26T04:00:00Z', null),
  ('00000000-0000-0000-0000-000000000107', 'PROJECT_NOTION', '{"chain_key":"status-dead"}', 'status-dead', 'DEAD', 3, 3, '2026-09-26T05:00:00Z', '2026-09-26T05:00:00Z', '2026-09-26T05:10:00Z');

select pending_count, running_count, failed_retry_count, dead_count, oldest_pending_age_seconds,
  last_successful_instagram_pipeline, last_successful_intelligence_run, last_morning_brief
from public.get_editorial_job_status() \gset status_
select is(:'status_pending_count'::bigint, 2::bigint, 'status reports pending jobs including retryable projection work');
select is(:'status_running_count'::bigint, 1::bigint, 'status reports running jobs');
select is(:'status_failed_retry_count'::bigint, 2::bigint, 'status reports failed and retryable jobs');
select is(:'status_dead_count'::bigint, 1::bigint, 'status reports dead jobs');
select ok(:'status_oldest_pending_age_seconds'::bigint > 0, 'status reports oldest pending age');
select is(:'status_last_successful_instagram_pipeline'::timestamptz, '2026-09-26T00:10:00Z'::timestamptz, 'status reports last Instagram pipeline');
select is(:'status_last_successful_intelligence_run'::timestamptz, '2026-09-26T01:10:00Z'::timestamptz, 'status reports last intelligence run');
select is(:'status_last_morning_brief'::timestamptz, '2026-09-26T02:10:00Z'::timestamptz, 'status reports last morning brief');

delete from app_private.editorial_jobs;
select public.enqueue_editorial_job('FIXTURE_SYNC', '{}', 'dead-no-thread', 1, '2026-09-28T00:00:00Z'::timestamptz) as no_thread_job_id \gset
select public.claim_editorial_jobs('dead-worker', 1, '2026-09-28T00:00:00Z'::timestamptz, 300);
select status from public.fail_editorial_job(:'no_thread_job_id'::uuid, 'dead-worker', 'NOTION_DOWN', 'Notion unavailable', '2026-09-28T00:01:00Z'::timestamptz) \gset no_thread_
select is(:'no_thread_status'::text, 'DEAD'::text, 'critical failure becomes dead');
select is((select count(*)::integer from app_private.editorial_job_dead_alerts where job_id = :'no_thread_job_id'::uuid), 1, 'dead transition writes one outbox row');

insert into app_private.telegram_users (id, telegram_user_id, role, is_active)
values ('00000000-0000-0000-0000-000000000301', 90301, 'OWNER', true);
insert into app_private.telegram_threads (id, telegram_chat_id, telegram_user_id)
values ('00000000-0000-0000-0000-000000000302', 90302, '00000000-0000-0000-0000-000000000301');
select public.materialize_editorial_job_dead_alerts('00000000-0000-0000-0000-000000000302'::uuid) as materialized_count \gset
select is(:'materialized_count'::integer, 1, 'dead outbox materializes after owner thread exists');
select is((select count(*)::integer from app_private.telegram_alert_events where event_fingerprint = 'EDITORIAL_JOB_DEAD:' || :'no_thread_job_id'), 1, 'dead alert uses the existing Telegram event table');
select is(public.materialize_editorial_job_dead_alerts('00000000-0000-0000-0000-000000000302'::uuid), 0, 'repeated materialization does not duplicate dead alerts');

select public.enqueue_editorial_job('FIXTURE_SYNC', '{}', 'dead-with-thread', 1, '2026-09-28T01:00:00Z'::timestamptz) as with_thread_job_id \gset
select public.claim_editorial_jobs('dead-worker-2', 1, '2026-09-28T01:00:00Z'::timestamptz, 300);
select status from public.fail_editorial_job(:'with_thread_job_id'::uuid, 'dead-worker-2', 'DOWNSTREAM_5XX', 'safe', '2026-09-28T01:01:00Z'::timestamptz) \gset with_thread_
select is((select count(*)::integer from app_private.telegram_alert_events where event_fingerprint = 'EDITORIAL_JOB_DEAD:' || :'with_thread_job_id'), 1, 'dead transition creates a Telegram event when a thread exists');
select is((select count(*)::integer from app_private.telegram_alert_events where event_fingerprint = 'EDITORIAL_JOB_DEAD:' || :'with_thread_job_id'), 1, 'repeated dead handling cannot repeat the event');

select * from finish();
rollback;
