-- Allow Telegram threads to open a grounded source observation that is not an Instagram candidate.
alter table app_private.telegram_threads
  add column if not exists active_source_observation_id uuid references app_private.source_observations(id) on delete set null;

create index if not exists telegram_threads_active_source_observation_idx
  on app_private.telegram_threads (active_source_observation_id)
  where active_source_observation_id is not null;
