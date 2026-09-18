\set ON_ERROR_STOP on

-- Task 8 smoke contract. This file is assertion-only: it never inserts or
-- updates production data and it emits assertion names without row contents.
begin;

create temporary table m4_smoke_failures (
  assertion text not null
) on commit drop;

-- The Edge Function must have produced at least one candidate before the
-- relational assertions below can be meaningful.
insert into m4_smoke_failures (assertion)
select 'recent_candidate_exists'
where not exists (select 1 from public.content_candidates);

insert into m4_smoke_failures (assertion)
select 'candidate_first_seen_within_24h_and_not_future'
where exists (
  select 1
  from public.content_candidates cc
  join public.story_clusters sc on sc.id = cc.story_cluster_id
  where sc.first_seen_at < cc.calculated_at - interval '24 hours'
     or sc.first_seen_at > cc.calculated_at
);

insert into m4_smoke_failures (assertion)
select 'candidate_cluster_not_archived'
where exists (
  select 1
  from public.content_candidates cc
  join public.story_clusters sc on sc.id = cc.story_cluster_id
  where sc.status = 'ARCHIVED'
);

insert into m4_smoke_failures (assertion)
select 'candidate_clusters_have_members'
where exists (
  select 1
  from public.content_candidates cc
  where not exists (
    select 1
    from public.story_cluster_posts scp
    where scp.story_cluster_id = cc.story_cluster_id
  )
);

insert into m4_smoke_failures (assertion)
select 'one_post_one_cluster'
where exists (
  select 1
  from public.story_cluster_posts
  group by raw_post_id
  having count(*) > 1
);

insert into m4_smoke_failures (assertion)
select 'score_version_matches_scoring_config'
where exists (
  select 1
  from public.content_candidates cc
  join public.scoring_configs cfg on cfg.id = cc.scoring_config_id
  where cc.score_version is distinct from cfg.version::text
     or cc.score_inputs ->> 'score_version' is distinct from cfg.version::text
     or cc.score_inputs ->> 'scoring_config_id' is distinct from cfg.id::text
);

insert into m4_smoke_failures (assertion)
select 'scoring_contract_evidence_is_persisted'
where exists (
  select 1
  from public.content_candidates cc
  where not (
    cc.score_inputs ?& array[
      'eligible_account_ids',
      'global_coverage',
      'korean_coverage',
      'korea_coverage_status',
      'global_outperformance_ratio',
      'global_velocity_ratio',
      'acceleration_ratio',
      'korean_outperformance_ratio',
      'data_confidence_components',
      'member_post_ids',
      'baseline_inputs',
      'missing_inputs'
    ]
  )
);

insert into m4_smoke_failures (assertion)
select 'curve_scores_match_persisted_ratios'
where exists (
  select 1
  from public.content_candidates cc
  join public.scoring_configs cfg on cfg.id = cc.scoring_config_id
  where cc.engagement_outperformance_score is distinct from round(coalesce(app_private.m4_curve_score((cc.score_inputs ->> 'global_outperformance_ratio')::numeric, cfg.config -> 'outperformance_curve'), 0), 3)
     or cc.engagement_velocity_score is distinct from round(coalesce(app_private.m4_curve_score((cc.score_inputs ->> 'global_velocity_ratio')::numeric, cfg.config -> 'velocity_curve'), 0), 3)
     or cc.velocity_acceleration_score is distinct from round(coalesce(app_private.m4_curve_score((cc.score_inputs ->> 'acceleration_ratio')::numeric, cfg.config -> 'acceleration_curve'), 0), 3)
);

insert into m4_smoke_failures (assertion)
select 'remaining_component_scores_match_contract'
where exists (
  select 1
  from public.content_candidates cc
  join public.story_clusters sc on sc.id = cc.story_cluster_id
  join public.scoring_configs cfg on cfg.id = cc.scoring_config_id
  where cc.global_spread_score is distinct from round(sc.global_weight_coverage * 12, 3)
     or cc.korea_gap_score is distinct from round(case when cc.korea_coverage_status = 'KNOWN' then 15 * least((cc.score_inputs ->> 'global_coverage')::numeric / 0.60, 1) * (1 - (cc.score_inputs ->> 'korean_coverage')::numeric) else 0 end, 3)
     or cc.first_mover_score is distinct from round(coalesce(app_private.m4_age_curve_score((cc.score_inputs ->> 'story_age_minutes')::numeric, cfg.config -> 'first_mover_curve_minutes'), 0), 3)
     or cc.korean_saturation_score is distinct from round(case when cc.score_inputs ->> 'korean_outperformance_ratio' is null then 0 else 10 * (1 - least(greatest((cc.score_inputs ->> 'korean_outperformance_ratio')::numeric / 2.5, 0), 1)) end, 3)
     or cc.reliability_score is distinct from coalesce(sc.highest_source_reliability, 0)
     or cc.source_diversity_score is distinct from case when sc.independent_source_count >= 3 then 5 when sc.independent_source_count = 2 then 3 when sc.independent_source_count = 1 then 1 else 0 end
     or cc.freshness_score is distinct from round(coalesce(app_private.m4_age_curve_score((cc.score_inputs ->> 'story_age_minutes')::numeric, cfg.config -> 'freshness_curve_minutes'), 0), 3)
);

