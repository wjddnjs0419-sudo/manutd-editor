create table public.creative_generation_configs (
  id uuid primary key default gen_random_uuid(),
  version extensions.citext not null unique,
  description text,
  classifier_config jsonb not null,
  generation_config jsonb not null,
  mode_configs jsonb not null,
  quality_gate_config jsonb not null,
  is_active boolean not null default false,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creative_generation_configs_version_not_blank check (btrim(version::text) <> ''),
  constraint creative_generation_configs_classifier_object check (jsonb_typeof(classifier_config) = 'object'),
  constraint creative_generation_configs_generation_object check (jsonb_typeof(generation_config) = 'object'),
  constraint creative_generation_configs_modes_object check (jsonb_typeof(mode_configs) = 'object'),
  constraint creative_generation_configs_quality_object check (jsonb_typeof(quality_gate_config) = 'object'),
  constraint creative_generation_configs_effective_window check (effective_to is null or effective_to > effective_from)
);

create unique index creative_generation_configs_one_active_idx
  on public.creative_generation_configs (is_active)
  where is_active;

alter table public.creative_briefs
  add column content_mode text,
  add column match_phase text,
  add column generation_config_id uuid references public.creative_generation_configs(id) on delete restrict,
  add column input_fingerprint text,
  add column evidence_snapshot jsonb not null default '{}'::jsonb,
  add column hooks_json jsonb not null default '[]'::jsonb,
  add column grounding_json jsonb not null default '{}'::jsonb,
  add column generation_metadata jsonb not null default '{}'::jsonb,
  add column generation_quality text,
  add column model_name text,
  add column generated_at timestamptz,
  add constraint creative_briefs_content_mode check (content_mode is null or content_mode in ('NEWS_UPDATE', 'ANALYSIS_CONTEXT', 'MATCH_CONTENT')),
  add constraint creative_briefs_match_phase check (match_phase is null or match_phase in ('PRE_MATCH', 'LIVE', 'POST_MATCH')),
  add constraint creative_briefs_input_fingerprint_not_blank check (input_fingerprint is null or btrim(input_fingerprint) <> ''),
  add constraint creative_briefs_evidence_snapshot_object check (jsonb_typeof(evidence_snapshot) = 'object'),
  add constraint creative_briefs_hooks_array check (jsonb_typeof(hooks_json) = 'array'),
  add constraint creative_briefs_grounding_object check (jsonb_typeof(grounding_json) = 'object'),
  add constraint creative_briefs_generation_metadata_object check (jsonb_typeof(generation_metadata) = 'object'),
  add constraint creative_briefs_generation_quality check (generation_quality is null or generation_quality in ('FULL', 'PARTIAL')),
  add constraint creative_briefs_model_name_not_blank check (model_name is null or btrim(model_name) <> '');

create unique index creative_briefs_candidate_fingerprint_idx
  on public.creative_briefs (candidate_id, input_fingerprint)
  where input_fingerprint is not null;

create table app_private.creative_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.content_candidates(id) on delete cascade,
  input_fingerprint text not null,
  trigger_type text not null,
  status text not null default 'QUEUED',
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  repair_attempted boolean not null default false,
  creative_brief_id uuid references public.creative_briefs(id) on delete set null,
  last_error_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint creative_generation_jobs_fingerprint_not_blank check (btrim(input_fingerprint) <> ''),
  constraint creative_generation_jobs_trigger_type check (trigger_type in ('AUTO_PRIORITY', 'NOTION_SELECTED', 'MANUAL')),
  constraint creative_generation_jobs_status check (status in ('QUEUED', 'GENERATING', 'READY', 'BLOCKED_EVIDENCE', 'CLASSIFICATION_UNCERTAIN', 'FAILED_VALIDATION', 'FAILED_PROVIDER')),
  constraint creative_generation_jobs_attempt_nonnegative check (attempt_count >= 0),
  unique (candidate_id, input_fingerprint)
);

create index creative_generation_jobs_candidate_idx
  on app_private.creative_generation_jobs (candidate_id, created_at desc);

create table app_private.creative_pipeline_sync_state (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.content_candidates(id) on delete cascade,
  creative_brief_id uuid not null references public.creative_briefs(id) on delete cascade,
  revision integer not null,
  notion_page_id text,
  sync_hash text,
  production_status text,
  last_error_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creative_pipeline_sync_revision_positive check (revision > 0),
  constraint creative_pipeline_sync_page_not_blank check (notion_page_id is null or btrim(notion_page_id) <> ''),
  constraint creative_pipeline_sync_hash_not_blank check (sync_hash is null or btrim(sync_hash) <> ''),
  constraint creative_pipeline_sync_status check (production_status is null or production_status in ('EDITABLE', 'LOCKED', 'APPROVED', 'UNKNOWN')),
  unique (creative_brief_id),
  unique (candidate_id, revision),
  unique (notion_page_id)
);

alter table public.creative_generation_configs enable row level security;
alter table app_private.creative_generation_jobs enable row level security;
alter table app_private.creative_pipeline_sync_state enable row level security;

revoke all on table public.creative_generation_configs from public, anon, authenticated;
grant select, insert, update, delete on table public.creative_generation_configs to service_role;
revoke all on table app_private.creative_generation_jobs, app_private.creative_pipeline_sync_state from public, anon, authenticated;
grant select, insert, update, delete on table app_private.creative_generation_jobs, app_private.creative_pipeline_sync_state to service_role;

create trigger creative_generation_configs_set_updated_at
before update on public.creative_generation_configs
for each row execute function app_private.set_updated_at();

create trigger creative_generation_jobs_set_updated_at
before update on app_private.creative_generation_jobs
for each row execute function app_private.set_updated_at();

create trigger creative_pipeline_sync_state_set_updated_at
before update on app_private.creative_pipeline_sync_state
for each row execute function app_private.set_updated_at();
