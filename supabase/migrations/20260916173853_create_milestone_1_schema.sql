-- MU Content Intelligence System - Milestone 1
-- Canonical Supabase schema for collection, deterministic scoring, and content operations.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to service_role;

create type public.account_region as enum ('GLOBAL', 'KR');
create type public.platform_type as enum ('INSTAGRAM');
create type public.media_asset_type as enum ('IMAGE', 'CAROUSEL_CHILD', 'VIDEO', 'THUMBNAIL');
create type public.story_cluster_status as enum ('OPEN', 'ACTIVE', 'STALE', 'ARCHIVED');
create type public.information_source_entity_type as enum (
  'CLUB',
  'REPORTER',
  'MEDIA_OUTLET',
  'GOVERNING_BODY',
  'OTHER'
);
create type public.creative_brief_status as enum (
  'DRAFT',
  'SELECTED',
  'BRIEF_READY',
  'DESIGNING',
  'READY',
  'PUBLISHED'
);

create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function app_private.calculate_weighted_engagement(
  likes bigint,
  comments bigint,
  comment_multiplier numeric
)
returns numeric
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select likes::numeric + comments::numeric * comment_multiplier;
$$;

revoke all on function app_private.set_updated_at() from public, anon, authenticated;
revoke all on function app_private.calculate_weighted_engagement(bigint, bigint, numeric)
  from public, anon, authenticated;
grant execute on function app_private.calculate_weighted_engagement(bigint, bigint, numeric)
  to service_role;

create table public.source_accounts (
  id uuid primary key default gen_random_uuid(),
  username extensions.citext not null,
  instagram_account_id text,
  region public.account_region not null,
  platform public.platform_type not null default 'INSTAGRAM',
  active boolean not null default true,
  priority_weight numeric(8, 3) not null default 1,
  api_supported boolean,
  followers_available boolean,
  likes_available boolean,
  comments_available boolean,
  views_available boolean,
  media_url_available boolean,
  carousel_children_available boolean,
  last_probe_at timestamptz,
  probe_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_accounts_username_key unique (username),
  constraint source_accounts_instagram_account_id_key unique (instagram_account_id),
  constraint source_accounts_username_not_blank check (btrim(username::text) <> ''),
  constraint source_accounts_priority_weight_positive check (priority_weight > 0)
);

create table public.raw_posts (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null
    references public.source_accounts(id) on delete restrict,
  external_post_id text not null,
  caption text,
  permalink text,
  media_type text not null,
  media_product_type text,
  published_at timestamptz not null,
  collected_at timestamptz not null default now(),
  like_count bigint,
  comments_count bigint,
  view_count bigint,
  followers_count_at_collection bigint,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint raw_posts_source_external_key unique (source_account_id, external_post_id),
  constraint raw_posts_external_post_id_not_blank check (btrim(external_post_id) <> ''),
  constraint raw_posts_media_type_not_blank check (btrim(media_type) <> ''),
  constraint raw_posts_like_count_nonnegative check (like_count is null or like_count >= 0),
  constraint raw_posts_comments_count_nonnegative check (comments_count is null or comments_count >= 0),
  constraint raw_posts_view_count_nonnegative check (view_count is null or view_count >= 0),
  constraint raw_posts_followers_nonnegative check (
    followers_count_at_collection is null or followers_count_at_collection >= 0
  ),
  constraint raw_posts_collection_after_publish check (collected_at >= published_at),
  constraint raw_posts_payload_object check (jsonb_typeof(raw_payload) = 'object')
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  raw_post_id uuid not null references public.raw_posts(id) on delete cascade,
  external_media_id text,
  asset_type public.media_asset_type not null,
  carousel_index integer,
  original_media_url text,
  storage_path text,
  mime_type text,
  width integer,
  height integer,
  sha256 text,
  fetched_at timestamptz,
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  constraint media_assets_raw_external_key unique (raw_post_id, external_media_id),
  constraint media_assets_carousel_index_nonnegative check (
    carousel_index is null or carousel_index >= 0
  ),
  constraint media_assets_width_positive check (width is null or width > 0),
  constraint media_assets_height_positive check (height is null or height > 0),
  constraint media_assets_sha256_format check (
    sha256 is null or sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint media_assets_retention_after_fetch check (
    retention_until is null or fetched_at is null or retention_until >= fetched_at
  )
);

create table public.post_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  raw_post_id uuid not null references public.raw_posts(id) on delete cascade,
  captured_at timestamptz not null default now(),
  followers_count bigint,
  like_count bigint,
  comments_count bigint,
  view_count bigint,
  post_age_minutes integer not null,
  created_at timestamptz not null default now(),
  constraint post_metric_snapshots_post_capture_key unique (raw_post_id, captured_at),
  constraint post_metric_snapshots_followers_nonnegative check (
    followers_count is null or followers_count >= 0
  ),
  constraint post_metric_snapshots_likes_nonnegative check (
    like_count is null or like_count >= 0
  ),
  constraint post_metric_snapshots_comments_nonnegative check (
    comments_count is null or comments_count >= 0
  ),
  constraint post_metric_snapshots_views_nonnegative check (
    view_count is null or view_count >= 0
  ),
  constraint post_metric_snapshots_age_nonnegative check (post_age_minutes >= 0)
);

