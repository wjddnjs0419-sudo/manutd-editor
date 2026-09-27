begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(4);

select ok(
  (select pg_get_constraintdef(c.oid) like '%DISCOVER_SOURCES%'
    and pg_get_constraintdef(c.oid) like '%GROUND_CLAIMS%'
    and pg_get_constraintdef(c.oid) like '%RANK_EDITORIAL%'
   from pg_constraint c
   join pg_class r on r.oid = c.conrelid
   join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'app_private' and r.relname = 'editorial_jobs'
     and c.conname = 'editorial_jobs_job_type_check'),
  'editorial jobs allow all Phase B/C worker stages'
);

select has_function('public', 'enqueue_editorial_job', array['text', 'jsonb', 'text', 'integer', 'timestamp with time zone'], 'enqueue RPC remains available');

select public.enqueue_editorial_job('DISCOVER_SOURCES', '{}'::jsonb, 'm8-bc:discover', 3, now()) as discover_id \gset
select public.enqueue_editorial_job('GROUND_CLAIMS', '{}'::jsonb, 'm8-bc:ground', 3, now()) as ground_id \gset
select public.enqueue_editorial_job('RANK_EDITORIAL', '{}'::jsonb, 'm8-bc:rank', 3, now()) as rank_id \gset

select results_eq(
  $$select job_type from app_private.editorial_jobs where dedupe_key like 'm8-bc:%' order by job_type$$,
  $$values ('DISCOVER_SOURCES'), ('GROUND_CLAIMS'), ('RANK_EDITORIAL')$$,
  'Phase B/C stages can be enqueued through the service RPC'
);

select results_eq(
  $$select count(*)::integer from app_private.editorial_jobs where dedupe_key like 'm8-bc:%'$$,
  $$values (3)$$,
  'Phase B/C enqueue identities are distinct'
);

select * from finish();
rollback;
