begin;

set role postgres;
set search_path = pgtap, extensions, public;
select plan(9);

select is(
  (
    select count(*)::integer
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(array[
        'source_accounts', 'raw_posts', 'media_assets', 'post_metric_snapshots',
        'story_clusters', 'story_cluster_posts', 'information_sources',
        'story_cluster_sources', 'scoring_configs', 'content_candidates',
        'creative_briefs', 'published_posts', 'performance_metrics'
      ])
      and c.relrowsecurity
  ),
  13,
  'RLS is enabled on every application table'
);

select is(
  (
    select count(*)::integer
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and table_name = any(array[
        'source_accounts', 'raw_posts', 'media_assets', 'post_metric_snapshots',
        'story_clusters', 'story_cluster_posts', 'information_sources',
        'story_cluster_sources', 'scoring_configs', 'content_candidates',
        'creative_briefs', 'published_posts', 'performance_metrics'
      ])
  ),
  0,
  'client roles have no direct table grants in Milestone 1'
);

select ok(
  has_table_privilege('service_role', 'public.raw_posts', 'SELECT, INSERT, UPDATE, DELETE'),
  'service role can operate on backend tables'
);

select is((select count(*)::integer from public.source_accounts), 10, 'ten monitored accounts are seeded');
select is((select count(*)::integer from public.information_sources), 5, 'five real information source entities are seeded');
select is((select count(*)::integer from public.scoring_configs where is_active), 1, 'one scoring configuration is active');

select results_eq(
  $$
    select canonical_name::text, entity_type::text, reliability_score::integer
    from public.information_sources
    order by canonical_name::text
  $$,
  $$
    values
      ('BBC Sport', 'MEDIA_OUTLET', 8),
      ('Fabrizio Romano', 'REPORTER', 9),
      ('Manchester United', 'CLUB', 10),
      ('Sky Sports', 'MEDIA_OUTLET', 8),
      ('The Athletic', 'MEDIA_OUTLET', 8)
  $$,
  'seed registry contains named entities rather than reliability categories'
);

select is(
  (
    select (config ->> 'comment_multiplier')::numeric
    from public.scoring_configs
    where is_active
  ),
  4::numeric,
  'active v1 config uses the approved comment multiplier'
);

select is(
  (
    select sum(value::numeric)
    from public.scoring_configs,
      jsonb_each_text(config -> 'component_weights')
    where is_active
  ),
  100::numeric,
  'active v1 component maxima total one hundred points'
);

select * from finish();
rollback;