create table public.story_clusters (
  id uuid primary key default gen_random_uuid(),
  canonical_title text not null,
  summary text,
  topic text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  global_account_count integer not null default 0,
  korean_account_count integer not null default 0,
  global_weight_coverage numeric(8, 6) not null default 0,
  korean_weight_coverage numeric(8, 6) not null default 0,
  independent_source_count integer not null default 0,
  highest_source_reliability smallint,
  status public.story_cluster_status not null default 'OPEN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint story_clusters_title_not_blank check (btrim(canonical_title) <> ''),
  constraint story_clusters_seen_order check (last_seen_at >= first_seen_at),
  constraint story_clusters_global_count_nonnegative check (global_account_count >= 0),
  constraint story_clusters_korean_count_nonnegative check (korean_account_count >= 0),
  constraint story_clusters_global_coverage_range check (
    global_weight_coverage between 0 and 1
  ),
  constraint story_clusters_korean_coverage_range check (
    korean_weight_coverage between 0 and 1
  ),
  constraint story_clusters_independent_sources_nonnegative check (
    independent_source_count >= 0
  ),
  constraint story_clusters_reliability_range check (
    highest_source_reliability is null
    or highest_source_reliability between 0 and 10
  )
);

create table public.story_cluster_posts (
  story_cluster_id uuid not null
    references public.story_clusters(id) on delete cascade,
  raw_post_id uuid not null references public.raw_posts(id) on delete restrict,
  match_method text not null default 'UNSPECIFIED',
  match_confidence numeric(5, 4),
  created_at timestamptz not null default now(),
  primary key (story_cluster_id, raw_post_id),
  constraint story_cluster_posts_raw_post_key unique (raw_post_id),
  constraint story_cluster_posts_match_confidence_range check (
    match_confidence is null or match_confidence between 0 and 1
  )
);

create table public.information_sources (
  id uuid primary key default gen_random_uuid(),
  canonical_name extensions.citext not null,
  entity_type public.information_source_entity_type not null,
  aliases text[] not null default '{}',
  instagram_username extensions.citext,
  website_url text,
  reliability_score smallint not null,
  reliability_rationale text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint information_sources_canonical_name_key unique (canonical_name),
  constraint information_sources_instagram_username_key unique (instagram_username),
  constraint information_sources_name_not_blank check (btrim(canonical_name::text) <> ''),
  constraint information_sources_reliability_range check (
    reliability_score between 0 and 10
  ),
  constraint information_sources_rationale_not_blank check (
    btrim(reliability_rationale) <> ''
  )
);

create table public.story_cluster_sources (
  story_cluster_id uuid not null
    references public.story_clusters(id) on delete cascade,
  information_source_id uuid not null
    references public.information_sources(id) on delete restrict,
  first_cited_post_id uuid,
  citation_count integer not null default 1,
  extraction_confidence numeric(5, 4),
  evidence_text text,
  created_at timestamptz not null default now(),
  primary key (story_cluster_id, information_source_id),
  constraint story_cluster_sources_cluster_post_fkey
    foreign key (story_cluster_id, first_cited_post_id)
    references public.story_cluster_posts(story_cluster_id, raw_post_id)
    on delete restrict,
  constraint story_cluster_sources_citation_count_positive check (citation_count > 0),
  constraint story_cluster_sources_extraction_confidence_range check (
    extraction_confidence is null or extraction_confidence between 0 and 1
  )
);

