begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;
select plan(13);

select has_table(
  'app_private',
  'notion_sync_state',
  'private Notion sync state table exists'
);

select has_column('app_private', 'notion_sync_state', 'sync_identity', 'sync identity exists');
select has_column('app_private', 'notion_sync_state', 'candidate_id', 'candidate id exists');
select has_column('app_private', 'notion_sync_state', 'story_cluster_id', 'cluster id exists');
select has_column('app_private', 'notion_sync_state', 'ranking_date', 'ranking date exists');
select has_column('app_private', 'notion_sync_state', 'notion_page_id', 'Notion page id exists');
select has_column('app_private', 'notion_sync_state', 'last_synced_hash', 'sync hash exists');
select has_column('app_private', 'notion_sync_state', 'sync_status', 'sync status exists');

select ok(
  coalesce((
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app_private' and c.relname = 'notion_sync_state'
  ), false),
  'sync state has RLS enabled'
);

select ok(
  has_table_privilege('service_role', 'app_private.notion_sync_state', 'SELECT, INSERT, UPDATE, DELETE')
  and not has_table_privilege('anon', 'app_private.notion_sync_state', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.notion_sync_state', 'SELECT'),
  'sync state is service-role-only'
);

select ok(
  exists (
    select 1
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'app_private'
      and r.relname = 'notion_sync_state'
      and c.contype = 'p'
      and pg_get_constraintdef(c.oid) ilike '%sync_identity%'
  ),
  'sync identity is the primary key'
);

select ok(
  exists (
    select 1
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'app_private'
      and r.relname = 'notion_sync_state'
      and c.contype = 'u'
      and pg_get_constraintdef(c.oid) ilike '%story_cluster_id%'
      and pg_get_constraintdef(c.oid) ilike '%ranking_date%'
  ),
  'cluster and ranking date cannot duplicate a sync identity'
);

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'app_private'
      and tablename = 'notion_sync_state'
      and indexdef ilike '%notion_page_id%'
  ),
  'Notion page ids are unique when present'
);

select * from finish();
rollback;
