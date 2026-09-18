begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;
select plan(23);

select has_table('public', 'creative_generation_configs', 'generation config table exists');
select has_column('public', 'creative_generation_configs', 'classifier_config', 'classifier config exists');
select has_column('public', 'creative_generation_configs', 'generation_config', 'generation config exists');
select has_column('public', 'creative_generation_configs', 'mode_configs', 'mode configs exists');
select has_column('public', 'creative_generation_configs', 'quality_gate_config', 'quality gate config exists');

select has_table('public', 'creative_briefs', 'existing creative brief table remains');
select has_column('public', 'creative_briefs', 'content_mode', 'creative mode metadata exists');
select has_column('public', 'creative_briefs', 'match_phase', 'match phase metadata exists');
select has_column('public', 'creative_briefs', 'generation_config_id', 'config identity exists');
select has_column('public', 'creative_briefs', 'input_fingerprint', 'input fingerprint exists');
select has_column('public', 'creative_briefs', 'evidence_snapshot', 'evidence snapshot exists');
select has_column('public', 'creative_briefs', 'grounding_json', 'grounding metadata exists');

select has_table('app_private', 'creative_generation_jobs', 'private generation jobs exist');
select has_column('app_private', 'creative_generation_jobs', 'lease_owner', 'job lease owner exists');
select has_column('app_private', 'creative_generation_jobs', 'repair_attempted', 'repair state exists');
select has_table('app_private', 'creative_pipeline_sync_state', 'private pipeline state exists');

create function pg_temp.m5_active_config_seeded()
returns boolean
language plpgsql
as $function$
declare
  v_count integer;
begin
  if to_regclass('public.creative_generation_configs') is null then return false; end if;
  execute 'select count(*) from public.creative_generation_configs where is_active' into v_count;
  return v_count = 1;
end
$function$;

create function pg_temp.m5_active_config_sections_are_objects()
returns boolean
language plpgsql
as $function$
declare
  v_valid boolean;
begin
  if to_regclass('public.creative_generation_configs') is null then return false; end if;
  execute 'select jsonb_typeof(classifier_config) = ''object''
    and jsonb_typeof(generation_config) = ''object''
    and jsonb_typeof(mode_configs) = ''object''
    and jsonb_typeof(quality_gate_config) = ''object''
    from public.creative_generation_configs where is_active'
    into v_valid;
  return coalesce(v_valid, false);
end
$function$;

create function pg_temp.m5_generation_jobs_are_service_role_only()
returns boolean
language plpgsql
as $function$
declare
  v_valid boolean;
begin
  if to_regclass('app_private.creative_generation_jobs') is null then return false; end if;
  execute 'select has_table_privilege(''service_role'', ''app_private.creative_generation_jobs'', ''SELECT, INSERT, UPDATE, DELETE'')
    and not has_table_privilege(''anon'', ''app_private.creative_generation_jobs'', ''SELECT'')
    and not has_table_privilege(''authenticated'', ''app_private.creative_generation_jobs'', ''SELECT'')'
    into v_valid;
  return coalesce(v_valid, false);
end
$function$;

select ok(
  pg_temp.m5_active_config_seeded(),
  'exactly one active generation config is seeded'
);

select ok(
  pg_temp.m5_active_config_sections_are_objects(),
  'active generation config sections are JSON objects'
);

select ok(
  coalesce((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relname = 'creative_generation_jobs'), false)
  and coalesce((select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relname = 'creative_pipeline_sync_state'), false),
  'private generation tables have RLS enabled'
);

select ok(
  pg_temp.m5_generation_jobs_are_service_role_only(),
  'generation jobs are service-role-only'
);

select ok(
  case when to_regclass('public.creative_generation_configs') is not null
    then exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'creative_generation_configs'
      and indexdef ilike '%is_active%')
      and exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'creative_briefs'
      and indexdef ilike '%candidate_id%input_fingerprint%')
    else false end,
  'active config and brief fingerprint uniqueness are indexed'
);

select ok(
  case when to_regclass('app_private.creative_generation_jobs') is not null
    then exists (select 1 from pg_indexes where schemaname = 'app_private' and tablename = 'creative_generation_jobs'
      and indexdef ilike '%candidate_id%input_fingerprint%')
    else false end,
  'generation job idempotency is indexed'
);

select ok(
  case when to_regclass('app_private.creative_generation_jobs') is not null
    then exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'app_private' and r.relname = 'creative_generation_jobs' and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%BLOCKED_EVIDENCE%')
      and exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'app_private' and r.relname = 'creative_generation_jobs' and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%FAILED_PROVIDER%')
    else false end,
  'job lifecycle includes all M5 terminal states'
);

select * from finish();
rollback;