create table public.scoring_configs (
  id uuid primary key default gen_random_uuid(),
  version extensions.citext not null,
  description text,
  config jsonb not null,
  is_active boolean not null default false,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scoring_configs_version_key unique (version),
  constraint scoring_configs_version_not_blank check (btrim(version::text) <> ''),
  constraint scoring_configs_config_object check (jsonb_typeof(config) = 'object'),
  constraint scoring_configs_comment_multiplier_present check (
    config ? 'comment_multiplier'
    and jsonb_typeof(config -> 'comment_multiplier') = 'number'
    and (config ->> 'comment_multiplier')::numeric >= 0
  ),
  constraint scoring_configs_component_weights_present check (
    config ? 'component_weights'
    and jsonb_typeof(config -> 'component_weights') = 'object'
  ),
  constraint scoring_configs_effective_window check (
    effective_to is null or effective_to > effective_from
  )
);

create unique index scoring_configs_one_active_idx
  on public.scoring_configs (is_active)
  where is_active;

create table public.content_candidates (
  id uuid primary key default gen_random_uuid(),
  story_cluster_id uuid not null
    references public.story_clusters(id) on delete restrict,
  scoring_config_id uuid not null
    references public.scoring_configs(id) on delete restrict,
  global_spread_score numeric(6, 3) not null,
  engagement_outperformance_score numeric(6, 3) not null,
  engagement_velocity_score numeric(6, 3) not null,
  velocity_acceleration_score numeric(6, 3) not null,
  korea_gap_score numeric(6, 3) not null,
  first_mover_score numeric(6, 3) not null,
  korean_saturation_score numeric(6, 3) not null,
  reliability_score numeric(6, 3) not null,
  source_diversity_score numeric(6, 3) not null,
  freshness_score numeric(6, 3) not null,
  priority_score numeric(7, 3) generated always as (
    global_spread_score
    + engagement_outperformance_score
    + engagement_velocity_score
    + velocity_acceleration_score
    + korea_gap_score
    + first_mover_score
    + korean_saturation_score
    + reliability_score
    + source_diversity_score
    + freshness_score
  ) stored,
  data_confidence numeric(6, 3) not null,
  first_mover_flag boolean not null default false,
  must_cover_flag boolean not null default false,
  rank integer,
  ranking_date date not null,
  recommendation_reason text,
  score_inputs jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_candidates_cluster_date_config_key
    unique (story_cluster_id, ranking_date, scoring_config_id),
  constraint content_candidates_global_spread_range check (global_spread_score between 0 and 12),
  constraint content_candidates_outperformance_range check (
    engagement_outperformance_score between 0 and 12
  ),
  constraint content_candidates_velocity_range check (engagement_velocity_score between 0 and 10),
  constraint content_candidates_acceleration_range check (velocity_acceleration_score between 0 and 6),
  constraint content_candidates_korea_gap_range check (korea_gap_score between 0 and 15),
  constraint content_candidates_first_mover_range check (first_mover_score between 0 and 10),
  constraint content_candidates_saturation_range check (korean_saturation_score between 0 and 10),
  constraint content_candidates_reliability_range check (reliability_score between 0 and 10),
  constraint content_candidates_source_diversity_range check (source_diversity_score between 0 and 5),
  constraint content_candidates_freshness_range check (freshness_score between 0 and 10),
  constraint content_candidates_confidence_range check (data_confidence between 0 and 100),
  constraint content_candidates_rank_positive check (rank is null or rank > 0),
  constraint content_candidates_score_inputs_object check (jsonb_typeof(score_inputs) = 'object')
);

create unique index content_candidates_ranking_rank_idx
  on public.content_candidates (ranking_date, scoring_config_id, rank)
  where rank is not null;

create table public.creative_briefs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null
    references public.content_candidates(id) on delete restrict,
  version integer not null default 1,
  headline text not null,
  angle text not null,
  format text not null,
  slide_count integer not null,
  slides_json jsonb not null,
  design_json jsonb not null,
  caption_draft text,
  cta text,
  status public.creative_brief_status not null default 'DRAFT',
  selected_at timestamptz,
  last_revised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creative_briefs_candidate_version_key unique (candidate_id, version),
  constraint creative_briefs_version_positive check (version > 0),
  constraint creative_briefs_slide_count_positive check (slide_count > 0),
  constraint creative_briefs_headline_not_blank check (btrim(headline) <> ''),
  constraint creative_briefs_angle_not_blank check (btrim(angle) <> ''),
  constraint creative_briefs_format_not_blank check (btrim(format) <> ''),
  constraint creative_briefs_slides_object check (jsonb_typeof(slides_json) = 'object'),
  constraint creative_briefs_design_object check (jsonb_typeof(design_json) = 'object')
);

