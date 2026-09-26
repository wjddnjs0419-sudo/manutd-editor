begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(52);

select has_table('app_private', 'editorial_jobs', 'editorial jobs table exists');
select has_column('app_private', 'editorial_jobs', 'id', 'jobs have an id');
select has_column('app_private', 'editorial_jobs', 'job_type', 'jobs have a type');
select has_column('app_private', 'editorial_jobs', 'payload', 'jobs have a payload');
select has_column('app_private', 'editorial_jobs', 'dedupe_key', 'jobs have a dedupe key');
select has_column('app_private', 'editorial_jobs', 'status', 'jobs have a status');
select has_column('app_private', 'editorial_jobs', 'attempt_count', 'jobs track attempts');
select has_column('app_private', 'editorial_jobs', 'max_attempts', 'jobs track max attempts');
select has_column('app_private', 'editorial_jobs', 'available_at', 'jobs have availability');
select has_column('app_private', 'editorial_jobs', 'locked_at', 'jobs have lock timestamps');
select has_column('app_private', 'editorial_jobs', 'locked_by', 'jobs have lock owners');
select has_column('app_private', 'editorial_jobs', 'last_error_category', 'jobs store safe error categories');
select has_column('app_private', 'editorial_jobs', 'last_error_message', 'jobs store safe error messages');
select has_column('app_private', 'editorial_jobs', 'created_at', 'jobs have creation timestamps');
select has_column('app_private', 'editorial_jobs', 'started_at', 'jobs have start timestamps');
select has_column('app_private', 'editorial_jobs', 'finished_at', 'jobs have finish timestamps');
select has_column('app_private', 'editorial_jobs', 'updated_at', 'jobs have update timestamps');