insert into m4_smoke_failures (assertion)
select 'data_confidence_matches_persisted_components'
where exists (
  select 1
  from public.content_candidates cc
  where cc.data_confidence is distinct from round(100 * (
    0.20 * (cc.score_inputs -> 'data_confidence_components' ->> 'account_coverage')::numeric
    + 0.20 * (cc.score_inputs -> 'data_confidence_components' ->> 'baseline_evidence')::numeric
    + 0.20 * (cc.score_inputs -> 'data_confidence_components' ->> 'metric_snapshots')::numeric
    + 0.15 * (cc.score_inputs -> 'data_confidence_components' ->> 'followers')::numeric
    + 0.10 * (cc.score_inputs -> 'data_confidence_components' ->> 'source_recognition')::numeric
    + 0.10 * (cc.score_inputs -> 'data_confidence_components' ->> 'cluster_certainty')::numeric
    + 0.05 * (cc.score_inputs -> 'data_confidence_components' ->> 'api_fields')::numeric
  ), 1)
);

insert into m4_smoke_failures (assertion)
select 'priority_score_matches_component_sum'
where exists (
  select 1
  from public.content_candidates cc
  where cc.priority_score is distinct from round(
    cc.global_spread_score
    + cc.engagement_outperformance_score
    + cc.engagement_velocity_score
    + cc.velocity_acceleration_score
    + cc.korea_gap_score
    + cc.first_mover_score
    + cc.korean_saturation_score
    + cc.reliability_score
    + cc.source_diversity_score
    + cc.freshness_score,
    3
  )
);

insert into m4_smoke_failures (assertion)
select 'rank_is_deterministic_and_contiguous'
where exists (
  with ordered as (
    select cc.id,
           cc.rank,
           row_number() over (
             partition by cc.ranking_date, cc.scoring_config_id
             order by cc.priority_score desc,
                      cc.data_confidence desc,
                      sc.first_seen_at desc,
                      cc.story_cluster_id asc
           )::integer as expected_rank
    from public.content_candidates cc
    join public.story_clusters sc on sc.id = cc.story_cluster_id
  )
  select 1
  from ordered
  where rank is null or rank <> expected_rank
);

insert into m4_smoke_failures (assertion)
select 'korea_uncertainty_suppresses_gap_and_first_mover'
where exists (
  select 1
  from public.content_candidates cc
  where cc.korea_coverage_status = 'UNCERTAIN'
    and (cc.korea_gap_score <> 0 or cc.first_mover_flag)
);

insert into m4_smoke_failures (assertion)
select 'korea_status_is_conservative'
where exists (
  select 1
  from public.content_candidates cc
  where cc.korea_coverage_status not in ('KNOWN', 'UNCERTAIN')
     or (cc.korea_coverage_status = 'UNCERTAIN' and
         (cc.korea_gap_score <> 0 or cc.first_mover_flag))
);

-- A true flag must satisfy its non-negotiable gates. The velocity and
-- outperformance ratios are preserved in score_inputs when available.
insert into m4_smoke_failures (assertion)
select 'first_mover_gate'
where exists (
  select 1
  from public.content_candidates cc
  join public.story_clusters sc on sc.id = cc.story_cluster_id
  where cc.first_mover_flag
    and (
      sc.global_weight_coverage < 0.30
      or sc.korean_weight_coverage <> 0
      or cc.reliability_score < 8
      or cc.korea_coverage_status <> 'KNOWN'
      or not exists (
        select 1
        from public.source_accounts sa
        where sa.region = 'KR'
          and sa.active
          and sa.api_supported
      )
      or exists (
        select 1
        from public.source_accounts sa
        where sa.region = 'KR'
          and sa.active
          and sa.api_supported
          and (sa.last_probe_at is null
            or sa.last_probe_at < cc.calculated_at - interval '90 minutes'
            or sa.last_probe_at > cc.calculated_at
            or sa.probe_error is not null)
      )
      or exists (
        select 1
        from app_private.story_cluster_evaluations e
        join public.raw_posts rp on rp.id = e.raw_post_id
        join public.source_accounts sa on sa.id = rp.source_account_id
        where e.candidate_cluster_id = cc.story_cluster_id
          and sa.region = 'KR'
          and e.decision in ('MANUAL_REVIEW', 'ERROR')
      )
    )
);

