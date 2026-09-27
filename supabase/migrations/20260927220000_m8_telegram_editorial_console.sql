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
      'EDITORIAL_JOB_DEAD',
      'INTELLIGENCE_COMPLETE'
    )
  );

alter table app_private.telegram_messages
  drop constraint telegram_messages_type_check;

alter table app_private.telegram_messages
  add constraint telegram_messages_type_check check (message_type in ('TEXT', 'COMMAND', 'BRIEFING', 'ALERT', 'CONSOLE'));

create table app_private.telegram_console_state (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references app_private.telegram_threads(id) on delete cascade,
  view_name text not null default 'HOME',
  page integer not null default 1,
  ranking_date date,
  candidate_id uuid references public.content_candidates(id) on delete set null,
  story_cluster_id uuid references public.story_clusters(id) on delete set null,
  brief_id uuid references public.creative_briefs(id) on delete set null,
  telegram_message_id bigint,
  state_version integer not null default 1,
  state_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_console_state_view_check check (view_name in ('HOME', 'RECOMMENDED', 'ALL', 'DETAIL', 'EVIDENCE', 'DRAFT', 'REEL')),
  constraint telegram_console_state_page_positive check (page > 0),
  constraint telegram_console_state_version_positive check (state_version > 0),
  constraint telegram_console_state_json_object check (jsonb_typeof(state_json) = 'object')
);

create unique index telegram_console_state_thread_key
  on app_private.telegram_console_state (thread_id);

create table app_private.telegram_editorial_dispositions (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references app_private.telegram_threads(id) on delete cascade,
  candidate_id uuid references public.content_candidates(id) on delete set null,
  story_cluster_id uuid not null references public.story_clusters(id) on delete cascade,
  ranking_date date not null,
  story_fingerprint text not null,
  disposition text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_editorial_dispositions_fingerprint_not_blank check (btrim(story_fingerprint) <> ''),
  constraint telegram_editorial_dispositions_type_check check (disposition in ('SKIPPED'))
);

create unique index telegram_editorial_dispositions_identity_key
  on app_private.telegram_editorial_dispositions (thread_id, story_cluster_id, ranking_date, story_fingerprint);

create table app_private.telegram_console_events (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references app_private.telegram_threads(id) on delete cascade,
  action text not null,
  status text not null,
  candidate_id uuid references public.content_candidates(id) on delete set null,
  story_cluster_id uuid references public.story_clusters(id) on delete set null,
  brief_id uuid references public.creative_briefs(id) on delete set null,
  telegram_update_id bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint telegram_console_events_action_not_blank check (btrim(action) <> ''),
  constraint telegram_console_events_status_check check (status in ('REQUESTED', 'COMPLETED', 'FAILED', 'SENT', 'STALE')),
  constraint telegram_console_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index telegram_console_events_thread_created_idx
  on app_private.telegram_console_events (thread_id, created_at desc);

create index telegram_console_events_action_created_idx
  on app_private.telegram_console_events (action, created_at desc);

create trigger telegram_console_state_set_updated_at
before update on app_private.telegram_console_state
for each row execute function app_private.set_updated_at();

create trigger telegram_editorial_dispositions_set_updated_at
before update on app_private.telegram_editorial_dispositions
for each row execute function app_private.set_updated_at();

alter table app_private.telegram_console_state enable row level security;
alter table app_private.telegram_editorial_dispositions enable row level security;
alter table app_private.telegram_console_events enable row level security;

revoke all on table
  app_private.telegram_console_state,
  app_private.telegram_editorial_dispositions,
  app_private.telegram_console_events
from public, anon, authenticated;

grant select, insert, update, delete on table
  app_private.telegram_console_state,
  app_private.telegram_editorial_dispositions,
  app_private.telegram_console_events
to service_role;

alter table public.creative_briefs
  add column style_profile text,
  add column style_version text,
  add constraint creative_briefs_style_profile_not_blank check (style_profile is null or btrim(style_profile) <> ''),
  add constraint creative_briefs_style_version_not_blank check (style_version is null or btrim(style_version) <> '');

