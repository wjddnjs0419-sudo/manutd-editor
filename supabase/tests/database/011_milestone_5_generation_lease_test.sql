begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;
select plan(5);

select has_function(
  'public',
  'try_acquire_creative_generation_job',
  ARRAY['uuid', 'text', 'timestamp with time zone', 'timestamp with time zone'],
  'creative generation lease RPC exists'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.try_acquire_creative_generation_job(uuid, text, timestamp with time zone, timestamp with time zone)',
    'EXECUTE'
  ),
  'creative generation lease RPC is callable by service role'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.try_acquire_creative_generation_job(uuid, text, timestamp with time zone, timestamp with time zone)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.try_acquire_creative_generation_job(uuid, text, timestamp with time zone, timestamp with time zone)',
    'EXECUTE'
  ),
  'creative generation lease RPC is not public'
);

select ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'try_acquire_creative_generation_job'
      and p.prosecdef = false
      and p.proconfig @> array['search_path=""']::text[]
  ),
  'creative generation lease RPC is invoker scoped with empty search path'
);

select ok(
  exists (
    select 1 from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'app_private'
      and r.relname = 'creative_generation_jobs'
      and c.contype = 'u'
      and pg_get_constraintdef(c.oid) ilike '%candidate_id%input_fingerprint%'
  ),
  'generation jobs have candidate/fingerprint uniqueness'
);

select * from finish();
rollback;
