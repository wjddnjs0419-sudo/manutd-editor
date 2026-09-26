-- The root schedules enqueue work into editorial_jobs. This separate poller is
-- what makes the queue self-consuming when n8n is disabled.
create extension if not exists pg_net;

select cron.schedule(
  'm7-orchestration-worker-every-minute',
  '* * * * *',
  $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'm7_project_url')
        || '/functions/v1/orchestration-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'm7_orchestration_worker_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    ) as request_id;
  $cron$
);
