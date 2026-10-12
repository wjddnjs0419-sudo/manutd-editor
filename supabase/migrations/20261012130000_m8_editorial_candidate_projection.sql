-- M8 editorial candidates do not contain fabricated M4 components or flags.
-- Preserve existing M4 values; NULL marks signals that were not calculated.
alter table public.content_candidates
  alter column score_version drop not null,
  alter column global_spread_score drop not null,
  alter column engagement_outperformance_score drop not null,
  alter column engagement_velocity_score drop not null,
  alter column velocity_acceleration_score drop not null,
  alter column korea_gap_score drop not null,
  alter column first_mover_score drop not null,
  alter column korean_saturation_score drop not null,
  alter column reliability_score drop not null,
  alter column source_diversity_score drop not null,
  alter column freshness_score drop not null,
  alter column first_mover_flag drop not null,
  alter column must_cover_flag drop not null;

comment on column public.content_candidates.score_version is
  'NULL when this row was projected from M8 editorial ranking without an M4 score calculation.';
comment on column public.content_candidates.first_mover_flag is
  'NULL when the M4 first-mover signal was not calculated; never infer it from M8 ranking.';
comment on column public.content_candidates.must_cover_flag is
  'NULL when the M4 must-cover signal was not calculated; never infer it from M8 ranking.';
