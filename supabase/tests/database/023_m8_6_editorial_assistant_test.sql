begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(29);

select has_column('public', 'source_accounts', 'monitor_role', 'Instagram accounts store monitoring role');
select ok(
  exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'source_account_monitor_role'
  ),
  'monitor role enum exists'
);
select ok((select monitor_role::text from public.source_accounts where username = 'manutd') = 'OFFICIAL', 'official account is classified separately');
select ok((select region from public.source_accounts where username = 'manutd') = 'GLOBAL', 'official account is global');
select ok(not exists (select 1 from public.source_accounts where username = 'manutd' and monitor_role::text = 'COMPETITOR'), 'official account is excluded from competitor pool');
select ok((select count(*)::integer from public.source_accounts where active and monitor_role::text = 'COMPETITOR' and region = 'KR') >= 8, 'Korean competitor pool is seeded');

select has_table('app_private', 'tracked_entities', 'tracked entity table exists');
select has_column('app_private', 'tracked_entities', 'hot_until', 'tracked entities store hot expiry');
select ok((select count(*)::integer from app_private.tracked_entities where active and entity_type = 'PLAYER' and tracking_tier = 'FIRST_TEAM') = 30, 'all first-team players are represented');
select ok(exists (select 1 from app_private.tracked_entities where canonical_name = 'Michael Carrick' and entity_type = 'MANAGER'), 'manager context is seeded');
select ok(exists (select 1 from pg_proc where proname = 'mark_tracked_entity_hot'), 'hot entity RPC exists');
select ok((select relrowsecurity from pg_class where oid = to_regclass('app_private.tracked_entities')), 'tracked entity RLS is enabled');
select ok(not has_table_privilege('anon', 'app_private.tracked_entities', 'SELECT') and not has_table_privilege('authenticated', 'app_private.tracked_entities', 'SELECT'), 'tracked entities are service-only');

select has_table('public', 'story_clusters', 'canonical stories exist');
select has_column('public', 'story_clusters', 'discovery_promotion_key', 'stories store promotion identity');
select has_column('app_private', 'discovery_runs', 'search_profile', 'runs store bounded search profile');
select has_column('app_private', 'discovery_queries', 'search_profile', 'queries store bounded search profile');
select has_column('app_private', 'story_claims', 'discovery_observation_id', 'claims can cite discovery observations');
select ok((select is_nullable = 'YES' from information_schema.columns where table_schema = 'app_private' and table_name = 'story_claims' and column_name = 'raw_post_id'), 'discovery claims do not require Instagram posts');
select ok(exists (select 1 from pg_constraint where conrelid = 'app_private.story_claims'::regclass and conname = 'story_claims_source_check'), 'claims require a raw post or discovery observation');
select ok(exists (select 1 from pg_constraint where conrelid = 'app_private.editorial_jobs'::regclass and pg_get_constraintdef(oid) ilike '%PROMOTE_DISCOVERY%'), 'promotion is a queue job type');

select has_table('app_private', 'telegram_story_alert_state', 'story alert state exists');
select has_column('app_private', 'telegram_alert_events', 'story_cluster_id', 'alerts identify canonical stories');
select ok(exists (select 1 from pg_constraint where conrelid = 'app_private.telegram_alert_events'::regclass and pg_get_constraintdef(oid) ilike '%BREAKING_STORY%'), 'story alert types are allowed');
select ok((select relrowsecurity from pg_class where oid = to_regclass('app_private.telegram_story_alert_state')), 'story alert state RLS is enabled');
select ok(has_table_privilege('service_role', 'app_private.telegram_story_alert_state', 'SELECT, INSERT, UPDATE, DELETE'), 'service role owns story alert state');

select ok(exists (select 1 from pg_proc where proname = 'enqueue_scheduled_discovery_job'), 'scheduled discovery helper exists');
select isnt_empty($$select 1 from cron.job where jobname = 'm8-6-discovery-fast-every-10-minutes'$$, 'FAST discovery cron exists');
select isnt_empty($$select 1 from cron.job where jobname = 'm8-6-discovery-player-sweep-every-hour'$$, 'PLAYER_SWEEP discovery cron exists');

select * from finish();
rollback;
