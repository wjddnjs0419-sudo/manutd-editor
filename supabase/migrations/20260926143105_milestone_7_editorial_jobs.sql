create table app_private.editorial_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status text not null default 'PENDING',
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_category text,
  last_error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint editorial_jobs_job_type_check check (
    job_type in (
      'COLLECT_INSTAGRAM',
      'RUN_INTELLIGENCE',
      'GENERATE_PRIORITY',
      'SYNC_NOTION',
      'POLL_SELECTED',
      'DISPATCH_ALERTS',
      'FIXTURE_SYNC',
      'MORNING_BRIEF'
    )
  ),
  constraint editorial_jobs_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint editorial_jobs_dedupe_key_not_blank check (btrim(dedupe_key) <> ''),
  constraint editorial_jobs_status_check check (status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD')),
  constraint editorial_jobs_attempt_count_nonnegative check (attempt_count >= 0),
  constraint editorial_jobs_max_attempts_bounded check (max_attempts between 1 and 10),
  constraint editorial_jobs_lock_pair check ((locked_at is null) = (locked_by is null)),
  constraint editorial_jobs_finished_after_started check (finished_at is null or started_at is null or finished_at >= started_at),
  constraint editorial_jobs_dedupe_key_key unique (dedupe_key)
);

alter table app_private.editorial_jobs enable row level security;
revoke all on table app_private.editorial_jobs from public, anon, authenticated;
grant select, insert, update, delete on table app_private.editorial_jobs to service_role;

create index editorial_jobs_status_available_idx
  on app_private.editorial_jobs (status, available_at, created_at);

create index editorial_jobs_running_lock_idx
  on app_private.editorial_jobs (status, locked_at)
  where status = 'RUNNING';

create trigger editorial_jobs_set_updated_at
before update on app_private.editorial_jobs
for each row execute function app_private.set_updated_at();

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
    'RUN_INTELLIGENCE',
    'GENERATE_PRIORITY',
    'SYNC_NOTION',
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

create or replace function public.claim_editorial_jobs(
  p_worker_id text,
  p_limit integer default 5,
  p_now timestamptz default clock_timestamp(),
  p_lease_seconds integer default 300
)
returns setof app_private.editorial_jobs
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'editorial worker id is invalid' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'editorial claim limit is invalid' using errcode = '22023';
  end if;
  if p_now is null then
    raise exception 'editorial claim timestamp is invalid' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 1800 then
    raise exception 'editorial lease duration is invalid' using errcode = '22023';
  end if;

  return query
  with selected as (
    select id
    from app_private.editorial_jobs
    where (
      status = 'PENDING'
      and available_at <= p_now
    ) or (
      status = 'RUNNING'
      and locked_at is not null
      and locked_at <= p_now - make_interval(secs => p_lease_seconds)
    )
    order by available_at asc, created_at asc, id asc
    limit p_limit
    for update skip locked
  )
  update app_private.editorial_jobs as job
  set status = 'RUNNING',
      attempt_count = job.attempt_count + 1,
      locked_at = p_now,
      locked_by = p_worker_id,
      started_at = coalesce(job.started_at, p_now),
      finished_at = null,
      updated_at = p_now
  from selected
  where job.id = selected.id
  returning job.*;
end
$function$;

create or replace function public.complete_editorial_job(
  p_job_id uuid,
  p_worker_id text,
  p_finished_at timestamptz default clock_timestamp()
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_job_id is null or p_worker_id is null or btrim(p_worker_id) = '' or p_finished_at is null then
    raise exception 'editorial completion input is invalid' using errcode = '22023';
  end if;

  update app_private.editorial_jobs
  set status = 'SUCCEEDED',
      locked_at = null,
      locked_by = null,
      finished_at = p_finished_at,
      updated_at = p_finished_at
  where id = p_job_id
    and status = 'RUNNING'
    and locked_by = p_worker_id;

  return found;
end
$function$;

create or replace function public.fail_editorial_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_category text,
  p_error_message text,
  p_failed_at timestamptz default clock_timestamp()
)
returns app_private.editorial_jobs
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  job app_private.editorial_jobs;
  safe_category text;
  safe_message text;
begin
  if p_job_id is null or p_worker_id is null or btrim(p_worker_id) = '' or p_failed_at is null then
    raise exception 'editorial failure input is invalid' using errcode = '22023';
  end if;

  safe_category := upper(regexp_replace(coalesce(p_error_category, 'UNKNOWN'), '[^A-Z0-9_]', '_', 'g'));
  safe_category := left(nullif(btrim(safe_category), ''), 64);
  safe_category := coalesce(safe_category, 'UNKNOWN');
  safe_message := coalesce(p_error_message, 'Editorial job failed');
  safe_message := regexp_replace(safe_message, '(?i)(bearer\s+)[^[:space:]]+', '\1[REDACTED]', 'g');
  safe_message := regexp_replace(safe_message, '(?i)(sk-|sb_secret_)[A-Za-z0-9_-]+', '[REDACTED]', 'g');
  safe_message := regexp_replace(safe_message, '(?i)(access_token|api_key|token)(\s*[:=]\s*)[^[:space:]]+', '\1\2[REDACTED]', 'g');
  safe_message := regexp_replace(safe_message, E'[\r\n\t]+', ' ', 'g');
  safe_message := left(safe_message, 240);

  update app_private.editorial_jobs
  set status = case when attempt_count >= max_attempts then 'DEAD' else 'PENDING' end,
      available_at = case
        when attempt_count >= max_attempts then p_failed_at
        when attempt_count = 1 then p_failed_at + interval '5 minutes'
        else p_failed_at + interval '15 minutes'
      end,
      locked_at = null,
      locked_by = null,
      last_error_category = safe_category,
      last_error_message = safe_message,
      finished_at = case when attempt_count >= max_attempts then p_failed_at else null end,
      updated_at = p_failed_at
  where id = p_job_id
    and status = 'RUNNING'
    and locked_by = p_worker_id
  returning * into job;

  if job.id is null then
    raise exception 'editorial job is not owned by worker' using errcode = '42501';
  end if;

  return job;
end
$function$;

revoke all on function public.enqueue_editorial_job(text, jsonb, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_editorial_jobs(text, integer, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.complete_editorial_job(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.fail_editorial_job(uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_editorial_job(text, jsonb, text, integer, timestamptz) to service_role;
grant execute on function public.claim_editorial_jobs(text, integer, timestamptz, integer) to service_role;
grant execute on function public.complete_editorial_job(uuid, text, timestamptz) to service_role;
grant execute on function public.fail_editorial_job(uuid, text, text, text, timestamptz) to service_role;
