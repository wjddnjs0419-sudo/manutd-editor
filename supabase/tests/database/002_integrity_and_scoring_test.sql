begin;

set role postgres;
set search_path = pgtap, extensions, public;
select plan(11);

insert into public.source_accounts (id, username, region, priority_weight, api_supported)
values ('10000000-0000-0000-0000-000000000001', 'test_zero_followers', 'GLOBAL', 1, true);

select lives_ok(
  $$
    insert into public.raw_posts (
      id, source_account_id, external_post_id, media_type, published_at,
      collected_at, followers_count_at_collection, raw_payload
    ) values (
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      'zero-followers', 'IMAGE', now() - interval '1 minute', now(), 0, '{}'
    )
  $$,
  'zero followers is valid source data'
);

select lives_ok(
  $$
    insert into public.raw_posts (
      id, source_account_id, external_post_id, media_type, published_at,
      collected_at, followers_count_at_collection, raw_payload
    ) values (
      '20000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000001',
      'unknown-followers', 'IMAGE', now() - interval '1 minute', now(), null, '{}'
    )
  $$,
  'unknown followers is valid source data'
);

select throws_ok(
  $$
    insert into public.raw_posts (
      source_account_id, external_post_id, media_type, published_at,
      collected_at, followers_count_at_collection, raw_payload
    ) values (
      '10000000-0000-0000-0000-000000000001',
      'negative-followers', 'IMAGE', now() - interval '1 minute', now(), -1, '{}'
    )
  $$,
  '23514',
  null,
  'negative followers is rejected'
);

select is(
  app_private.calculate_weighted_engagement(100, 2, 4),
  108::numeric,
  'weighted engagement uses the selected comment multiplier'
);

select is(
  app_private.calculate_weighted_engagement(100, 2, 6),
  112::numeric,
  'weighted engagement changes deterministically with configuration'
);

select is(
  app_private.calculate_weighted_engagement(null, 2, 4),
  null::numeric,
  'missing metric input produces unknown weighted engagement'
);

select throws_ok(
  $$
    insert into public.scoring_configs (version, is_active, config)
    values (
      'second-active-config',
      true,
      '{"comment_multiplier": 4, "component_weights": {}}'
    )
  $$,
  '23505',
  null,
  'only one scoring configuration can be active'
);

select throws_ok(
  $$
    insert into public.information_sources (
      canonical_name, entity_type, reliability_score, reliability_rationale
    ) values ('Invalid source', 'REPORTER', 11, 'outside allowed range')
  $$,
  '23514',
  null,
  'source reliability is limited to zero through ten'
);

select throws_ok(
  $$
    insert into public.source_accounts (username, region, priority_weight)
    values ('invalid_weight', 'GLOBAL', 0)
  $$,
  '23514',
  null,
  'monitored account priority weight must be positive'
);

insert into public.story_clusters (
  id, canonical_title, first_seen_at, last_seen_at
)
values (
  '30000000-0000-0000-0000-000000000001',
  'Priority score generated-column fixture',
  now() - interval '2 hours',
  now()
);

insert into public.content_candidates (
  id,
  story_cluster_id,
  scoring_config_id,
  global_spread_score,
  engagement_outperformance_score,
  engagement_velocity_score,
  velocity_acceleration_score,
  korea_gap_score,
  first_mover_score,
  korean_saturation_score,
  reliability_score,
  source_diversity_score,
  freshness_score,
  data_confidence,
  ranking_date
)
values (
  '40000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  (select id from public.scoring_configs where version = 'v1'),
  12, 12, 10, 6, 15, 10, 10, 10, 5, 10,
  100,
  '2026-09-17'
);

select is(
  (
    select priority_score
    from public.content_candidates
    where id = '40000000-0000-0000-0000-000000000001'
  ),
  100::numeric,
  'priority score is generated from the ten objective components'
);

select throws_ok(
  $$
    update public.content_candidates
    set global_spread_score = 13
    where id = '40000000-0000-0000-0000-000000000001'
  $$,
  '23514',
  null,
  'candidate component scores cannot exceed their configured maximum'
);

select * from finish();
rollback;
