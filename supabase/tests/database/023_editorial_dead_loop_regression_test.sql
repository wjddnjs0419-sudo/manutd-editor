begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

delete from app_private.editorial_jobs;

select plan(21);

select public.enqueue_scheduled_editorial_job(
  'COLLECT_INSTAGRAM',
  '2026-09-29T12:00:00Z'::timestamptz
) as scheduled_job_id \gset

select ok(
  (select payload ? 'as_of' from app_private.editorial_jobs where id = :'scheduled_job_id'::uuid),
  'scheduled root jobs carry an as_of timestamp for downstream JSON handlers'
);
select is(
  (select (payload->>'as_of')::timestamptz from app_private.editorial_jobs where id = :'scheduled_job_id'::uuid),
  '2026-09-29T12:00:00Z'::timestamptz,
  'scheduled root jobs preserve the requested timestamp'
);
select public.enqueue_scheduled_editorial_job(
  'COLLECT_INSTAGRAM',
  '2026-09-29T12:00:00Z'::timestamptz
) as duplicate_job_id \gset
select is(
  :'duplicate_job_id'::uuid,
  :'scheduled_job_id'::uuid,
  'repeating the same schedule bucket returns the original job'
);
select is(
  (select count(*)::integer from app_private.editorial_jobs where dedupe_key = 'instagram-pipeline:202609292100'),
  1,
  'repeating the same schedule bucket stores one logical job'
);

select public.enqueue_editorial_job(
  'FIXTURE_SYNC',
  '{}',
  'retry-loop:successful-after-retries',
  3,
  '2026-09-29T14:00:00Z'::timestamptz
) as retry_job_id \gset
select is(
  (select count(*)::integer from public.claim_editorial_jobs('retry-worker', 1, '2026-09-29T14:00:00Z'::timestamptz, 300)),
  1,
  'a retryable job is claimed for its first attempt'
);
select status from public.fail_editorial_job(
  :'retry_job_id'::uuid,
  'retry-worker',
  'TEMPORARY_DOWNSTREAM_ERROR',
  'temporary failure',
  '2026-09-29T14:01:00Z'::timestamptz
) \gset retry_one_
select is(:'retry_one_status'::text, 'PENDING'::text, 'the first failure schedules a retry');
select is(
  (select count(*)::integer from public.claim_editorial_jobs('retry-worker', 1, '2026-09-29T14:06:00Z'::timestamptz, 300)),
  1,
  'the retryable job is claimable after the first backoff'
);
select status from public.fail_editorial_job(
  :'retry_job_id'::uuid,
  'retry-worker',
  'TEMPORARY_DOWNSTREAM_ERROR',
  'temporary failure',
  '2026-09-29T14:07:00Z'::timestamptz
) \gset retry_two_
select is(:'retry_two_status'::text, 'PENDING'::text, 'the second failure schedules another retry');
select is(
  (select count(*)::integer from public.claim_editorial_jobs('retry-worker', 1, '2026-09-29T14:22:00Z'::timestamptz, 300)),
  1,
  'the retryable job is claimable after the second backoff'
);
select ok(
  public.complete_editorial_job(
    :'retry_job_id'::uuid,
    'retry-worker',
    '2026-09-29T14:23:00Z'::timestamptz
  ),
  'a successfully recovered job completes normally'
);
select is(
  (select status from app_private.editorial_jobs where id = :'retry_job_id'::uuid),
  'SUCCEEDED'::text,
  'successful editorial flows remain successful after retries'
);

select public.enqueue_editorial_job(
  'FIXTURE_SYNC',
  '{}',
  'dead-loop:retry-exhaustion',
  1,
  '2026-09-29T13:00:00Z'::timestamptz
) as dead_job_id \gset
select is(
  (select count(*)::integer from public.claim_editorial_jobs('dead-loop-worker', 1, '2026-09-29T13:00:00Z'::timestamptz, 300)),
  1,
  'a retryable job is claimed once'
);
select status from public.fail_editorial_job(
  :'dead_job_id'::uuid,
  'dead-loop-worker',
  'DOWNSTREAM_HTTP_400',
  'downstream rejected the request',
  '2026-09-29T13:01:00Z'::timestamptz
) \gset dead_
select is(:'dead_status'::text, 'DEAD'::text, 'retry exhaustion transitions the job to DEAD');
select is(
  (select attempt_count from app_private.editorial_jobs where id = :'dead_job_id'::uuid),
  1,
  'DEAD preserves the exhausted attempt count'
);
select is(
  (select count(*)::integer from public.claim_editorial_jobs('dead-loop-worker-2', 1, '2026-09-29T13:02:00Z'::timestamptz, 300)),
  0,
  'normal reconciliation does not claim DEAD jobs'
);
select throws_ok(
  $$select * from public.fail_editorial_job(:'dead_job_id'::uuid, 'dead-loop-worker', 'AGAIN', 'must not transition again', '2026-09-29T13:03:00Z'::timestamptz)$$,
  '42501',
  null,
  'DEAD jobs cannot transition to DEAD again'
);
select is(
  (select count(*)::integer from app_private.editorial_job_dead_alerts where job_id = :'dead_job_id'::uuid),
  1,
  'the DEAD transition creates one durable outbox row'
);

delete from app_private.telegram_threads where id = '00000000-0000-0000-0000-000000000502'::uuid;
delete from app_private.telegram_users where id = '00000000-0000-0000-0000-000000000501'::uuid;
insert into app_private.telegram_users (id, telegram_user_id, role, is_active)
values ('00000000-0000-0000-0000-000000000501', 90501, 'OWNER', true);
insert into app_private.telegram_threads (id, telegram_chat_id, telegram_user_id)
values ('00000000-0000-0000-0000-000000000502', 90502, '00000000-0000-0000-0000-000000000501');
select is(
  public.materialize_editorial_job_dead_alerts('00000000-0000-0000-0000-000000000502'::uuid),
  1,
  'the first reconciliation materializes one DEAD alert'
);
select is(
  (select count(*)::integer from app_private.telegram_alert_events where event_fingerprint = 'EDITORIAL_JOB_DEAD:' || :'dead_job_id'),
  1,
  'the DEAD alert has one deterministic event fingerprint'
);
select is(
  public.materialize_editorial_job_dead_alerts('00000000-0000-0000-0000-000000000502'::uuid),
  0,
  'a later reconciliation does not materialize another DEAD alert'
);
select is(
  (select count(*)::integer from app_private.telegram_alert_events where event_fingerprint = 'EDITORIAL_JOB_DEAD:' || :'dead_job_id'),
  1,
  'reconciliation preserves exactly one DEAD alert event'
);

select * from finish();
rollback;
