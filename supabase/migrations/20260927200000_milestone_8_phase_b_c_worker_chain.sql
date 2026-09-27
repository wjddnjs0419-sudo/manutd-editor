alter table app_private.editorial_jobs
  drop constraint editorial_jobs_job_type_check;

alter table app_private.editorial_jobs
  add constraint editorial_jobs_job_type_check check (
    job_type in (
      'COLLECT_INSTAGRAM',
      'ANALYZE_CONTENT',
      'RUN_INTELLIGENCE',
      'DISCOVER_SOURCES',
      'GROUND_CLAIMS',
      'RANK_EDITORIAL',
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
    'DISCOVER_SOURCES',
    'GROUND_CLAIMS',
    'RANK_EDITORIAL',
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
