create type app_private.m4_member_metric as (
  raw_post_id uuid,
  account_id uuid,
  region public.account_region,
  priority_weight numeric,
  match_confidence numeric,
  current_er numeric,
  current_velocity numeric,
  previous_velocity numeric,
  outperformance_ratio numeric,
  velocity_ratio numeric,
  acceleration_ratio numeric,
  baseline_er numeric,
  baseline_velocity numeric,
  baseline_er_sample_count integer,
  baseline_velocity_sample_count integer,
  baseline_er_fallback text,
  baseline_velocity_fallback text,
  baseline_evidence numeric,
  snapshot_count integer,
  snapshot_factor numeric,
  follower_factor numeric,
  api_factor numeric
);

create type app_private.m4_account_median as (
  account_id uuid,
  region public.account_region,
  priority_weight numeric,
  outperformance_ratio numeric,
  velocity_ratio numeric,
  acceleration_ratio numeric,
  korean_outperformance_ratio numeric
);

create or replace function app_private.m4_weighted_median(
  p_values numeric[],
  p_weights numeric[]
)
returns numeric
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  with pairs as (
    select value, weight, ordinal
    from unnest(p_values, p_weights) with ordinality as t(value, weight, ordinal)
    where weight > 0
      and value is not null
  ),
  ranked as (
    select
      value,
      sum(weight) over (order by value, ordinal rows between unbounded preceding and current row) as cumulative_weight,
      sum(weight) over () as total_weight
    from pairs
  )
  select value
  from ranked
  where cumulative_weight >= total_weight / 2
  order by value
  limit 1
$$;

create or replace function app_private.m4_curve_score(
  p_ratio numeric,
  p_curve jsonb
)
returns numeric
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  with points as (
    select ratio, score
    from jsonb_to_recordset(p_curve) as point(ratio numeric, score numeric)
    order by ratio
  ),
  first_point as (
    select ratio, score from points order by ratio limit 1
  ),
  last_point as (
    select ratio, score from points order by ratio desc limit 1
  ),
  lower_point as (
    select ratio, score from points where ratio <= p_ratio order by ratio desc limit 1
  ),
  upper_point as (
    select ratio, score from points where ratio >= p_ratio order by ratio limit 1
  )
  select case
    when p_ratio <= first_point.ratio then first_point.score
    when p_ratio >= last_point.ratio then last_point.score
    when upper_point.ratio = lower_point.ratio then lower_point.score
    else lower_point.score +
      ((p_ratio - lower_point.ratio) / nullif(upper_point.ratio - lower_point.ratio, 0)) *
      (upper_point.score - lower_point.score)
  end
  from first_point
  cross join last_point
  left join lower_point on true
  left join upper_point on true
$$;

create or replace function app_private.m4_age_curve_score(
  p_age_minutes numeric,
  p_curve jsonb
)
returns numeric
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select coalesce(point.score, 0)
  from jsonb_to_recordset(p_curve) as point(min numeric, max numeric, score numeric)
  where p_age_minutes >= point.min
    and (point.max is null or p_age_minutes < point.max)
  order by point.min desc
  limit 1
$$;

