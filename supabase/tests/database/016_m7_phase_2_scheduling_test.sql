begin;

set role postgres;
create extension if not exists pg_cron;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(21);

select has_function(
  'public',
  'enqueue_scheduled_editorial_job',
  array['text', 'timestamp with time zone'],
  'scheduled enqueue RPC exists'
);
select ok(
  has_function_privilege('service_role', 'public.enqueue_scheduled_editorial_job(text,timestamptz)', 'EXECUTE'),
  'service role can execute scheduled enqueue RPC'
);
select ok(
  not has_function_privilege('anon', 'public.enqueue_scheduled_editorial_job(text,timestamptz)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.enqueue_scheduled_editorial_job(text,timestamptz)', 'EXECUTE'),
  'client roles cannot execute scheduled enqueue RPC'
);
select has_table('cron', 'job', 'pg_cron job catalog exists');
select is(
  (select count(*)::integer from cron.job where jobname in (
    'm7-instagram-collector-every-30-minutes',
    'm7-fixture-sync-every-15-minutes',
    'm7-morning-brief-0900-asia-seoul'
  )),
  3,
  'exactly three Phase 2 Cron jobs exist'
);
select is(
  (select schedule from cron.job where jobname = 'm7-instagram-collector-every-30-minutes'),
  '*/30 * * * *',
  'Instagram Cron runs every 30 minutes'
);
select is(
  (select schedule from cron.job where jobname = 'm7-fixture-sync-every-15-minutes'),
  '*/15 * * * *',
  'fixture Cron runs every 15 minutes'
);
select is(
  (select schedule from cron.job where jobname = 'm7-morning-brief-0900-asia-seoul'),
  '0 0 * * *',
  'morning brief Cron runs at 00:00 UTC / 09:00 Seoul'
);
select ok(
  (select count(*) from cron.job
    where jobname in (
      'm7-instagram-collector-every-30-minutes',
      'm7-fixture-sync-every-15-minutes',
      'm7-morning-brief-0900-asia-seoul'
    )
    and command ilike '%enqueue_scheduled_editorial_job%'
    and command not ilike '%/functions/v1/%'
    and command not ilike '%sb_secret_%'
    and command not ilike '%service_role%') = 3,
  'Cron invokes only the in-database safe enqueue RPC without HTTP or secrets'
);

select throws_ok(
  $$select public.enqueue_scheduled_editorial_job('DISPATCH_ALERTS', '2026-09-26T15:00:00Z'::timestamptz)$$,
  '22023', null,
  'scheduler rejects non-root job types'
);

select public.enqueue_scheduled_editorial_job('COLLECT_INSTAGRAM', '2026-09-26T14:29:59Z'::timestamptz) as instagram_before_half \gset
select is(
  (select dedupe_key from app_private.editorial_jobs where id = :'instagram_before_half'::uuid),
  'instagram-pipeline:202609262300',
  'Instagram 23:29:59 Seoul stays in the 23:00 bucket'
);

select public.enqueue_scheduled_editorial_job('COLLECT_INSTAGRAM', '2026-09-26T14:30:00Z'::timestamptz) as instagram_half \gset
select is(
  (select dedupe_key from app_private.editorial_jobs where id = :'instagram_half'::uuid),
  'instagram-pipeline:202609262330',
  'Instagram 23:30 Seoul starts the next bucket'
);

select public.enqueue_scheduled_editorial_job('COLLECT_INSTAGRAM', '2026-09-26T14:59:59Z'::timestamptz) as instagram_before_midnight \gset
select is(
  (select dedupe_key from app_private.editorial_jobs where id = :'instagram_before_midnight'::uuid),
  'instagram-pipeline:202609262330',
  'Instagram 23:59:59 Seoul stays in the 23:30 bucket'
);

select public.enqueue_scheduled_editorial_job('COLLECT_INSTAGRAM', '2026-09-26T15:00:00Z'::timestamptz) as instagram_midnight \gset
select is(
  (select dedupe_key from app_private.editorial_jobs where id = :'instagram_midnight'::uuid),
  'instagram-pipeline:202609270000',
  'Instagram midnight Seoul starts the next date bucket'
);

select public.enqueue_scheduled_editorial_job('FIXTURE_SYNC', '2026-09-26T14:14:59Z'::timestamptz) as fixture_before_quarter \gset
select is(
  (select dedupe_key from app_private.editorial_jobs where id = :'fixture_before_quarter'::uuid),
  'fixture-pipeline:202609262300',
  'fixture 23:14:59 Seoul stays in the 23:00 bucket'
);

select public.enqueue_scheduled_editorial_job('FIXTURE_SYNC', '2026-09-26T14:15:00Z'::timestamptz) as fixture_quarter \gset
select is(
  (select dedupe_key from app_private.editorial_jobs where id = :'fixture_quarter'::uuid),
  'fixture-pipeline:202609262315',
  'fixture 23:15 Seoul starts the next bucket'
);

select public.enqueue_scheduled_editorial_job('MORNING_BRIEF', '2026-09-26T14:59:59Z'::timestamptz) as morning_before_business_date \gset
select is(
  (select dedupe_key from app_private.editorial_jobs where id = :'morning_before_business_date'::uuid),
  'morning-brief:2026-09-26',
  'morning brief uses the Seoul business date before midnight'
);

select public.enqueue_scheduled_editorial_job('MORNING_BRIEF', '2026-09-26T15:00:00Z'::timestamptz) as morning_business_date \gset
select is(
  (select dedupe_key from app_private.editorial_jobs where id = :'morning_business_date'::uuid),
  'morning-brief:2026-09-27',
  'morning brief uses the next Seoul business date after midnight'
);

select is(
  public.enqueue_scheduled_editorial_job('MORNING_BRIEF', '2026-09-26T15:00:01Z'::timestamptz),
  :'morning_business_date'::uuid,
  'duplicate morning schedule invocation returns the original job id'
);
select is(
  (select count(*)::integer from app_private.editorial_jobs where dedupe_key = 'morning-brief:2026-09-27'),
  1,
  'duplicate morning schedule invocation stores one logical job'
);
select is(
  (select payload->>'chain_key' from app_private.editorial_jobs where id = :'morning_business_date'::uuid),
  'morning-brief:2026-09-27',
  'scheduled root payload carries its stable chain key'
);

select * from finish();
rollback;
