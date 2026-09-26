create extension if not exists pg_cron;

create or replace function public.enqueue_scheduled_editorial_job(
  p_job_type text,
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
  schedule_name text;
begin
  if p_job_type is null or p_job_type not in ('COLLECT_INSTAGRAM', 'FIXTURE_SYNC', 'MORNING_BRIEF') then
    raise exception 'scheduled editorial job type is invalid' using errcode = '22023';
  end if;
  if p_scheduled_at is null then
    raise exception 'scheduled editorial timestamp is invalid' using errcode = '22023';
  end if;

  local_timestamp := p_scheduled_at at time zone 'Asia/Seoul';

  case p_job_type
    when 'COLLECT_INSTAGRAM' then
      bucket_timestamp := date_trunc('hour', local_timestamp)
        + floor(extract(minute from local_timestamp) / 30) * interval '30 minutes';
      dedupe_key := 'instagram-pipeline:' || to_char(bucket_timestamp, 'YYYYMMDDHH24MI');
      schedule_name := 'instagram-collector';
    when 'FIXTURE_SYNC' then
      bucket_timestamp := date_trunc('hour', local_timestamp)
        + floor(extract(minute from local_timestamp) / 15) * interval '15 minutes';
      dedupe_key := 'fixture-pipeline:' || to_char(bucket_timestamp, 'YYYYMMDDHH24MI');
      schedule_name := 'fixture-sync';
    when 'MORNING_BRIEF' then
      dedupe_key := 'morning-brief:' || local_timestamp::date::text;
      schedule_name := 'morning-brief';
  end case;

  return public.enqueue_editorial_job(
    p_job_type,
    jsonb_build_object('chain_key', dedupe_key, 'schedule', schedule_name),
    dedupe_key,
    3,
    p_scheduled_at
  );
end
$function$;

revoke all on function public.enqueue_scheduled_editorial_job(text, timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_scheduled_editorial_job(text, timestamptz) to service_role;

select cron.schedule(
  'm7-instagram-collector-every-30-minutes',
  '*/30 * * * *',
  $$select public.enqueue_scheduled_editorial_job('COLLECT_INSTAGRAM', clock_timestamp());$$
);

select cron.schedule(
  'm7-fixture-sync-every-15-minutes',
  '*/15 * * * *',
  $$select public.enqueue_scheduled_editorial_job('FIXTURE_SYNC', clock_timestamp());$$
);

-- Supabase/Postgres Cron runs in UTC by default; 00:00 UTC is 09:00 Asia/Seoul.
select cron.schedule(
  'm7-morning-brief-0900-asia-seoul',
  '0 0 * * *',
  $$select public.enqueue_scheduled_editorial_job('MORNING_BRIEF', clock_timestamp());$$
);
