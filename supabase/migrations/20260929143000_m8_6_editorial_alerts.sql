-- M8.6 real-time editorial transitions and match briefing event support.

alter table app_private.telegram_alert_events
  add column story_cluster_id uuid references public.story_clusters(id) on delete set null;

alter table app_private.telegram_alert_events
  drop constraint if exists telegram_alert_events_type_check;

alter table app_private.telegram_alert_events
  add constraint telegram_alert_events_type_check check (
    event_type in (
      'FIRST_MOVER',
      'MUST_COVER',
      'MATCH_STATUS',
      'MATCH_BRIEFING_D1',
      'FIXTURE_KICKOFF_CHANGED',
      'FIXTURE_POSTPONED',
      'FIXTURE_CANCELLED',
      'FIXTURE_VENUE_CHANGED',
      'BREAKING_STORY',
      'RISING_STORY',
      'VERIFIED_STORY',
      'EDITORIAL_JOB_DEAD',
      'INTELLIGENCE_COMPLETE'
    )
  );

create table app_private.telegram_story_alert_state (
  story_cluster_id uuid primary key references public.story_clusters(id) on delete cascade,
  observed_state text,
  last_alerted_state text,
  last_alerted_at timestamptz,
  verified_notified boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint telegram_story_alert_observed_state_check check (observed_state is null or observed_state in ('RISING', 'BREAKING')),
  constraint telegram_story_alert_last_state_check check (last_alerted_state is null or last_alerted_state in ('RISING', 'BREAKING'))
);

create index telegram_alert_events_story_created_idx
  on app_private.telegram_alert_events (story_cluster_id, created_at desc);

create trigger telegram_story_alert_state_set_updated_at
before update on app_private.telegram_story_alert_state
for each row execute function app_private.set_updated_at();

alter table app_private.telegram_story_alert_state enable row level security;
revoke all on table app_private.telegram_story_alert_state from public, anon, authenticated;
grant select, insert, update, delete on table app_private.telegram_story_alert_state to service_role;
