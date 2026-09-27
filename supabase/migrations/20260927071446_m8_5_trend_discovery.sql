create table app_private.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  mode text not null,
  status text not null default 'RUNNING',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  query_count integer not null default 0,
  observation_count integer not null default 0,
  new_observation_count integer not null default 0,
  new_story_count integer not null default 0,
  updated_story_count integer not null default 0,
  provider_statuses jsonb not null default '[]'::jsonb,
  provider_failures jsonb not null default '[]'::jsonb,
  duration_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  constraint discovery_runs_mode_check check (mode in ('GENERAL', 'BREAKING', 'TRANSFERS', 'MATCH', 'PLAYERS', 'COMMUNITY')),
  constraint discovery_runs_status_check check (status in ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'NOOP')),
  constraint discovery_runs_counts_nonnegative check (query_count >= 0 and observation_count >= 0 and new_observation_count >= 0 and new_story_count >= 0 and updated_story_count >= 0),
  constraint discovery_runs_status_array check (jsonb_typeof(provider_statuses) = 'array'),
  constraint discovery_runs_failures_array check (jsonb_typeof(provider_failures) = 'array'),
  constraint discovery_runs_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table app_private.discovery_queries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references app_private.discovery_runs(id) on delete cascade,
  query_id text not null,
  query_text text not null,
  family text not null,
  mode text not null,
  observation_window text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  priority integer not null default 0,
  status text not null default 'PENDING',
  observation_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_queries_identity_key unique (run_id, query_id),
  constraint discovery_queries_query_not_blank check (btrim(query_text) <> ''),
  constraint discovery_queries_window_check check (observation_window in ('BREAKING', 'HOT', 'CURRENT', 'BACKGROUND') and window_end >= window_start),
  constraint discovery_queries_status_check check (status in ('PENDING', 'COMPLETED', 'FAILED')),
  constraint discovery_queries_count_nonnegative check (observation_count >= 0)
);

create table app_private.discovery_observations (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  source_canonical_name text not null,
  editorial_role public.editorial_source_role not null,
  external_id text not null,
  canonical_url text not null,
  title text not null,
  excerpt text,
  published_at timestamptz,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  platform text not null,
  engagement jsonb not null default '{}'::jsonb,
  engagement_available boolean not null default false,
  discovery_query_id uuid references app_private.discovery_queries(id) on delete set null,
  content_fingerprint text not null,
  manutd_relevance_score numeric(6, 3),
  story_cluster_id uuid references public.story_clusters(id) on delete set null,
  source_observation_id uuid references app_private.source_observations(id) on delete set null,
  observation_count integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_observations_identity_key unique (provider_id, external_id),
  constraint discovery_observations_provider_not_blank check (btrim(provider_id) <> ''),
  constraint discovery_observations_source_not_blank check (btrim(source_canonical_name) <> ''),
  constraint discovery_observations_external_not_blank check (btrim(external_id) <> ''),
  constraint discovery_observations_url_not_blank check (btrim(canonical_url) <> ''),
  constraint discovery_observations_title_not_blank check (btrim(title) <> ''),
  constraint discovery_observations_excerpt_bounded check (excerpt is null or length(excerpt) <= 2_000),
  constraint discovery_observations_platform_check check (platform in ('WEB', 'RSS', 'ATOM', 'REDDIT', 'INSTAGRAM', 'YOUTUBE', 'OTHER')),
  constraint discovery_observations_engagement_object check (jsonb_typeof(engagement) = 'object'),
  constraint discovery_observations_fingerprint_not_blank check (btrim(content_fingerprint) <> ''),
  constraint discovery_observations_relevance_range check (manutd_relevance_score is null or manutd_relevance_score between 0 and 100),
  constraint discovery_observations_count_positive check (observation_count > 0),
  constraint discovery_observations_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table app_private.trend_snapshots (
  id uuid primary key default gen_random_uuid(),
  story_cluster_id uuid references public.story_clusters(id) on delete cascade,
  cluster_key text not null,
  snapshot_at timestamptz not null,
  trend_score numeric(6, 3) not null,
  velocity_score numeric(6, 3) not null,
  cross_source_score numeric(6, 3) not null,
  engagement_score numeric(6, 3) not null,
  freshness_score numeric(6, 3) not null,
  novelty_score numeric(6, 3) not null,
  manutd_relevance_score numeric(6, 3) not null,
  trend_state text not null,
  opportunity_labels jsonb not null default '[]'::jsonb,
  mention_count integer not null default 0,
  source_count integer not null default 0,
  platform_count integer not null default 0,
  engagement_available boolean not null default false,
  input_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint trend_snapshots_identity_key unique (cluster_key, snapshot_at),
  constraint trend_snapshots_cluster_key_not_blank check (btrim(cluster_key) <> ''),
  constraint trend_snapshots_score_range check (trend_score between 0 and 100 and velocity_score between 0 and 100 and cross_source_score between 0 and 100 and engagement_score between 0 and 100 and freshness_score between 0 and 100 and novelty_score between 0 and 100 and manutd_relevance_score between 0 and 100),
  constraint trend_snapshots_state_check check (trend_state in ('BREAKING', 'RISING', 'HOT', 'STABLE', 'COOLING', 'SATURATED')),
  constraint trend_snapshots_labels_array check (jsonb_typeof(opportunity_labels) = 'array'),
  constraint trend_snapshots_counts_nonnegative check (mention_count >= 0 and source_count >= 0 and platform_count >= 0),
  constraint trend_snapshots_snapshot_object check (jsonb_typeof(input_snapshot) = 'object')
);

alter table app_private.discovery_runs enable row level security;
alter table app_private.discovery_queries enable row level security;
alter table app_private.discovery_observations enable row level security;
alter table app_private.trend_snapshots enable row level security;

revoke all on table app_private.discovery_runs, app_private.discovery_queries, app_private.discovery_observations, app_private.trend_snapshots from public, anon, authenticated;
grant select, insert, update, delete on table app_private.discovery_runs, app_private.discovery_queries, app_private.discovery_observations, app_private.trend_snapshots to service_role;

create index discovery_runs_started_idx on app_private.discovery_runs (started_at desc);
create index discovery_queries_run_status_idx on app_private.discovery_queries (run_id, status);
create index discovery_observations_fingerprint_idx on app_private.discovery_observations (content_fingerprint);
create index discovery_observations_published_idx on app_private.discovery_observations (published_at desc, last_observed_at desc);
create index discovery_observations_cluster_idx on app_private.discovery_observations (story_cluster_id, last_observed_at desc);
create index trend_snapshots_cluster_time_idx on app_private.trend_snapshots (cluster_key, snapshot_at desc);
create index trend_snapshots_score_idx on app_private.trend_snapshots (snapshot_at desc, trend_score desc);

create trigger discovery_queries_set_updated_at
before update on app_private.discovery_queries
for each row execute function app_private.set_updated_at();
create trigger discovery_observations_set_updated_at
before update on app_private.discovery_observations
for each row execute function app_private.set_updated_at();
