alter table public.creative_briefs
  add column exploration_fingerprint text,
  add column provider_calls integer not null default 0,
  add column input_tokens bigint not null default 0,
  add column output_tokens bigint not null default 0,
  add column estimated_cost_usd numeric(12, 6),
  add constraint creative_briefs_exploration_usage_nonnegative check (
    provider_calls >= 0 and input_tokens >= 0 and output_tokens >= 0
    and (estimated_cost_usd is null or estimated_cost_usd >= 0)
  );

create unique index creative_briefs_exploration_fingerprint_idx
  on public.creative_briefs (exploration_fingerprint)
  where exploration_fingerprint is not null;

alter table app_private.creative_generation_jobs
  add column generation_intent text not null default 'STANDARD',
  add column exploration_fingerprint text,
  add column reserved_at timestamptz not null default now(),
  add column provider_calls integer not null default 0,
  add column input_tokens bigint not null default 0,
  add column output_tokens bigint not null default 0,
  add column retry_count integer not null default 0,
  add column estimated_cost_usd numeric(12, 6),
  add constraint creative_generation_jobs_intent check (generation_intent in ('STANDARD', 'EXPLORATION')),
  add constraint creative_generation_jobs_exploration_fingerprint check (
    (generation_intent = 'EXPLORATION' and exploration_fingerprint is not null)
    or (generation_intent = 'STANDARD' and exploration_fingerprint is null)
  ),
  add constraint creative_generation_jobs_usage_nonnegative check (
    provider_calls >= 0 and input_tokens >= 0 and output_tokens >= 0 and retry_count >= 0
    and (estimated_cost_usd is null or estimated_cost_usd >= 0)
  );

create unique index creative_generation_jobs_exploration_fingerprint_idx
  on app_private.creative_generation_jobs (exploration_fingerprint)
  where generation_intent = 'EXPLORATION';

create index creative_generation_jobs_exploration_daily_idx
  on app_private.creative_generation_jobs (((reserved_at at time zone 'Asia/Seoul')::date), status)
  where generation_intent = 'EXPLORATION';

create or replace function public.reserve_editorial_exploration_generation(
  p_candidate_id uuid,
  p_exploration_fingerprint text,
  p_trigger_type text,
  p_at timestamptz,
  p_daily_limit integer default 10
)
returns table(status text, job_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_business_date date;
  v_job_id uuid;
  v_job_status text;
  v_lease_expires_at timestamptz;
  v_count integer;
  v_limit integer;
begin
  if p_candidate_id is null or p_exploration_fingerprint is null or btrim(p_exploration_fingerprint) = ''
     or p_trigger_type is null or p_trigger_type not in ('AUTO_PRIORITY', 'NOTION_SELECTED', 'MANUAL') or p_at is null then
    raise exception 'exploration reservation input is invalid' using errcode = '22023';
  end if;

  v_business_date := (p_at at time zone 'Asia/Seoul')::date;
  v_limit := least(greatest(coalesce(p_daily_limit, 10), 1), 10);
  perform pg_advisory_xact_lock(hashtext('editorial-exploration-day:' || v_business_date::text));
  perform pg_advisory_xact_lock(hashtext('editorial-exploration-fingerprint:' || p_exploration_fingerprint));

  select job.id, job.status, job.lease_expires_at
    into v_job_id, v_job_status, v_lease_expires_at
    from app_private.creative_generation_jobs as job
   where job.generation_intent = 'EXPLORATION'
     and job.exploration_fingerprint = p_exploration_fingerprint
   for update;

  if found then
    if v_job_status in ('FAILED_PROVIDER', 'FAILED_VALIDATION', 'BLOCKED_EVIDENCE', 'CLASSIFICATION_UNCERTAIN')
       or (v_job_status = 'GENERATING' and (v_lease_expires_at is null or v_lease_expires_at <= p_at)) then
      update app_private.creative_generation_jobs as job
         set candidate_id = p_candidate_id,
             trigger_type = p_trigger_type,
             status = 'QUEUED',
             lease_owner = null,
             lease_expires_at = null,
             last_error_category = null,
             completed_at = null,
             reserved_at = p_at
       where job.id = v_job_id;
      return query select 'RESERVED'::text, v_job_id;
    else
      return query select 'EXISTING'::text, v_job_id;
    end if;
    return;
  end if;

  select count(*)::integer into v_count
    from app_private.creative_generation_jobs as job
   where job.generation_intent = 'EXPLORATION'
     and (job.reserved_at at time zone 'Asia/Seoul')::date = v_business_date
     and job.status in ('QUEUED', 'GENERATING', 'DRAFT', 'READY');

  if v_count >= v_limit then
    return query select 'DAILY_LIMIT'::text, null::uuid;
    return;
  end if;

  insert into app_private.creative_generation_jobs (
    candidate_id, input_fingerprint, exploration_fingerprint, generation_intent,
    trigger_type, status, reserved_at
  ) values (
    p_candidate_id, p_exploration_fingerprint, p_exploration_fingerprint, 'EXPLORATION',
    p_trigger_type, 'QUEUED', p_at
  ) returning id into v_job_id;

  return query select 'RESERVED'::text, v_job_id;
end
$function$;

revoke all on function public.reserve_editorial_exploration_generation(uuid, text, text, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_editorial_exploration_generation(uuid, text, text, timestamptz, integer)
  to service_role;