create or replace function app_private.m4_velocity_metrics(
  p_raw_post_id uuid,
  p_run_at timestamptz,
  p_scoring_config_id uuid
)
returns table(
  current_er numeric,
  previous_er numeric,
  oldest_er numeric,
  current_velocity numeric,
  previous_velocity numeric,
  acceleration_ratio numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with selected as (
    select
      max(engagement_rate) filter (where slot = 's0') as er0,
      max(engagement_rate) filter (where slot = 's1') as er1,
      max(engagement_rate) filter (where slot = 's2') as er2,
      max(captured_at) filter (where slot = 's0') as at0,
      max(captured_at) filter (where slot = 's1') as at1,
      max(captured_at) filter (where slot = 's2') as at2
    from app_private.m4_score_snapshots(p_raw_post_id, p_run_at, p_scoring_config_id)
  ),
  velocities as (
    select
      er0,
      er1,
      er2,
      case
        when er0 is not null and er1 is not null and at0 > at1
          then (er0 - er1) / nullif(extract(epoch from at0 - at1) / 3600, 0)
        else null
      end as v0,
      case
        when er1 is not null and er2 is not null and at1 > at2
          then (er1 - er2) / nullif(extract(epoch from at1 - at2) / 3600, 0)
        else null
      end as v1
    from selected
  )
  select
    er0,
    er1,
    er2,
    v0,
    v1,
    case when v1 > 0.000001 then v0 / v1 else null end
  from velocities
$$;

create or replace function app_private.m4_velocity_baseline(
  p_evaluated_raw_post_id uuid,
  p_cluster_id uuid,
  p_cluster_member_ids uuid[],
  p_run_at timestamptz,
  p_scoring_config_id uuid
)
returns table(
  baseline_velocity numeric,
  sample_count integer,
  fallback_level text,
  excluded_post_ids jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_account uuid;
  v_media text;
  v_bucket text;
  v_region public.account_region;
  v_ids uuid[] := array_remove(array_append(coalesce(p_cluster_member_ids, '{}'::uuid[]), p_evaluated_raw_post_id), null);
  v_n integer;
  v_value numeric;
begin
  perform p_cluster_id;
  select rp.source_account_id, rp.media_type,
         app_private.m4_age_bucket(rp.published_at, p_run_at), sa.region
  into v_account, v_media, v_bucket, v_region
  from public.raw_posts rp
  join public.source_accounts sa on sa.id = rp.source_account_id
  where rp.id = p_evaluated_raw_post_id;

  if v_bucket is null then
    return query select null::numeric, 0, 'UNAVAILABLE'::text, to_jsonb(v_ids);
    return;
  end if;

  with baseline_posts as (
    select rp.id
    from public.raw_posts rp
    where rp.source_account_id = v_account
      and rp.media_type = v_media
      and app_private.m4_age_bucket(rp.published_at, p_run_at) = v_bucket
      and rp.id <> all(v_ids)
      and rp.collected_at <= p_run_at
      and rp.followers_count_at_collection > 0
      and rp.like_count is not null
      and rp.comments_count is not null
  ),
  velocities as (
    select vm.current_velocity
    from baseline_posts bp
    cross join lateral app_private.m4_velocity_metrics(bp.id, p_run_at, p_scoring_config_id) vm
    where vm.current_velocity is not null
  )
  select count(*)::integer, percentile_cont(0.5) within group (order by current_velocity)
  into v_n, v_value
  from velocities;
  if v_n >= 5 then
    return query select v_value, v_n, 'ACCOUNT_MEDIA_AGE', to_jsonb(v_ids);
    return;
  end if;

  with baseline_posts as (
    select rp.id
    from public.raw_posts rp
    where rp.source_account_id = v_account
      and app_private.m4_age_bucket(rp.published_at, p_run_at) = v_bucket
      and rp.id <> all(v_ids)
      and rp.collected_at <= p_run_at
      and rp.followers_count_at_collection > 0
      and rp.like_count is not null
      and rp.comments_count is not null
  ),
  velocities as (
    select vm.current_velocity
    from baseline_posts bp
    cross join lateral app_private.m4_velocity_metrics(bp.id, p_run_at, p_scoring_config_id) vm
    where vm.current_velocity is not null
  )
  select count(*)::integer, percentile_cont(0.5) within group (order by current_velocity)
  into v_n, v_value
  from velocities;
  if v_n >= 5 then
    return query select v_value, v_n, 'ACCOUNT_AGE', to_jsonb(v_ids);
    return;
  end if;

  with baseline_posts as (
    select rp.id
    from public.raw_posts rp
    join public.source_accounts sa on sa.id = rp.source_account_id
    where sa.region = v_region
      and rp.media_type = v_media
      and app_private.m4_age_bucket(rp.published_at, p_run_at) = v_bucket
      and rp.id <> all(v_ids)
      and rp.collected_at <= p_run_at
      and rp.followers_count_at_collection > 0
      and rp.like_count is not null
      and rp.comments_count is not null
  ),
  velocities as (
    select vm.current_velocity
    from baseline_posts bp
    cross join lateral app_private.m4_velocity_metrics(bp.id, p_run_at, p_scoring_config_id) vm
    where vm.current_velocity is not null
  )
  select count(*)::integer, percentile_cont(0.5) within group (order by current_velocity)
  into v_n, v_value
  from velocities;
  if v_n >= 20 then
    return query select v_value, v_n, 'REGION_MEDIA_AGE', to_jsonb(v_ids);
    return;
  end if;

  return query select null::numeric, coalesce(v_n, 0), 'UNAVAILABLE', to_jsonb(v_ids);
end
$$;

create or replace function public.calculate_priority_candidates(
  p_run_at timestamptz,
  p_ranking_date date
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_config record;
  v_cluster record;
  v_member_ids uuid[];
  v_global_coverage numeric;
  v_korean_coverage numeric;
  v_global_weight numeric;
  v_korean_weight numeric;
  v_global_fresh_weight numeric;
  v_korean_fresh_weight numeric;
  v_account_completeness numeric;
  v_korean_completeness numeric;
  v_korea_status text;
  v_unresolved_ambiguity boolean;
  v_global_outperformance_ratio numeric;
  v_global_velocity_ratio numeric;
  v_global_acceleration_ratio numeric;
  v_korean_outperformance_ratio numeric;
  v_korea_gap_score numeric;
  v_first_mover_score numeric;
  v_korean_saturation_score numeric;
  v_data_confidence numeric;
  v_baseline_confidence numeric;
  v_snapshot_confidence numeric;
  v_followers_confidence numeric;
  v_source_confidence numeric;
  v_cluster_confidence numeric;
  v_api_confidence numeric;
  v_reliability numeric;
  v_source_diversity numeric;
  v_first_mover boolean;
  v_must_cover boolean;
  v_age_minutes numeric;
  v_count integer := 0;
  v_pending_ids jsonb;
  v_unsupported_ids jsonb;
  v_eligible_ids jsonb;
  v_missing_inputs jsonb;
  v_source_ids jsonb;
  v_baseline_inputs jsonb;
  v_member_inputs jsonb;
  v_rows integer;
  v_member_metrics app_private.m4_member_metric[];
  v_account_medians app_private.m4_account_median[];
begin
  if p_run_at is null or p_ranking_date is null then
    raise exception 'scoring input is invalid' using errcode = '22023';
  end if;

  select id, version, config
  into v_config
  from public.scoring_configs
  where is_active
    and effective_from <= p_run_at
    and (effective_to is null or effective_to > p_run_at)
  order by effective_from desc
  limit 1;

  if v_config.id is null then
    raise exception 'active scoring configuration not found' using errcode = 'P0002';
  end if;

  perform app_private.m4_refresh_lifecycle(p_run_at);

  for v_cluster in
    select sc.id, sc.first_seen_at, sc.global_weight_coverage, sc.korean_weight_coverage,
           sc.highest_source_reliability, sc.independent_source_count
    from public.story_clusters sc
    where sc.status <> 'ARCHIVED'
      and sc.first_seen_at >= p_run_at - interval '24 hours'
      and sc.first_seen_at <= p_run_at
  loop
    select coalesce(array_agg(scp.raw_post_id order by scp.raw_post_id), '{}'::uuid[])
    into v_member_ids
    from public.story_cluster_posts scp
    where scp.story_cluster_id = v_cluster.id;

    select coalesce(array_agg((row(
      rp.id,
      rp.source_account_id,
      sa.region,
      sa.priority_weight,
      scp.match_confidence,
      vm.current_er,
      vm.current_velocity,
      vm.previous_velocity,
      case when eb.baseline_er > 0 and vm.current_er is not null then vm.current_er / eb.baseline_er end,
      case when vb.baseline_velocity > 0 and vm.current_velocity > 0 then vm.current_velocity / vb.baseline_velocity end,
      vm.acceleration_ratio,
      eb.baseline_er,
      vb.baseline_velocity,
      eb.sample_count,
      vb.sample_count,
      eb.fallback_level,
      vb.fallback_level,
      (
        coalesce(case eb.fallback_level when 'ACCOUNT_MEDIA_AGE' then 1.0 when 'ACCOUNT_AGE' then 0.8 when 'REGION_MEDIA_AGE' then 0.6 else 0 end, 0)
        * least(1.0, sqrt(coalesce(eb.sample_count, 0)::numeric / 50.0))
        + coalesce(case vb.fallback_level when 'ACCOUNT_MEDIA_AGE' then 1.0 when 'ACCOUNT_AGE' then 0.8 when 'REGION_MEDIA_AGE' then 0.6 else 0 end, 0)
        * least(1.0, sqrt(coalesce(vb.sample_count, 0)::numeric / 50.0))
      ) / 2,
      coalesce((select count(*) from public.post_metric_snapshots pms where pms.raw_post_id = rp.id and pms.captured_at <= p_run_at), 0),
      least(1.0, coalesce((select count(*) from public.post_metric_snapshots pms where pms.raw_post_id = rp.id and pms.captured_at <= p_run_at), 0)::numeric / 3.0),
      case when rp.followers_count_at_collection > 0 then 1 else 0 end,
      ((rp.like_count is not null)::integer + (rp.comments_count is not null)::integer + (rp.followers_count_at_collection is not null)::integer)::numeric / 3.0
    ))::app_private.m4_member_metric order by rp.id), '{}'::app_private.m4_member_metric[])
    into v_member_metrics
    from public.story_cluster_posts scp
    join public.raw_posts rp on rp.id = scp.raw_post_id
    join public.source_accounts sa on sa.id = rp.source_account_id
    cross join lateral app_private.m4_velocity_metrics(rp.id, p_run_at, v_config.id) vm
    cross join lateral app_private.m4_baseline(rp.id, v_cluster.id, v_member_ids, p_run_at, v_config.id) eb
    cross join lateral app_private.m4_velocity_baseline(rp.id, v_cluster.id, v_member_ids, p_run_at, v_config.id) vb
    where scp.story_cluster_id = v_cluster.id;

    select coalesce(array_agg((row(
      am.account_id,
      am.region,
      am.priority_weight,
      am.outperformance_ratio,
      am.velocity_ratio,
      am.acceleration_ratio,
      am.korean_outperformance_ratio
    ))::app_private.m4_account_median order by am.account_id), '{}'::app_private.m4_account_median[])
    into v_account_medians
    from (
      select
        mm.account_id,
        mm.region,
        max(mm.priority_weight) as priority_weight,
        percentile_cont(0.5) within group (order by mm.outperformance_ratio) filter (where mm.outperformance_ratio is not null) as outperformance_ratio,
        percentile_cont(0.5) within group (order by mm.velocity_ratio) filter (where mm.velocity_ratio is not null) as velocity_ratio,
        percentile_cont(0.5) within group (order by mm.acceleration_ratio) filter (where mm.acceleration_ratio is not null) as acceleration_ratio,
        percentile_cont(0.5) within group (order by mm.outperformance_ratio) filter (where mm.region = 'KR' and mm.outperformance_ratio is not null) as korean_outperformance_ratio
      from unnest(v_member_metrics) as mm
      group by mm.account_id, mm.region
    ) am;

    select coalesce(sum(sa.priority_weight) filter (where sa.region = 'GLOBAL'), 0),
           coalesce(sum(sa.priority_weight) filter (where sa.region = 'KR'), 0),
           coalesce(sum(sa.priority_weight) filter (where sa.region = 'GLOBAL' and sa.last_probe_at >= p_run_at - interval '90 minutes' and sa.last_probe_at <= p_run_at and sa.probe_error is null), 0),
           coalesce(sum(sa.priority_weight) filter (where sa.region = 'KR' and sa.last_probe_at >= p_run_at - interval '90 minutes' and sa.last_probe_at <= p_run_at and sa.probe_error is null), 0)
    into v_global_weight, v_korean_weight, v_global_fresh_weight, v_korean_fresh_weight
    from public.source_accounts sa
    where sa.active and sa.api_supported;

    select coalesce(sum(sa.priority_weight) filter (where sa.region = 'GLOBAL'), 0) / nullif(v_global_weight, 0),
           coalesce(sum(sa.priority_weight) filter (where sa.region = 'KR'), 0) / nullif(v_korean_weight, 0)
    into v_global_coverage, v_korean_coverage
    from public.source_accounts sa
    where sa.active and sa.api_supported
      and exists (
        select 1
        from public.story_cluster_posts scp
        join public.raw_posts rp on rp.id = scp.raw_post_id
        where scp.story_cluster_id = v_cluster.id
          and rp.source_account_id = sa.id
      );

    v_global_coverage := coalesce(v_global_coverage, 0);
    v_korean_coverage := coalesce(v_korean_coverage, 0);
    v_account_completeness := case when v_global_weight + v_korean_weight > 0 then (v_global_fresh_weight + v_korean_fresh_weight) / (v_global_weight + v_korean_weight) else 0 end;
    v_korean_completeness := case when v_korean_weight > 0 then v_korean_fresh_weight / v_korean_weight else 0 end;

    select exists (
      select 1
      from app_private.story_cluster_evaluations e
      join public.raw_posts rp on rp.id = e.raw_post_id
      join public.source_accounts sa on sa.id = rp.source_account_id
      where e.candidate_cluster_id = v_cluster.id
        and sa.region = 'KR'
        and e.decision in ('MANUAL_REVIEW', 'ERROR')
    ) into v_unresolved_ambiguity;

    v_korea_status := case when v_korean_weight > 0 and v_korean_completeness < 1 then 'UNCERTAIN' else 'KNOWN' end;
    if v_unresolved_ambiguity then
      v_korea_status := 'UNCERTAIN';
    end if;

    select app_private.m4_weighted_median(array_agg(am.outperformance_ratio order by am.outperformance_ratio), array_agg(am.priority_weight order by am.outperformance_ratio))
    into v_global_outperformance_ratio
    from unnest(v_account_medians) as am where am.region = 'GLOBAL' and am.outperformance_ratio is not null;
    select app_private.m4_weighted_median(array_agg(am.velocity_ratio order by am.velocity_ratio), array_agg(am.priority_weight order by am.velocity_ratio))
    into v_global_velocity_ratio
    from unnest(v_account_medians) as am where am.region = 'GLOBAL' and am.velocity_ratio is not null;
    select app_private.m4_weighted_median(array_agg(am.acceleration_ratio order by am.acceleration_ratio), array_agg(am.priority_weight order by am.acceleration_ratio))
    into v_global_acceleration_ratio
    from unnest(v_account_medians) as am where am.region = 'GLOBAL' and am.acceleration_ratio is not null;
    select app_private.m4_weighted_median(array_agg(am.korean_outperformance_ratio order by am.korean_outperformance_ratio), array_agg(am.priority_weight order by am.korean_outperformance_ratio))
    into v_korean_outperformance_ratio
    from unnest(v_account_medians) as am where am.region = 'KR' and am.korean_outperformance_ratio is not null;

    v_korea_gap_score := case when v_korea_status = 'KNOWN' then 15 * least(v_global_coverage / 0.60, 1) * (1 - v_korean_coverage) else 0 end;
    v_age_minutes := extract(epoch from p_run_at - v_cluster.first_seen_at) / 60.0;
    v_first_mover_score := coalesce(app_private.m4_age_curve_score(v_age_minutes, v_config.config -> 'first_mover_curve_minutes'), 0);
    v_korean_saturation_score := case when v_korean_outperformance_ratio is null then 0 else 10 * (1 - least(greatest(v_korean_outperformance_ratio / 2.5, 0), 1)) end;
    v_reliability := coalesce(v_cluster.highest_source_reliability, 0);
    v_source_diversity := case when v_cluster.independent_source_count >= 3 then 5 when v_cluster.independent_source_count = 2 then 3 when v_cluster.independent_source_count = 1 then 1 else 0 end;

    select coalesce(avg(mm.baseline_evidence), 0),
           coalesce(sum(mm.priority_weight * mm.snapshot_factor) / nullif(sum(mm.priority_weight), 0), 0),
           coalesce(sum(mm.priority_weight * mm.follower_factor) / nullif(sum(mm.priority_weight), 0), 0),
           coalesce(sum(mm.priority_weight * mm.api_factor) / nullif(sum(mm.priority_weight), 0), 0),
           coalesce(sum(mm.priority_weight * coalesce(mm.match_confidence, 0)) / nullif(sum(mm.priority_weight), 0), 0)
    into v_baseline_confidence, v_snapshot_confidence, v_followers_confidence, v_api_confidence, v_cluster_confidence
    from unnest(v_member_metrics) as mm;

    select case when count(*) = 0 then 0 else 1 end
    into v_source_confidence
    from public.story_cluster_sources scs
    where scs.story_cluster_id = v_cluster.id;

    v_data_confidence := round(100 * (
      0.20 * v_account_completeness
      + 0.20 * v_baseline_confidence
      + 0.20 * v_snapshot_confidence
      + 0.15 * v_followers_confidence
      + 0.10 * v_source_confidence
      + 0.10 * v_cluster_confidence
      + 0.05 * v_api_confidence
    ), 1);

    v_first_mover := v_global_coverage >= 0.30
      and v_korean_coverage = 0
      and v_global_velocity_ratio >= 1.5
      and v_reliability >= 8
      and v_korean_weight > 0
      and v_korean_completeness = 1
      and v_korea_status = 'KNOWN'
      and not v_unresolved_ambiguity;
    v_must_cover := v_global_coverage >= 0.70
      and v_global_outperformance_ratio >= 1.5
      and v_reliability >= 8;

    select coalesce(jsonb_agg(sa.id order by sa.id), '[]'::jsonb)
    into v_eligible_ids
    from public.source_accounts sa where sa.active and sa.api_supported;
    select coalesce(jsonb_agg(sa.id order by sa.id), '[]'::jsonb)
    into v_pending_ids
    from public.source_accounts sa where sa.active and sa.api_supported is null;
    select coalesce(jsonb_agg(sa.id order by sa.id), '[]'::jsonb)
    into v_unsupported_ids
    from public.source_accounts sa where sa.active and sa.api_supported = false;
    select coalesce(jsonb_agg(scs.information_source_id order by scs.information_source_id), '[]'::jsonb)
    into v_source_ids
    from public.story_cluster_sources scs where scs.story_cluster_id = v_cluster.id;
    select coalesce(jsonb_agg(jsonb_build_object('raw_post_id', mm.raw_post_id, 'baseline_er', mm.baseline_er, 'baseline_velocity', mm.baseline_velocity, 'er_sample_count', mm.baseline_er_sample_count, 'velocity_sample_count', mm.baseline_velocity_sample_count, 'er_fallback', mm.baseline_er_fallback, 'velocity_fallback', mm.baseline_velocity_fallback) order by mm.raw_post_id), '[]'::jsonb)
    into v_baseline_inputs
    from unnest(v_member_metrics) as mm;
    select coalesce(jsonb_agg(mm.raw_post_id order by mm.raw_post_id), '[]'::jsonb)
    into v_member_inputs
    from unnest(v_member_metrics) as mm;

    v_missing_inputs := '[]'::jsonb;
    if v_global_outperformance_ratio is null then v_missing_inputs := v_missing_inputs || '["global_outperformance_ratio"]'::jsonb; end if;
    if v_global_velocity_ratio is null then v_missing_inputs := v_missing_inputs || '["global_velocity_ratio"]'::jsonb; end if;
    if v_global_acceleration_ratio is null then v_missing_inputs := v_missing_inputs || '["acceleration_ratio"]'::jsonb; end if;

    insert into public.content_candidates (
      story_cluster_id,
      scoring_config_id,
      score_version,
      korea_coverage_status,
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
      first_mover_flag,
      must_cover_flag,
      ranking_date,
      score_inputs,
      calculated_at
    ) values (
      v_cluster.id,
      v_config.id,
      v_config.version::text,
      v_korea_status,
      round(v_cluster.global_weight_coverage * 12, 3),
      round(coalesce(app_private.m4_curve_score(v_global_outperformance_ratio, v_config.config -> 'outperformance_curve'), 0), 3),
      round(coalesce(app_private.m4_curve_score(v_global_velocity_ratio, v_config.config -> 'velocity_curve'), 0), 3),
      round(coalesce(app_private.m4_curve_score(v_global_acceleration_ratio, v_config.config -> 'acceleration_curve'), 0), 3),
      round(v_korea_gap_score, 3),
      round(v_first_mover_score, 3),
      round(v_korean_saturation_score, 3),
      v_reliability,
      v_source_diversity,
      round(coalesce(app_private.m4_age_curve_score(v_age_minutes, v_config.config -> 'freshness_curve_minutes'), 0), 3),
      v_data_confidence,
      v_first_mover,
      v_must_cover,
      p_ranking_date,
      jsonb_build_object(
        'scoring_config_id', v_config.id,
        'score_version', v_config.version::text,
        'comment_multiplier', (v_config.config ->> 'comment_multiplier')::numeric,
        'run_at', p_run_at,
        'eligible_account_ids', v_eligible_ids,
        'pending_capability_account_ids', v_pending_ids,
        'unsupported_account_ids', v_unsupported_ids,
        'global_coverage', v_global_coverage,
        'korean_coverage', v_korean_coverage,
        'korea_observation_completeness', v_korean_completeness,
        'korea_coverage_status', v_korea_status,
        'global_outperformance_ratio', v_global_outperformance_ratio,
        'global_velocity_ratio', v_global_velocity_ratio,
        'acceleration_ratio', v_global_acceleration_ratio,
        'korean_outperformance_ratio', v_korean_outperformance_ratio,
        'data_confidence_components', jsonb_build_object('account_coverage', v_account_completeness, 'baseline_evidence', v_baseline_confidence, 'metric_snapshots', v_snapshot_confidence, 'followers', v_followers_confidence, 'source_recognition', v_source_confidence, 'cluster_certainty', v_cluster_confidence, 'api_fields', v_api_confidence),
        'member_post_ids', v_member_inputs,
        'baseline_inputs', v_baseline_inputs,
        'recognized_source_ids', v_source_ids,
        'first_seen_at', v_cluster.first_seen_at,
        'story_age_minutes', v_age_minutes,
        'missing_inputs', v_missing_inputs,
        'unresolved_korea_ambiguity', v_unresolved_ambiguity
      ),
      p_run_at
    )
    on conflict (story_cluster_id, ranking_date, scoring_config_id)
    do update set
      score_version = excluded.score_version,
      korea_coverage_status = excluded.korea_coverage_status,
      global_spread_score = excluded.global_spread_score,
      engagement_outperformance_score = excluded.engagement_outperformance_score,
      engagement_velocity_score = excluded.engagement_velocity_score,
      velocity_acceleration_score = excluded.velocity_acceleration_score,
      korea_gap_score = excluded.korea_gap_score,
      first_mover_score = excluded.first_mover_score,
      korean_saturation_score = excluded.korean_saturation_score,
      reliability_score = excluded.reliability_score,
      source_diversity_score = excluded.source_diversity_score,
      freshness_score = excluded.freshness_score,
      data_confidence = excluded.data_confidence,
      first_mover_flag = excluded.first_mover_flag,
      must_cover_flag = excluded.must_cover_flag,
      score_inputs = excluded.score_inputs,
      calculated_at = excluded.calculated_at;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;

  update public.content_candidates
  set rank = null
  where ranking_date = p_ranking_date
    and scoring_config_id = v_config.id;

  with ordered as (
    select id,
           row_number() over (order by priority_score desc, data_confidence desc, (select first_seen_at from public.story_clusters where id = content_candidates.story_cluster_id) desc, story_cluster_id asc)::integer as new_rank
    from public.content_candidates
    where ranking_date = p_ranking_date
      and scoring_config_id = v_config.id
  )
  update public.content_candidates cc
  set rank = ordered.new_rank
  from ordered
  where cc.id = ordered.id;

  return v_count;
end
$$;

revoke all on function app_private.m4_weighted_median(numeric[], numeric[]), app_private.m4_curve_score(numeric, jsonb), app_private.m4_age_curve_score(numeric, jsonb), app_private.m4_velocity_metrics(uuid, timestamptz, uuid), app_private.m4_velocity_baseline(uuid, uuid, uuid[], timestamptz, uuid) from public, anon, authenticated;
grant execute on function app_private.m4_weighted_median(numeric[], numeric[]), app_private.m4_curve_score(numeric, jsonb), app_private.m4_age_curve_score(numeric, jsonb), app_private.m4_velocity_metrics(uuid, timestamptz, uuid), app_private.m4_velocity_baseline(uuid, uuid, uuid[], timestamptz, uuid) to service_role;
grant execute on function app_private.m4_age_bucket(timestamptz, timestamptz), app_private.m4_score_snapshots(uuid, timestamptz, uuid), app_private.m4_baseline(uuid, uuid, uuid[], timestamptz, uuid) to service_role;
revoke all on function public.calculate_priority_candidates(timestamptz, date) from public, anon, authenticated;
grant execute on function public.calculate_priority_candidates(timestamptz, date) to service_role;

update public.scoring_configs
set config = config || jsonb_build_object(
  'velocity_curve', jsonb_build_array(
    jsonb_build_object('ratio', 0.5, 'score', 0),
    jsonb_build_object('ratio', 1.0, 'score', 2.5),
    jsonb_build_object('ratio', 1.5, 'score', 5),
    jsonb_build_object('ratio', 2.0, 'score', 7.5),
    jsonb_build_object('ratio', 2.5, 'score', 10)
  )
)
where is_active;