insert into m4_smoke_failures (assertion)
select 'must_cover_gate'
where exists (
  select 1
  from public.content_candidates cc
  join public.story_clusters sc on sc.id = cc.story_cluster_id
  where cc.must_cover_flag
    and (
      sc.global_weight_coverage < 0.70
      or cc.reliability_score < 8
      or not (cc.score_inputs ? 'global_outperformance_ratio')
      or (cc.score_inputs ->> 'global_outperformance_ratio')::numeric < 1.5
    )
);

insert into m4_smoke_failures (assertion)
select 'duplicate_evaluation_identity_or_version_key'
where exists (
  select 1
  from app_private.story_cluster_evaluations
  group by raw_post_id, candidate_cluster_id, classifier_version, input_hash
  having count(*) > 1
);

insert into m4_smoke_failures (assertion)
select 'duplicate_membership_key'
where exists (
  select 1
  from public.story_cluster_posts
  group by raw_post_id
  having count(*) > 1
);

insert into m4_smoke_failures (assertion)
select 'baseline_excludes_evaluated_post_and_cluster_members'
where exists (
  select 1
  from (
    select cc.story_cluster_id,
           cc.calculated_at,
           cc.scoring_config_id,
           scp.raw_post_id as evaluated_raw_post_id,
           array_agg(scp_all.raw_post_id order by scp_all.raw_post_id) as member_ids
    from public.content_candidates cc
    join public.story_cluster_posts scp on scp.story_cluster_id = cc.story_cluster_id
    join public.story_cluster_posts scp_all on scp_all.story_cluster_id = cc.story_cluster_id
    group by cc.story_cluster_id, cc.calculated_at, cc.scoring_config_id, scp.raw_post_id
  ) sample
  cross join lateral app_private.m4_baseline(
    sample.evaluated_raw_post_id,
    sample.story_cluster_id,
    sample.member_ids,
    sample.calculated_at,
    sample.scoring_config_id
  ) baseline
  where not (baseline.excluded_post_ids ? sample.evaluated_raw_post_id::text)
     or exists (
       select 1
       from unnest(sample.member_ids) member_id
       where not (baseline.excluded_post_ids ? member_id::text)
     )
);

insert into m4_smoke_failures (assertion)
select 'm3_age_bucket_half_open_boundaries'
where exists (
  select 1
  from (
    values
      (0, '0-60'::text),
      (60, '60-180'::text),
      (180, '180-360'::text),
      (360, '360-720'::text),
      (720, '720-1440'::text),
      (1440, null::text),
      (-1, null::text)
  ) expected(minutes_old, bucket)
  where app_private.m4_age_bucket(
    '2026-09-18 12:00:00+00'::timestamptz - expected.minutes_old * interval '1 minute',
    '2026-09-18 12:00:00+00'::timestamptz
  ) is distinct from expected.bucket
);

insert into m4_smoke_failures (assertion)
select 'm3_snapshot_selection_has_no_future_or_sub_30m_delta'
where exists (
  with selected as (
    select cc.id as candidate_id,
           cc.calculated_at,
           scp.raw_post_id,
           snapshots.captured_at,
           lag(snapshots.captured_at) over (
             partition by cc.id, scp.raw_post_id
             order by snapshots.captured_at
           ) as previous_at
    from public.content_candidates cc
    join public.story_cluster_posts scp on scp.story_cluster_id = cc.story_cluster_id
    cross join lateral app_private.m4_score_snapshots(
      scp.raw_post_id,
      cc.calculated_at,
      cc.scoring_config_id
    ) snapshots
  ), violations as (
    select candidate_id, calculated_at
    from selected
    group by candidate_id, calculated_at, raw_post_id
    having count(*) = 3
       and (
         max(captured_at) > calculated_at
         or min(extract(epoch from captured_at - previous_at)) < 1800
       )
  )
  select 1 from violations
);

insert into m4_smoke_failures (assertion)
select 'seed_membership_confidence'
where exists (
  select 1
  from public.story_cluster_posts scp
  where not exists (
    select 1
    from public.story_cluster_posts earlier
    where earlier.story_cluster_id = scp.story_cluster_id
      and (earlier.created_at, earlier.raw_post_id::text) <
          (scp.created_at, scp.raw_post_id::text)
  )
  and (scp.match_method <> 'SEED' or scp.match_confidence <> 1.0)
);

do $$
declare
  failed text;
begin
  select string_agg(assertion, ', ' order by assertion)
    into failed
  from m4_smoke_failures;
  if failed is not null then
    raise exception 'milestone 4 smoke assertions failed: %', failed;
  end if;
end
$$;

select 'milestone 4 smoke assertions passed' as result;
rollback;