create table public.published_posts (
  id uuid primary key default gen_random_uuid(),
  creative_brief_id uuid not null
    references public.creative_briefs(id) on delete restrict,
  instagram_post_id text not null,
  instagram_permalink text not null,
  published_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint published_posts_creative_brief_key unique (creative_brief_id),
  constraint published_posts_instagram_post_id_key unique (instagram_post_id),
  constraint published_posts_instagram_permalink_key unique (instagram_permalink),
  constraint published_posts_instagram_id_not_blank check (btrim(instagram_post_id) <> ''),
  constraint published_posts_permalink_not_blank check (btrim(instagram_permalink) <> '')
);

create table public.performance_metrics (
  id uuid primary key default gen_random_uuid(),
  published_post_id uuid not null
    references public.published_posts(id) on delete cascade,
  captured_at timestamptz not null default now(),
  reach bigint,
  views bigint,
  likes bigint,
  comments bigint,
  saves bigint,
  shares bigint,
  profile_visits bigint,
  follows_generated bigint,
  created_at timestamptz not null default now(),
  constraint performance_metrics_post_capture_key unique (published_post_id, captured_at),
  constraint performance_metrics_reach_nonnegative check (reach is null or reach >= 0),
  constraint performance_metrics_views_nonnegative check (views is null or views >= 0),
  constraint performance_metrics_likes_nonnegative check (likes is null or likes >= 0),
  constraint performance_metrics_comments_nonnegative check (comments is null or comments >= 0),
  constraint performance_metrics_saves_nonnegative check (saves is null or saves >= 0),
  constraint performance_metrics_shares_nonnegative check (shares is null or shares >= 0),
  constraint performance_metrics_profile_visits_nonnegative check (
    profile_visits is null or profile_visits >= 0
  ),
  constraint performance_metrics_follows_nonnegative check (
    follows_generated is null or follows_generated >= 0
  )
);

create unique index media_assets_carousel_position_idx
  on public.media_assets (raw_post_id, carousel_index)
  where carousel_index is not null;

create index source_accounts_active_region_idx
  on public.source_accounts (region, priority_weight)
  where active;

create index raw_posts_source_published_idx
  on public.raw_posts (source_account_id, published_at desc);

create index raw_posts_published_idx
  on public.raw_posts (published_at desc);

create index raw_posts_media_age_idx
  on public.raw_posts (media_type, media_product_type, published_at desc);

create index media_assets_raw_post_idx
  on public.media_assets (raw_post_id);

create index post_metric_snapshots_post_capture_idx
  on public.post_metric_snapshots (raw_post_id, captured_at desc);

create index story_clusters_status_last_seen_idx
  on public.story_clusters (status, last_seen_at desc);

create index story_clusters_first_seen_idx
  on public.story_clusters (first_seen_at desc);

create index story_cluster_posts_raw_post_idx
  on public.story_cluster_posts (raw_post_id);

create index information_sources_active_type_idx
  on public.information_sources (entity_type, reliability_score desc)
  where active;

create index story_cluster_sources_information_source_idx
  on public.story_cluster_sources (information_source_id);

create index story_cluster_sources_first_cited_post_idx
  on public.story_cluster_sources (story_cluster_id, first_cited_post_id)
  where first_cited_post_id is not null;

create index content_candidates_cluster_idx
  on public.content_candidates (story_cluster_id);

create index content_candidates_config_date_idx
  on public.content_candidates (scoring_config_id, ranking_date desc);

create index creative_briefs_candidate_idx
  on public.creative_briefs (candidate_id);

create index performance_metrics_post_capture_idx
  on public.performance_metrics (published_post_id, captured_at desc);

create trigger source_accounts_set_updated_at
before update on public.source_accounts
for each row execute function app_private.set_updated_at();

create trigger raw_posts_set_updated_at
before update on public.raw_posts
for each row execute function app_private.set_updated_at();

create trigger story_clusters_set_updated_at
before update on public.story_clusters
for each row execute function app_private.set_updated_at();

create trigger information_sources_set_updated_at
before update on public.information_sources
for each row execute function app_private.set_updated_at();

create trigger scoring_configs_set_updated_at
before update on public.scoring_configs
for each row execute function app_private.set_updated_at();

create trigger content_candidates_set_updated_at
before update on public.content_candidates
for each row execute function app_private.set_updated_at();

create trigger creative_briefs_set_updated_at
before update on public.creative_briefs
for each row execute function app_private.set_updated_at();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'source_accounts',
    'raw_posts',
    'media_assets',
    'post_metric_snapshots',
    'story_clusters',
    'story_cluster_posts',
    'information_sources',
    'story_cluster_sources',
    'scoring_configs',
    'content_candidates',
    'creative_briefs',
    'published_posts',
    'performance_metrics'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end
$$;
