create type public.editorial_source_role as enum (
  'FACT_PRIMARY',
  'FACT_INDEPENDENT',
  'DISCOVERY_COMPETITOR',
  'DISCOVERY_COMMUNITY',
  'DISCOVERY_VIDEO',
  'MATCH_CONTEXT',
  'OWN_PERFORMANCE'
);

alter table public.information_sources
  add column editorial_role public.editorial_source_role not null default 'FACT_INDEPENDENT';

create table app_private.source_observations (
  id uuid primary key default gen_random_uuid(),
  information_source_id uuid not null references public.information_sources(id) on delete restrict,
  editorial_role public.editorial_source_role not null,
  external_id text not null,
  canonical_url text not null,
  title text not null,
  excerpt text,
  published_at timestamptz,
  observed_at timestamptz not null default now(),
  discovery_signal numeric(5, 4) not null default 0,
  content_fingerprint text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_observations_external_id_not_blank check (btrim(external_id) <> ''),
  constraint source_observations_url_not_blank check (btrim(canonical_url) <> ''),
  constraint source_observations_title_not_blank check (btrim(title) <> ''),
  constraint source_observations_excerpt_bounded check (excerpt is null or length(excerpt) <= 2_000),
  constraint source_observations_discovery_signal_range check (discovery_signal between 0 and 1),
  constraint source_observations_fingerprint_not_blank check (btrim(content_fingerprint) <> ''),
  constraint source_observations_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint source_observations_identity_key unique (information_source_id, external_id)
);

create table app_private.story_claims (
  id uuid primary key default gen_random_uuid(),
  story_cluster_id uuid not null references public.story_clusters(id) on delete cascade,
  raw_post_id uuid not null references public.raw_posts(id) on delete cascade,
  claim_fingerprint text not null,
  subject text not null,
  predicate text not null,
  object text not null,
  claim_text text not null,
  origin text not null,
  extraction_confidence numeric(5, 4),
  grounding_status text not null default 'INSUFFICIENT',
  grounding_confidence numeric(5, 4),
  grounding_version text not null,
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint story_claims_fingerprint_not_blank check (btrim(claim_fingerprint) <> ''),
  constraint story_claims_subject_not_blank check (btrim(subject) <> ''),
  constraint story_claims_predicate_not_blank check (btrim(predicate) <> ''),
  constraint story_claims_object_not_blank check (btrim(object) <> ''),
  constraint story_claims_text_not_blank check (btrim(claim_text) <> ''),
  constraint story_claims_origin_check check (origin in ('caption', 'image', 'carousel_slide', 'thumbnail')),
  constraint story_claims_extraction_confidence_range check (extraction_confidence is null or extraction_confidence between 0 and 1),
  constraint story_claims_grounding_status_check check (grounding_status in ('VERIFIED', 'DISCOVERY_ONLY', 'INSUFFICIENT', 'CONTRADICTED')),
  constraint story_claims_grounding_confidence_range check (grounding_confidence is null or grounding_confidence between 0 and 1),
  constraint story_claims_grounding_version_not_blank check (btrim(grounding_version) <> ''),
  constraint story_claims_decision_reason_bounded check (decision_reason is null or length(decision_reason) <= 500),
  constraint story_claims_identity_key unique (story_cluster_id, claim_fingerprint, grounding_version)
);

create table app_private.claim_evidence (
  claim_id uuid not null references app_private.story_claims(id) on delete cascade,
  source_observation_id uuid not null references app_private.source_observations(id) on delete cascade,
  relation text not null,
  editorial_role public.editorial_source_role not null,
  evidence_text text not null,
  evidence_confidence numeric(5, 4),
  is_grounding boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (claim_id, source_observation_id, relation),
  constraint claim_evidence_relation_check check (relation in ('SUPPORTS', 'CONTRADICTS')),
  constraint claim_evidence_text_not_blank check (btrim(evidence_text) <> ''),
  constraint claim_evidence_confidence_range check (evidence_confidence is null or evidence_confidence between 0 and 1),
  constraint claim_evidence_grounding_role_check check (
    not is_grounding or editorial_role in ('FACT_PRIMARY', 'FACT_INDEPENDENT')
  )
);

create table app_private.editorial_rankings (
  id uuid primary key default gen_random_uuid(),
  story_cluster_id uuid not null references public.story_clusters(id) on delete cascade,
  ranking_date date not null,
  ranking_version text not null,
  information_gap_score numeric(6, 3) not null,
  fact_grounding_score numeric(6, 3) not null,
  discovery_audience_signal_score numeric(6, 3) not null,
  match_context_score numeric(6, 3) not null,
  freshness_score numeric(6, 3) not null,
  editorial_score numeric(7, 3) not null,
  rank integer,
  grounding_status text not null,
  news_eligible boolean not null default false,
  reason_codes jsonb not null default '[]'::jsonb,
  input_snapshot jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint editorial_rankings_version_not_blank check (btrim(ranking_version) <> ''),
  constraint editorial_rankings_component_range check (
    information_gap_score between 0 and 100
    and fact_grounding_score between 0 and 100
    and discovery_audience_signal_score between 0 and 100
    and match_context_score between 0 and 100
    and freshness_score between 0 and 100
    and editorial_score between 0 and 100
  ),
  constraint editorial_rankings_rank_positive check (rank is null or rank > 0),
  constraint editorial_rankings_grounding_status_check check (grounding_status in ('VERIFIED', 'DISCOVERY_ONLY', 'INSUFFICIENT', 'CONTRADICTED')),
  constraint editorial_rankings_reason_codes_array check (jsonb_typeof(reason_codes) = 'array'),
  constraint editorial_rankings_snapshot_object check (jsonb_typeof(input_snapshot) = 'object'),
  constraint editorial_rankings_identity_key unique (story_cluster_id, ranking_date, ranking_version)
);

alter table app_private.source_observations enable row level security;
alter table app_private.story_claims enable row level security;
alter table app_private.claim_evidence enable row level security;
alter table app_private.editorial_rankings enable row level security;

revoke all on table app_private.source_observations, app_private.story_claims,
  app_private.claim_evidence, app_private.editorial_rankings
  from public, anon, authenticated;
grant select, insert, update, delete on table app_private.source_observations,
  app_private.story_claims, app_private.claim_evidence, app_private.editorial_rankings
  to service_role;

create index source_observations_source_published_idx
  on app_private.source_observations (information_source_id, published_at desc, observed_at desc);
create index source_observations_role_observed_idx
  on app_private.source_observations (editorial_role, observed_at desc);
create index story_claims_cluster_status_idx
  on app_private.story_claims (story_cluster_id, grounding_status, updated_at desc);
create index claim_evidence_source_idx
  on app_private.claim_evidence (source_observation_id, is_grounding);
create index editorial_rankings_date_score_idx
  on app_private.editorial_rankings (ranking_date, editorial_score desc, rank asc nulls last);

create trigger source_observations_set_updated_at
before update on app_private.source_observations
for each row execute function app_private.set_updated_at();
create trigger story_claims_set_updated_at
before update on app_private.story_claims
for each row execute function app_private.set_updated_at();
create trigger editorial_rankings_set_updated_at
before update on app_private.editorial_rankings
for each row execute function app_private.set_updated_at();