select isnt_empty(
  $$select 1 from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'app_private'
     and r.relname = 'editorial_jobs'
     and c.contype = 'u'
     and pg_get_constraintdef(c.oid) ilike '%dedupe_key%'$$,
  'dedupe keys are unique'
);
select isnt_empty(
  $$select 1 from pg_indexes where schemaname = 'app_private' and indexname = 'editorial_jobs_status_available_idx'$$,
  'jobs have a status/availability index'
);
select isnt_empty(
  $$select 1 from pg_indexes where schemaname = 'app_private' and indexname = 'editorial_jobs_running_lock_idx'$$,
  'jobs have a running lock index'
);
select ok(
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('app_private.editorial_jobs')), false),
  'editorial jobs enable RLS'
);
select ok(
  has_table_privilege('service_role', 'app_private.editorial_jobs', 'SELECT, INSERT, UPDATE, DELETE'),
  'service role can operate on editorial jobs'
);
select ok(
  not has_table_privilege('anon', 'app_private.editorial_jobs', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.editorial_jobs', 'SELECT'),
  'client roles cannot read editorial jobs'
);

select has_function('public', 'enqueue_editorial_job', array['text', 'jsonb', 'text', 'integer', 'timestamp with time zone'], 'enqueue RPC exists');
select has_function('public', 'claim_editorial_jobs', array['text', 'integer', 'timestamp with time zone', 'integer'], 'claim RPC exists');
select has_function('public', 'complete_editorial_job', array['uuid', 'text', 'timestamp with time zone'], 'complete RPC exists');
select has_function('public', 'fail_editorial_job', array['uuid', 'text', 'text', 'text', 'timestamp with time zone'], 'fail RPC exists');
select ok(
  has_function_privilege('service_role', 'public.enqueue_editorial_job(text,jsonb,text,integer,timestamptz)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_editorial_jobs(text,integer,timestamptz,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.complete_editorial_job(uuid,text,timestamptz)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.fail_editorial_job(uuid,text,text,text,timestamptz)', 'EXECUTE'),
  'service role can execute all queue RPCs'
);
select ok(
  not has_function_privilege('anon', 'public.enqueue_editorial_job(text,jsonb,text,integer,timestamptz)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.enqueue_editorial_job(text,jsonb,text,integer,timestamptz)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.claim_editorial_jobs(text,integer,timestamptz,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.claim_editorial_jobs(text,integer,timestamptz,integer)', 'EXECUTE'),
  'client roles cannot execute queue RPCs'
);

select throws_ok(
  $$select public.enqueue_editorial_job('NOT_A_JOB', '{}'::jsonb, 'invalid-type', 3, '2026-09-26T00:00:00Z'::timestamptz)$$,
  '22023', null, 'enqueue rejects malformed job types'
);
select throws_ok(
  $$select public.enqueue_editorial_job('COLLECT_INSTAGRAM', '{}'::jsonb, '   ', 3, '2026-09-26T00:00:00Z'::timestamptz)$$,
  '22023', null, 'enqueue rejects blank dedupe keys'
);
select throws_ok(
  $$select public.enqueue_editorial_job('COLLECT_INSTAGRAM', '{}'::jsonb, 'invalid-attempts', 0, '2026-09-26T00:00:00Z'::timestamptz)$$,
  '22023', null, 'enqueue rejects invalid attempt limits'
);
select throws_ok(
  $$select * from public.claim_editorial_jobs('worker', 0, '2026-09-26T00:00:00Z'::timestamptz, 300)$$,
  '22023', null, 'claim rejects invalid limits'
);

select public.enqueue_editorial_job(
  'COLLECT_INSTAGRAM',
  '{"chain_key":"queue-test"}'::jsonb,
  'queue-test:collect',
  3,
  '2026-09-26T00:00:00Z'::timestamptz
) as first_job_id \gset
select ok(:'first_job_id' is not null, 'enqueue returns a job id');
select is(
  public.enqueue_editorial_job(
    'COLLECT_INSTAGRAM',
    '{"chain_key":"changed"}'::jsonb,
    'queue-test:collect',
    1,
    '2026-09-27T00:00:00Z'::timestamptz
  ),
  :'first_job_id'::uuid,
  'duplicate enqueue returns the original job id'
);
select is((select count(*)::integer from app_private.editorial_jobs where dedupe_key = 'queue-test:collect'), 1, 'duplicate enqueue stores one logical job');
select is((select count(*)::integer from public.claim_editorial_jobs('worker-a', 5, '2026-09-26T00:00:00Z'::timestamptz, 300)), 1, 'first worker claims the available job');
select is((select count(*)::integer from public.claim_editorial_jobs('worker-b', 5, '2026-09-26T00:00:01Z'::timestamptz, 300)), 0, 'second worker cannot claim the locked job');

insert into app_private.editorial_jobs (
  id, job_type, payload, dedupe_key, status, attempt_count, max_attempts,
  available_at, locked_at, locked_by, started_at
) values (
  '00000000-0000-0000-0000-000000000002', 'RUN_INTELLIGENCE', '{}', 'queue-test:expired',
  'RUNNING', 1, 3, '2026-09-25T23:00:00Z', '2026-09-25T23:00:00Z', 'dead-worker', '2026-09-25T23:00:00Z'
);
select is(
  (select id from public.claim_editorial_jobs('worker-a', 5, '2026-09-26T00:00:00Z'::timestamptz, 300)),
  '00000000-0000-0000-0000-000000000002'::uuid,
  'expired running jobs are reclaimed'
);
select is(
  public.complete_editorial_job('00000000-0000-0000-0000-000000000002', 'worker-a', '2026-09-26T00:01:00Z'::timestamptz),
  true,
  'current worker completes a claimed job'
);
select is((select status from app_private.editorial_jobs where id = '00000000-0000-0000-0000-000000000002'), 'SUCCEEDED', 'completion stores success');
select is(
  public.complete_editorial_job('00000000-0000-0000-0000-000000000002', 'worker-b', '2026-09-26T00:02:00Z'::timestamptz),
  false,
  'non-owner cannot complete a job'
);

select public.enqueue_editorial_job(
  'SYNC_NOTION', '{}', 'queue-test:retry', 3, '2026-09-26T00:00:00Z'::timestamptz
) as retry_job_id \gset
select is((select count(*)::integer from public.claim_editorial_jobs('retry-worker', 5, '2026-09-26T00:00:00Z'::timestamptz, 1800)), 1, 'retry job is claimed for the first attempt');
select status from public.fail_editorial_job(
  :'retry_job_id'::uuid,
  'retry-worker',
  'UPSTREAM_SECRET',
  'Bearer secret-token with a complete upstream body that must not persist',
  '2026-09-26T00:01:00Z'::timestamptz
) \gset retry_one_
select is(:'retry_one_status'::text, 'PENDING'::text, 'first failure returns the job to pending');
select is(
  (select available_at from app_private.editorial_jobs where id = :'retry_job_id'::uuid),
  '2026-09-26T00:06:00Z'::timestamptz,
  'first failure applies a five minute retry delay'
);
select is((select count(*)::integer from public.claim_editorial_jobs('retry-worker', 5, '2026-09-26T00:07:00Z'::timestamptz, 1800)), 1, 'retry job is claimed for the second attempt');
select status from public.fail_editorial_job(
  :'retry_job_id'::uuid,
  'retry-worker',
  'UPSTREAM_TIMEOUT',
  repeat('safe message ', 40),
  '2026-09-26T00:08:00Z'::timestamptz
) \gset retry_two_
select is(:'retry_two_status'::text, 'PENDING'::text, 'second failure remains retryable');
select is(
  (select available_at from app_private.editorial_jobs where id = :'retry_job_id'::uuid),
  '2026-09-26T00:23:00Z'::timestamptz,
  'second failure applies a fifteen minute retry delay'
);
select is((select count(*)::integer from public.claim_editorial_jobs('retry-worker', 5, '2026-09-26T00:24:00Z'::timestamptz, 1800)), 1, 'retry becomes claimable after the second delay');
select status from public.fail_editorial_job(
  :'retry_job_id'::uuid,
  'retry-worker',
  'UPSTREAM_TIMEOUT',
  'third failure',
  '2026-09-26T00:25:00Z'::timestamptz
) \gset retry_three_
select is(:'retry_three_status'::text, 'DEAD'::text, 'third failure dead letters the job');
select ok((select finished_at from app_private.editorial_jobs where id = :'retry_job_id'::uuid) is not null, 'dead jobs have a finish timestamp');
select ok(
  length((select last_error_message from app_private.editorial_jobs where id = :'retry_job_id'::uuid)) <= 240
    and (select last_error_message from app_private.editorial_jobs where id = :'retry_job_id'::uuid) not like '%secret-token%'
    and (select last_error_message from app_private.editorial_jobs where id = :'retry_job_id'::uuid) not like '%Bearer%',
  'failure persistence is bounded and redacted'
);

select * from finish();
rollback;
