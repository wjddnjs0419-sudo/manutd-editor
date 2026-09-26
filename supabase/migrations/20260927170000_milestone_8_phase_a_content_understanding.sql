create table app_private.content_understandings (
  id uuid primary key default gen_random_uuid(),
  raw_post_id uuid not null references public.raw_posts(id) on delete cascade,
  status text not null,
  analysis_version text not null,
  model text not null,
  prompt_version text not null,
  input_fingerprint text not null,
  caption_summary text,
  visual_summary text,
  combined_summary text,
  entities jsonb not null default '[]'::jsonb,
  topics jsonb not null default '[]'::jsonb,
  on_image_text jsonb not null default '[]'::jsonb,
  important_numbers jsonb not null default '[]'::jsonb,
  source_names jsonb not null default '[]'::jsonb,
  claims jsonb not null default '[]'::jsonb,
  content_type text,
  visual_format text,
  analysis_confidence numeric(5, 4),
  evidence_state jsonb not null default '{}'::jsonb,
  error_category text,
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_understandings_status_check check (
    status in ('SUCCEEDED', 'PARTIAL', 'FAILED', 'UNAVAILABLE')
  ),
  constraint content_understandings_analysis_version_not_blank check (btrim(analysis_version) <> ''),
  constraint content_understandings_model_not_blank check (btrim(model) <> ''),
  constraint content_understandings_prompt_version_not_blank check (btrim(prompt_version) <> ''),
  constraint content_understandings_input_fingerprint_not_blank check (btrim(input_fingerprint) <> ''),
  constraint content_understandings_entities_array check (jsonb_typeof(entities) = 'array'),
  constraint content_understandings_topics_array check (jsonb_typeof(topics) = 'array'),
  constraint content_understandings_on_image_text_array check (jsonb_typeof(on_image_text) = 'array'),
  constraint content_understandings_important_numbers_array check (jsonb_typeof(important_numbers) = 'array'),
  constraint content_understandings_source_names_array check (jsonb_typeof(source_names) = 'array'),
  constraint content_understandings_claims_array check (jsonb_typeof(claims) = 'array'),
  constraint content_understandings_confidence_range check (
    analysis_confidence is null or analysis_confidence between 0 and 1
  ),
  constraint content_understandings_evidence_state_object check (jsonb_typeof(evidence_state) = 'object'),
  constraint content_understandings_identity_key unique (raw_post_id, analysis_version, input_fingerprint)
);

alter table app_private.content_understandings enable row level security;
revoke all on table app_private.content_understandings from public, anon, authenticated;
grant select, insert, update, delete on table app_private.content_understandings to service_role;

create index content_understandings_raw_post_current_idx
  on app_private.content_understandings (raw_post_id, analysis_version, created_at desc);

create index content_understandings_fingerprint_idx
  on app_private.content_understandings (raw_post_id, analysis_version, input_fingerprint);

create trigger content_understandings_set_updated_at
before update on app_private.content_understandings
for each row execute function app_private.set_updated_at();

alter table app_private.editorial_jobs
  drop constraint editorial_jobs_job_type_check;

alter table app_private.editorial_jobs
  add constraint editorial_jobs_job_type_check check (
    job_type in (
      'COLLECT_INSTAGRAM',
      'ANALYZE_CONTENT',
      'RUN_INTELLIGENCE',
      'GENERATE_PRIORITY',
      'SYNC_NOTION',
      'PROJECT_NOTION',
      'POLL_SELECTED',
      'DISPATCH_ALERTS',
      'FIXTURE_SYNC',
      'MORNING_BRIEF'
    )
  );

create or replace function public.enqueue_editorial_job(
  p_job_type text,
  p_payload jsonb,
  p_dedupe_key text,
  p_max_attempts integer default 3,
  p_available_at timestamptz default now()
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  job_id uuid;
begin
  if p_job_type is null or p_job_type not in (
    'COLLECT_INSTAGRAM',
    'ANALYZE_CONTENT',
    'RUN_INTELLIGENCE',
    'GENERATE_PRIORITY',
    'SYNC_NOTION',
    'PROJECT_NOTION',
    'POLL_SELECTED',
    'DISPATCH_ALERTS',
    'FIXTURE_SYNC',
    'MORNING_BRIEF'
  ) then
    raise exception 'editorial job type is invalid' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'editorial job payload must be an object' using errcode = '22023';
  end if;
  if p_dedupe_key is null or btrim(p_dedupe_key) = '' then
    raise exception 'editorial job dedupe key is invalid' using errcode = '22023';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 10 then
    raise exception 'editorial job max attempts is invalid' using errcode = '22023';
  end if;

  insert into app_private.editorial_jobs (job_type, payload, dedupe_key, max_attempts, available_at)
  values (p_job_type, p_payload, p_dedupe_key, p_max_attempts, coalesce(p_available_at, now()))
  on conflict (dedupe_key) do nothing
  returning id into job_id;

  if job_id is null then
    select id into job_id
    from app_private.editorial_jobs
    where dedupe_key = p_dedupe_key;
  end if;

  return job_id;
end
$function$;

revoke all on function public.enqueue_editorial_job(text, jsonb, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.enqueue_editorial_job(text, jsonb, text, integer, timestamptz)
  to service_role;
