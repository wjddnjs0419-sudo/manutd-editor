-- M8.6 promotion boundary: discovery observations become canonical stories
-- without treating discovery providers as fact verification.

alter table public.story_clusters
  add column discovery_promotion_key text,
  add constraint story_clusters_discovery_promotion_key_key unique (discovery_promotion_key);

alter table app_private.discovery_runs
  add column search_profile text not null default 'MANUAL',
  add constraint discovery_runs_search_profile_check check (search_profile in ('FAST', 'PLAYER_SWEEP', 'MANUAL'));

alter table app_private.discovery_queries
  add column search_profile text not null default 'MANUAL',
  add constraint discovery_queries_search_profile_check check (search_profile in ('FAST', 'PLAYER_SWEEP', 'MANUAL'));

alter table app_private.story_claims
  alter column raw_post_id drop not null,
  add column discovery_observation_id uuid references app_private.discovery_observations(id) on delete cascade,
  drop constraint if exists story_claims_origin_check,
  add constraint story_claims_origin_check check (origin in ('caption', 'image', 'carousel_slide', 'thumbnail', 'discovery_observation')),
  add constraint story_claims_source_check check (raw_post_id is not null or discovery_observation_id is not null);

create index story_claims_discovery_observation_idx
  on app_private.story_claims (discovery_observation_id, grounding_status, updated_at desc);

alter table app_private.editorial_jobs
  drop constraint if exists editorial_jobs_job_type_check;

alter table app_private.editorial_jobs
  add constraint editorial_jobs_job_type_check check (
    job_type in (
      'COLLECT_INSTAGRAM', 'ANALYZE_CONTENT', 'RUN_INTELLIGENCE',
      'DISCOVER_SOURCES', 'DISCOVER_TRENDS', 'PROMOTE_DISCOVERY',
      'GROUND_CLAIMS', 'RANK_EDITORIAL', 'GENERATE_PRIORITY',
      'SYNC_NOTION', 'PROJECT_NOTION', 'POLL_SELECTED', 'DISPATCH_ALERTS',
      'FIXTURE_SYNC', 'MORNING_BRIEF'
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
    'COLLECT_INSTAGRAM', 'ANALYZE_CONTENT', 'RUN_INTELLIGENCE',
    'DISCOVER_SOURCES', 'DISCOVER_TRENDS', 'PROMOTE_DISCOVERY',
    'GROUND_CLAIMS', 'RANK_EDITORIAL', 'GENERATE_PRIORITY',
    'SYNC_NOTION', 'PROJECT_NOTION', 'POLL_SELECTED', 'DISPATCH_ALERTS',
    'FIXTURE_SYNC', 'MORNING_BRIEF'
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
    select id into job_id from app_private.editorial_jobs where dedupe_key = p_dedupe_key;
  end if;
  return job_id;
end
$function$;

revoke all on function public.enqueue_editorial_job(text, jsonb, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_editorial_job(text, jsonb, text, integer, timestamptz) to service_role;

create or replace function public.enqueue_scheduled_discovery_job(
  p_search_profile text,
  p_scheduled_at timestamptz default clock_timestamp()
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  local_timestamp timestamp without time zone;
  bucket_timestamp timestamp without time zone;
  dedupe_key text;
begin
  if p_search_profile is null or p_search_profile not in ('FAST', 'PLAYER_SWEEP') then
    raise exception 'discovery search profile is invalid' using errcode = '22023';
  end if;
  local_timestamp := p_scheduled_at at time zone 'Asia/Seoul';
  if p_search_profile = 'FAST' then
    bucket_timestamp := date_trunc('hour', local_timestamp)
      + floor(extract(minute from local_timestamp) / 10) * interval '10 minutes';
  else
    bucket_timestamp := date_trunc('hour', local_timestamp);
  end if;
  dedupe_key := 'discovery-pipeline:' || lower(p_search_profile) || ':' || to_char(bucket_timestamp, 'YYYYMMDDHH24MI');
  return public.enqueue_editorial_job(
    'DISCOVER_TRENDS',
    jsonb_build_object('chain_key', dedupe_key, 'schedule', 'm8-6-discovery', 'search_profile', p_search_profile),
    dedupe_key,
    3,
    p_scheduled_at
  );
end
$function$;

revoke all on function public.enqueue_scheduled_discovery_job(text, timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_scheduled_discovery_job(text, timestamptz) to service_role;

create extension if not exists pg_cron;

select cron.schedule(
  'm8-6-discovery-fast-every-10-minutes',
  '*/10 * * * *',
  $$select public.enqueue_scheduled_discovery_job('FAST', clock_timestamp());$$
);

select cron.schedule(
  'm8-6-discovery-player-sweep-every-hour',
  '0 * * * *',
  $$select public.enqueue_scheduled_discovery_job('PLAYER_SWEEP', clock_timestamp());$$
);
