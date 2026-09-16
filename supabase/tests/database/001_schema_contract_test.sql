begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(31);

select has_table('public', 'source_accounts', 'source_accounts exists');
select has_table('public', 'raw_posts', 'raw_posts exists');
select has_table('public', 'media_assets', 'media_assets exists');
select has_table('public', 'post_metric_snapshots', 'post_metric_snapshots exists');
select has_table('public', 'story_clusters', 'story_clusters exists');
select has_table('public', 'story_cluster_posts', 'story_cluster_posts exists');
select has_table('public', 'information_sources', 'information_sources exists');
select has_table('public', 'story_cluster_sources', 'story_cluster_sources exists');
select has_table('public', 'scoring_configs', 'scoring_configs exists');
select has_table('public', 'content_candidates', 'content_candidates exists');
select has_table('public', 'creative_briefs', 'creative_briefs exists');
select has_table('public', 'published_posts', 'published_posts exists');
select has_table('public', 'performance_metrics', 'performance_metrics exists');

select col_is_pk('public', 'source_accounts', 'id', 'source_accounts uses id as primary key');
select col_is_pk('public', 'raw_posts', 'id', 'raw_posts uses id as primary key');
select col_is_pk('public', 'media_assets', 'id', 'media_assets uses id as primary key');
select col_is_pk('public', 'post_metric_snapshots', 'id', 'post_metric_snapshots uses id as primary key');
select col_is_pk('public', 'story_clusters', 'id', 'story_clusters uses id as primary key');
select col_is_pk('public', 'story_cluster_posts', array['story_cluster_id', 'raw_post_id'], 'story_cluster_posts uses a composite primary key');
select col_is_pk('public', 'information_sources', 'id', 'information_sources uses id as primary key');
select col_is_pk('public', 'story_cluster_sources', array['story_cluster_id', 'information_source_id'], 'story_cluster_sources uses a composite primary key');
select col_is_pk('public', 'scoring_configs', 'id', 'scoring_configs uses id as primary key');
select col_is_pk('public', 'content_candidates', 'id', 'content_candidates uses id as primary key');
select col_is_pk('public', 'creative_briefs', 'id', 'creative_briefs uses id as primary key');
select col_is_pk('public', 'published_posts', 'id', 'published_posts uses id as primary key');
select col_is_pk('public', 'performance_metrics', 'id', 'performance_metrics uses id as primary key');

select has_column('public', 'information_sources', 'canonical_name', 'information source stores a real entity name');
select has_column('public', 'information_sources', 'entity_type', 'information source stores an entity type');
select has_column('public', 'content_candidates', 'scoring_config_id', 'candidate references its scoring configuration');
select hasnt_column('public', 'post_metric_snapshots', 'weighted_engagement', 'weighted engagement is not persisted');
select ok(
  to_regprocedure('app_private.calculate_weighted_engagement(bigint,bigint,numeric)') is not null,
  'deterministic weighted engagement function exists'
);

select * from finish();
rollback;
