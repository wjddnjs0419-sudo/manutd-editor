alter table app_private.editorial_jobs
  drop constraint editorial_jobs_job_type_check;

alter table app_private.editorial_jobs
  add constraint editorial_jobs_job_type_check check (
    job_type in (
      'COLLECT_INSTAGRAM',
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

alter table app_private.telegram_alert_events
  drop constraint telegram_alert_events_type_check;

alter table app_private.telegram_alert_events
  add constraint telegram_alert_events_type_check check (
    event_type in (
      'FIRST_MOVER',
      'MUST_COVER',
      'MATCH_STATUS',
      'FIXTURE_KICKOFF_CHANGED',
      'FIXTURE_POSTPONED',
      'FIXTURE_CANCELLED',
      'FIXTURE_VENUE_CHANGED',
      'EDITORIAL_JOB_DEAD'
    )
  );

create table app_private.editorial_job_dead_alerts (
  job_id uuid primary key references app_private.editorial_jobs(id) on delete cascade,
  event_fingerprint text not null unique,
  payload jsonb not null,
  event_id uuid references app_private.telegram_alert_events(id) on delete set null,
  created_at timestamptz not null default now(),
  materialized_at timestamptz,
  constraint editorial_job_dead_alerts_fingerprint_not_blank check (btrim(event_fingerprint) <> ''),
  constraint editorial_job_dead_alerts_payload_object check (jsonb_typeof(payload) = 'object')
);

alter table app_private.editorial_job_dead_alerts enable row level security;
revoke all on table app_private.editorial_job_dead_alerts from public, anon, authenticated;
grant select, insert, update, delete on table app_private.editorial_job_dead_alerts to service_role;

create or replace function app_private.enqueue_creative_brief_projection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status = 'READY'::public.creative_brief_status
    and (tg_op = 'INSERT' or old.status is distinct from 'READY'::public.creative_brief_status) then
    begin
      perform public.enqueue_editorial_job(
        'PROJECT_NOTION',
        jsonb_build_object(
          'creative_brief_id', new.id::text,
          'candidate_id', new.candidate_id::text,
          'stage', 'PROJECT_NOTION'
        ),
        'creative-brief:' || new.id::text || ':PROJECT_NOTION',
        3,
        coalesce(new.updated_at, now())
      );
    exception when others then
      null;
    end;
  end if;
  return new;
end
$function$;

create trigger creative_briefs_enqueue_notion_projection
after insert or update of status on public.creative_briefs
for each row execute function app_private.enqueue_creative_brief_projection();

create or replace function app_private.record_editorial_job_dead_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  fingerprint text;
  alert_payload jsonb;
  owner_thread_id uuid;
  inserted_event_id uuid;
begin
  if new.status = 'DEAD' and old.status is distinct from 'DEAD' then
    fingerprint := 'EDITORIAL_JOB_DEAD:' || new.id::text;
    alert_payload := jsonb_build_object(
      'title', 'Editorial job became DEAD',
      'job_id', new.id::text,
      'job_type', new.job_type,
      'attempt_count', new.attempt_count,
      'error_category', coalesce(new.last_error_category, 'UNKNOWN'),
      'error_message', coalesce(new.last_error_message, 'Editorial job failed')
    );

    insert into app_private.editorial_job_dead_alerts (job_id, event_fingerprint, payload)
    values (new.id, fingerprint, alert_payload)
    on conflict (job_id) do nothing;

    select thread.id
    into owner_thread_id
    from app_private.telegram_threads as thread
    join app_private.telegram_users as telegram_user on telegram_user.id = thread.telegram_user_id
    where telegram_user.role = 'OWNER'
      and telegram_user.is_active
    order by thread.updated_at desc, thread.created_at desc
    limit 1;

    if owner_thread_id is not null then
      insert into app_private.telegram_alert_events (
        thread_id, event_type, event_fingerprint, payload, status
      )
      values (
        owner_thread_id, 'EDITORIAL_JOB_DEAD', fingerprint, alert_payload, 'PENDING'
      )
      on conflict (event_fingerprint) do nothing
      returning id into inserted_event_id;

      if inserted_event_id is null then
        select id into inserted_event_id
        from app_private.telegram_alert_events
        where event_fingerprint = fingerprint;
      end if;

      update app_private.editorial_job_dead_alerts
      set event_id = inserted_event_id,
          materialized_at = coalesce(materialized_at, now())
      where job_id = new.id
        and event_id is null;
    end if;
  end if;
  return new;
end
$function$;

create trigger editorial_jobs_record_dead_alert
after update of status on app_private.editorial_jobs
for each row execute function app_private.record_editorial_job_dead_alert();

create or replace function public.materialize_editorial_job_dead_alerts(p_thread_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  pending app_private.editorial_job_dead_alerts;
  inserted_event_id uuid;
  materialized_count integer := 0;
begin
  if p_thread_id is null then
    raise exception 'dead alert thread id is required' using errcode = '22023';
  end if;

  for pending in
    select *
    from app_private.editorial_job_dead_alerts
    where event_id is null
    order by created_at asc, job_id asc
  loop
    insert into app_private.telegram_alert_events (
      thread_id, event_type, event_fingerprint, payload, status
    )
    values (
      p_thread_id, 'EDITORIAL_JOB_DEAD', pending.event_fingerprint, pending.payload, 'PENDING'
    )
    on conflict (event_fingerprint) do nothing
    returning id into inserted_event_id;

    if inserted_event_id is null then
      select id into inserted_event_id
      from app_private.telegram_alert_events
      where event_fingerprint = pending.event_fingerprint;
    end if;

    if inserted_event_id is not null then
      update app_private.editorial_job_dead_alerts
      set event_id = inserted_event_id,
          materialized_at = coalesce(materialized_at, now())
      where job_id = pending.job_id
        and event_id is null;
      if found then materialized_count := materialized_count + 1; end if;
    end if;
  end loop;

  return materialized_count;
end
$function$;

create or replace view public.editorial_job_status as
select
  count(*) filter (where status = 'PENDING')::bigint as pending_count,
  count(*) filter (where status = 'RUNNING')::bigint as running_count,
  count(*) filter (where status = 'FAILED' or (status = 'PENDING' and attempt_count > 0))::bigint as failed_retry_count,
  count(*) filter (where status = 'DEAD')::bigint as dead_count,
  coalesce(floor(extract(epoch from (now() - min(created_at) filter (where status = 'PENDING'))))::bigint, 0) as oldest_pending_age_seconds,
  max(finished_at) filter (where job_type = 'COLLECT_INSTAGRAM' and status = 'SUCCEEDED') as last_successful_instagram_pipeline,
  max(finished_at) filter (where job_type = 'RUN_INTELLIGENCE' and status = 'SUCCEEDED') as last_successful_intelligence_run,
  max(finished_at) filter (where job_type = 'MORNING_BRIEF' and status = 'SUCCEEDED') as last_morning_brief
from app_private.editorial_jobs;

create or replace function public.get_editorial_job_status()
returns setof public.editorial_job_status
language sql
security invoker
set search_path = ''
as $function$
  select * from public.editorial_job_status;
$function$;

revoke all on function app_private.enqueue_creative_brief_projection() from public, anon, authenticated;
revoke all on function app_private.record_editorial_job_dead_alert() from public, anon, authenticated;
revoke all on function public.materialize_editorial_job_dead_alerts(uuid) from public, anon, authenticated;
revoke all on function public.get_editorial_job_status() from public, anon, authenticated;
revoke all on public.editorial_job_status from public, anon, authenticated;
grant execute on function public.materialize_editorial_job_dead_alerts(uuid) to service_role;
grant execute on function public.get_editorial_job_status() to service_role;
grant select on public.editorial_job_status to service_role;
