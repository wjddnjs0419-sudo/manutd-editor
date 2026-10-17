-- Replace the 15-minute fixture trigger with one run at 04:00 KST (19:00 UTC).
select cron.unschedule(job_id)
from unnest(array(
  select jobid
  from cron.job
  where jobname in (
    'm7-fixture-sync-every-15-minutes',
    'm7-fixture-sync-daily-0400-asia-seoul'
  )
)) as jobs(job_id);

select cron.schedule(
  'm7-fixture-sync-daily-0400-asia-seoul',
  '0 19 * * *',
  $$select public.enqueue_scheduled_editorial_job('FIXTURE_SYNC', clock_timestamp());$$
);
