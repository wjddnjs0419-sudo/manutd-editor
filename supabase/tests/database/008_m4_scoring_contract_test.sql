begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;
select plan(16);

create function pg_temp.m4_scoring_contract_fixture()
returns setof text
language plpgsql
as $fixture$
declare
  v_run_at constant timestamptz := '2026-09-18 12:00:00+00';
  v_ranking_date constant date := '2026-09-18';
  v_config uuid;
  v_global uuid;
  v_kr uuid;
  v_global_cluster uuid;
  v_kr_cluster uuid;
  v_global_post uuid;
  v_kr_post uuid;
  v_candidate record;
  v_i integer;
begin
  select id into v_config
  from public.scoring_configs
  where is_active
  order by effective_from desc
  limit 1;

  select id into v_global from public.source_accounts where username = 'utdreport';
  select id into v_kr from public.source_accounts where username = 'mufc_gossip_';

  update public.source_accounts
  set active = true,
      api_supported = true,
      priority_weight = 1,
      last_probe_at = v_run_at,
      probe_error = null
  where id in (v_global, v_kr);

  update public.source_accounts
  set active = false
  where region = 'GLOBAL'
    and id <> v_global;

  insert into public.story_clusters (
    canonical_title,
    first_seen_at,
    last_seen_at,
    global_account_count,
    korean_account_count,
    global_weight_coverage,
    korean_weight_coverage,
    independent_source_count,
    highest_source_reliability
  ) values (
    'M4 scoring global fixture',
    v_run_at - interval '2 hours',
    v_run_at - interval '2 hours',
    1,
    0,
    1,
    0,
    1,
    10
  ) returning id into v_global_cluster;

  insert into public.raw_posts (
    source_account_id,
    external_post_id,
    media_type,
    published_at,
    collected_at,
    like_count,
    comments_count,
    followers_count_at_collection,
    raw_payload
  ) values (
    v_global,
    'm4-scoring-global-target',
    'IMAGE',
    v_run_at - interval '2 hours',
    v_run_at - interval '1 hour',
    250,
    10,
    1000,
    '{}'::jsonb
  ) returning id into v_global_post;

  perform public.upsert_story_cluster_member(
    v_global_post,
    v_global_cluster,
    'DETERMINISTIC',
    0.95,
    '{"entities":["bruno_fernandes"],"dictionary_version":"entity-v1"}'::jsonb
  );

  insert into public.post_metric_snapshots (
    raw_post_id,
    captured_at,
    capture_bucket_start,
    followers_count,
    like_count,
    comments_count,
    post_age_minutes
  ) values
    (v_global_post, v_run_at - interval '30 minutes', v_run_at - interval '30 minutes', 1000, 200, 10, 90),
    (v_global_post, v_run_at - interval '60 minutes', v_run_at - interval '60 minutes', 1000, 100, 5, 60),
    (v_global_post, v_run_at - interval '90 minutes', v_run_at - interval '90 minutes', 1000, 50, 2, 30);

  for v_i in 1..5 loop
    insert into public.raw_posts (
      source_account_id,
      external_post_id,
      media_type,
      published_at,
      collected_at,
      like_count,
      comments_count,
      followers_count_at_collection,
      raw_payload
    ) values (
      v_global,
      'm4-scoring-global-baseline-' || v_i,
      'IMAGE',
      v_run_at - interval '2 hours',
      v_run_at - interval '1 hour',
      20,
      1,
      1000,
      '{}'::jsonb
    ) returning id into v_global_post;

    insert into public.post_metric_snapshots (
      raw_post_id,
      captured_at,
      capture_bucket_start,
      followers_count,
      like_count,
      comments_count,
      post_age_minutes
    ) values
      (v_global_post, v_run_at - interval '30 minutes', v_run_at - interval '30 minutes', 1000, 80, 2, 90),
      (v_global_post, v_run_at - interval '60 minutes', v_run_at - interval '60 minutes', 1000, 60, 1, 60),
      (v_global_post, v_run_at - interval '90 minutes', v_run_at - interval '90 minutes', 1000, 40, 1, 30);
  end loop;

  insert into public.story_clusters (
    canonical_title,
    first_seen_at,
    last_seen_at,
    global_account_count,
    korean_account_count,
    global_weight_coverage,
    korean_weight_coverage,
    independent_source_count,
    highest_source_reliability
  ) values (
    'M4 scoring Korea fixture',
    v_run_at - interval '2 hours',
    v_run_at - interval '2 hours',
    0,
    1,
    0,
    1,
    1,
    9
  ) returning id into v_kr_cluster;

  insert into public.raw_posts (
    source_account_id,
    external_post_id,
    media_type,
    published_at,
    collected_at,
    like_count,
    comments_count,
    followers_count_at_collection,
    raw_payload
  ) values (
    v_kr,
    'm4-scoring-kr-target',
    'IMAGE',
    v_run_at - interval '2 hours',
    v_run_at - interval '1 hour',
    180,
    8,
    1000,
    '{}'::jsonb
  ) returning id into v_kr_post;

  perform public.upsert_story_cluster_member(
    v_kr_post,
    v_kr_cluster,
    'DETERMINISTIC',
    0.95,
    '{"entities":["bruno_fernandes"],"dictionary_version":"entity-v1"}'::jsonb
  );

  insert into public.post_metric_snapshots (
    raw_post_id,
    captured_at,
    capture_bucket_start,
    followers_count,
    like_count,
    comments_count,
    post_age_minutes
  ) values
    (v_kr_post, v_run_at - interval '30 minutes', v_run_at - interval '30 minutes', 1000, 40, 2, 90),
    (v_kr_post, v_run_at - interval '60 minutes', v_run_at - interval '60 minutes', 1000, 30, 1, 60),
    (v_kr_post, v_run_at - interval '90 minutes', v_run_at - interval '90 minutes', 1000, 20, 1, 30);

  for v_i in 1..5 loop
    insert into public.raw_posts (
      source_account_id,
      external_post_id,
      media_type,
      published_at,
      collected_at,
      like_count,
      comments_count,
      followers_count_at_collection,
      raw_payload
    ) values (
      v_kr,
      'm4-scoring-kr-baseline-' || v_i,
      'IMAGE',
      v_run_at - interval '2 hours',
      v_run_at - interval '1 hour',
      20,
      1,
      1000,
      '{}'::jsonb
    ) returning id into v_kr_post;

    insert into public.post_metric_snapshots (
      raw_post_id,
      captured_at,
      capture_bucket_start,
      followers_count,
      like_count,
      comments_count,
      post_age_minutes
    ) values
      (v_kr_post, v_run_at - interval '30 minutes', v_run_at - interval '30 minutes', 1000, 80, 2, 90),
      (v_kr_post, v_run_at - interval '60 minutes', v_run_at - interval '60 minutes', 1000, 60, 1, 60),
      (v_kr_post, v_run_at - interval '90 minutes', v_run_at - interval '90 minutes', 1000, 40, 1, 30);
  end loop;

  perform public.calculate_priority_candidates(v_run_at, v_ranking_date);

  select cc.* into v_candidate
  from public.content_candidates cc
  where cc.story_cluster_id = v_global_cluster
    and cc.ranking_date = v_ranking_date
    and cc.scoring_config_id = v_config;

  return next is(v_candidate.engagement_outperformance_score > 0, true, 'global outperformance is calculated');
  return next is(v_candidate.engagement_velocity_score > 0, true, 'global velocity is calculated');
  return next is(v_candidate.velocity_acceleration_score > 0, true, 'velocity acceleration is calculated');
  return next is(v_candidate.korea_gap_score > 0, true, 'known Korea coverage gap is calculated');
  return next is(v_candidate.first_mover_score > 0, true, 'first mover window score is calculated');
  return next is(v_candidate.data_confidence > 0, true, 'data confidence is calculated');
  return next is(v_candidate.first_mover_flag, true, 'first mover flag applies all gates');
  return next is(v_candidate.must_cover_flag, true, 'must cover flag applies all gates');
  return next is(v_candidate.rank is not null, true, 'candidate rank is persisted');
  return next is(v_candidate.score_inputs ? 'global_outperformance_ratio', true, 'outperformance ratio is audited');
  return next is(v_candidate.score_inputs ? 'global_velocity_ratio', true, 'velocity ratio is audited');
  return next is(v_candidate.score_inputs ? 'acceleration_ratio', true, 'acceleration ratio is audited');
  return next is(v_candidate.score_inputs ? 'data_confidence_components', true, 'confidence components are audited');
  return next is(
    (select korea_coverage_status from public.content_candidates where story_cluster_id = v_kr_cluster and ranking_date = v_ranking_date and scoring_config_id = v_config),
    'KNOWN',
    'complete Korea observation is known'
  );
  return next is(
    (select korean_saturation_score > 0 from public.content_candidates where story_cluster_id = v_kr_cluster and ranking_date = v_ranking_date and scoring_config_id = v_config),
    true,
    'Korean saturation is calculated from valid KR ratios'
  );
  return next is(
    (select count(*)::integer from public.content_candidates where ranking_date = v_ranking_date and scoring_config_id = v_config and rank is not null),
    2,
    'all fixture candidates receive deterministic ranks'
  );
end;
$fixture$;

select * from pg_temp.m4_scoring_contract_fixture();
select * from finish();
rollback;
