begin;

set role postgres;
create extension if not exists pg_cron;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(7);

select ok(
  (select count(*) from pg_extension where extname = 'pg_net') = 1,
  'pg_net is enabled for scheduled Edge Function invocation'
);
select is(
  (select count(*)::integer from cron.job where jobname = 'm7-orchestration-worker-every-minute'),
  1,
  'the orchestration worker has one recurring Cron job'
);
select is(
  (select schedule from cron.job where jobname = 'm7-orchestration-worker-every-minute'),
  '* * * * *',
  'the orchestration worker is polled every minute'
);
select ok(
  (select command from cron.job where jobname = 'm7-orchestration-worker-every-minute') ilike '%net.http_post%',
  'the worker Cron job invokes the Edge Function over pg_net'
);
select ok(
  (select command from cron.job where jobname = 'm7-orchestration-worker-every-minute') ilike '%vault.decrypted_secrets%',
  'the worker Cron job reads URL and auth material from Vault'
);
select ok(
  (select command from cron.job where jobname = 'm7-orchestration-worker-every-minute') ilike '%/functions/v1/orchestration-worker%',
  'the worker Cron job targets the orchestration-worker function'
);
select ok(
  (select command from cron.job where jobname = 'm7-orchestration-worker-every-minute') not ilike '%sb_secret_%',
  'the worker Cron command does not embed a Supabase secret key'
);

select * from finish();
rollback;
