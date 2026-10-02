-- M8.7: replace ten-minute editorial polling with a bounded hourly digest.

alter table app_private.editorial_jobs drop constraint if exists editorial_jobs_job_type_check;
alter table app_private.editorial_jobs add constraint editorial_jobs_job_type_check check (
  job_type in ('COLLECT_INSTAGRAM', 'ANALYZE_CONTENT', 'RUN_INTELLIGENCE', 'DISCOVER_SOURCES', 'DISCOVER_TRENDS', 'PROMOTE_DISCOVERY', 'GROUND_CLAIMS', 'RANK_EDITORIAL', 'GENERATE_PRIORITY', 'SYNC_NOTION', 'PROJECT_NOTION', 'POLL_SELECTED', 'DISPATCH_ALERTS', 'FIXTURE_SYNC', 'MORNING_BRIEF', 'EDITORIAL_DIGEST')
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
    'COLLECT_INSTAGRAM', 'ANALYZE_CONTENT', 'RUN_INTELLIGENCE', 'DISCOVER_SOURCES', 'DISCOVER_TRENDS',
    'PROMOTE_DISCOVERY', 'GROUND_CLAIMS', 'RANK_EDITORIAL', 'GENERATE_PRIORITY', 'SYNC_NOTION',
    'PROJECT_NOTION', 'POLL_SELECTED', 'DISPATCH_ALERTS', 'FIXTURE_SYNC', 'MORNING_BRIEF', 'EDITORIAL_DIGEST'
  ) then raise exception 'editorial job type is invalid' using errcode = '22023'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'editorial job payload must be an object' using errcode = '22023'; end if;
  if p_dedupe_key is null or btrim(p_dedupe_key) = '' then raise exception 'editorial job dedupe key is invalid' using errcode = '22023'; end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 10 then raise exception 'editorial job max attempts is invalid' using errcode = '22023'; end if;
  insert into app_private.editorial_jobs (job_type, payload, dedupe_key, max_attempts, available_at)
  values (p_job_type, p_payload, p_dedupe_key, p_max_attempts, coalesce(p_available_at, now()))
  on conflict (dedupe_key) do nothing returning id into job_id;
  if job_id is null then select id into job_id from app_private.editorial_jobs where dedupe_key = p_dedupe_key; end if;
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
  bucket_timestamp := date_trunc('hour', local_timestamp);
  dedupe_key := 'discovery-pipeline:' || lower(p_search_profile) || ':' || to_char(bucket_timestamp, 'YYYYMMDDHH24MI');
  return public.enqueue_editorial_job(
    'DISCOVER_TRENDS',
    jsonb_build_object('chain_key', dedupe_key, 'schedule', 'm8-7-hourly', 'search_profile', p_search_profile),
    dedupe_key,
    3,
    p_scheduled_at
  );
end
$function$;

revoke all on function public.enqueue_scheduled_discovery_job(text, timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_scheduled_discovery_job(text, timestamptz) to service_role;

create or replace function public.enqueue_scheduled_editorial_digest(
  p_scheduled_at timestamptz default clock_timestamp()
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  local_hour timestamp without time zone;
  window_start timestamptz;
  window_end timestamptz;
  bucket_key text;
begin
  local_hour := date_trunc('hour', p_scheduled_at at time zone 'Asia/Seoul') - interval '1 hour';
  window_start := local_hour at time zone 'Asia/Seoul';
  window_end := (local_hour + interval '1 hour') at time zone 'Asia/Seoul';
  bucket_key := 'editorial-digest:' || to_char(local_hour, 'YYYYMMDDHH24');
  return public.enqueue_editorial_job(
    'EDITORIAL_DIGEST',
    jsonb_build_object('window_start', window_start, 'window_end', window_end, 'timezone', 'Asia/Seoul'),
    bucket_key,
    5,
    p_scheduled_at
  );
end
$function$;

revoke all on function public.enqueue_scheduled_editorial_digest(timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_scheduled_editorial_digest(timestamptz) to service_role;

alter table app_private.telegram_alert_events
  add column if not exists attempt_count integer not null default 0,
  add column if not exists max_attempt_count integer not null default 5;

alter table app_private.telegram_alert_events
  drop constraint if exists telegram_alert_events_type_check;

alter table app_private.telegram_alert_events
  add constraint telegram_alert_events_type_check check (
    event_type in (
      'FIRST_MOVER', 'MUST_COVER', 'MATCH_STATUS', 'MATCH_BRIEFING_D1',
      'FIXTURE_KICKOFF_CHANGED', 'FIXTURE_POSTPONED', 'FIXTURE_CANCELLED', 'FIXTURE_VENUE_CHANGED',
      'BREAKING_STORY', 'RISING_STORY', 'VERIFIED_STORY', 'EDITORIAL_JOB_DEAD',
      'INTELLIGENCE_COMPLETE', 'EDITORIAL_DIGEST'
    )
  );

-- Remove only the known M8.6 FAST cron entry and move the independent player sweep to :30.
select cron.unschedule(jobid) from cron.job where jobname = 'm8-6-discovery-fast-every-10-minutes';
select cron.unschedule(jobid) from cron.job where jobname = 'm8-6-discovery-player-sweep-every-hour';

select cron.schedule(
  'm8-7-discovery-fast-hourly',
  '0 * * * *',
  $$select public.enqueue_scheduled_discovery_job('FAST', clock_timestamp());$$
);

select cron.schedule(
  'm8-7-discovery-player-sweep-hourly',
  '30 * * * *',
  $$select public.enqueue_scheduled_discovery_job('PLAYER_SWEEP', clock_timestamp());$$
);

select cron.schedule(
  'm8-7-editorial-digest-hourly',
  '5 * * * *',
  $$select public.enqueue_scheduled_editorial_digest(clock_timestamp());$$
);
