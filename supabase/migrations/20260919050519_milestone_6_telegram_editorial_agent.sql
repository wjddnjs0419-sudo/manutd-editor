-- Milestone 6 Telegram Editorial Agent runtime contracts.

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_match_id text not null,
  competition text not null,
  season text,
  home_team text not null,
  away_team text not null,
  opponent text not null,
  is_home boolean not null,
  kickoff_at timestamptz not null,
  venue text,
  status text not null,
  home_score integer,
  away_score integer,
  provider_payload jsonb not null default '{}'::jsonb,
  provider_updated_at timestamptz,
  last_synced_at timestamptz not null,
  manual_override jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint matches_provider_external_key unique (provider, external_match_id),
  constraint matches_status_check check (status in ('SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED')),
  constraint matches_home_score_nonnegative check (home_score is null or home_score >= 0),
  constraint matches_away_score_nonnegative check (away_score is null or away_score >= 0),
  constraint matches_provider_payload_object check (jsonb_typeof(provider_payload) = 'object'),
  constraint matches_manual_override_object check (manual_override is null or jsonb_typeof(manual_override) = 'object')
);

create table public.telegram_agent_configs (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique,
  is_active boolean not null default false,
  timezone text not null default 'Asia/Seoul',
  morning_brief_time time not null default '09:00',
  briefing_top_n integer not null default 3,
  recent_message_limit integer not null default 12,
  summary_trigger_count integer not null default 20,
  alert_cooldown_minutes integer not null default 60,
  model_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_agent_configs_version_positive check (version > 0),
  constraint telegram_agent_configs_timezone_not_blank check (btrim(timezone) <> ''),
  constraint telegram_agent_configs_top_n check (briefing_top_n between 1 and 3),
  constraint telegram_agent_configs_recent_limit check (recent_message_limit between 1 and 50),
  constraint telegram_agent_configs_summary_trigger check (summary_trigger_count >= recent_message_limit),
  constraint telegram_agent_configs_alert_cooldown check (alert_cooldown_minutes >= 0),
  constraint telegram_agent_configs_model_object check (jsonb_typeof(model_config) = 'object')
);

create unique index telegram_agent_configs_one_active_idx
  on public.telegram_agent_configs (is_active)
  where is_active;

create table app_private.fixture_sync_state (
  provider text primary key,
  last_full_sync_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_category text,
  rate_limit_remaining integer,
  updated_at timestamptz not null default now(),
  constraint fixture_sync_state_rate_limit_nonnegative check (rate_limit_remaining is null or rate_limit_remaining >= 0)
);

create table app_private.telegram_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  display_name text,
  role text not null default 'OWNER',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_users_role_check check (role in ('OWNER', 'EDITOR'))
);

create table app_private.telegram_threads (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null,
  telegram_user_id uuid not null references app_private.telegram_users(id) on delete restrict,
  active_candidate_id uuid references public.content_candidates(id) on delete set null,
  active_brief_id uuid references public.creative_briefs(id) on delete set null,
  active_match_id uuid references public.matches(id) on delete set null,
  active_content_pipeline_ref text,
  context_history jsonb not null default '[]'::jsonb,
  conversation_summary text,
  summary_message_count integer not null default 0,
  summary_updated_at timestamptz,
  pending_action jsonb,
  pending_action_expires_at timestamptz,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_threads_chat_user_key unique (telegram_chat_id, telegram_user_id),
  constraint telegram_threads_context_history_array check (jsonb_typeof(context_history) = 'array'),
  constraint telegram_threads_pending_action_object check (pending_action is null or jsonb_typeof(pending_action) = 'object'),
  constraint telegram_threads_summary_count_nonnegative check (summary_message_count >= 0)
);

create table app_private.telegram_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references app_private.telegram_threads(id) on delete cascade,
  telegram_message_id bigint,
  telegram_update_id bigint,
  role text not null,
  message_type text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint telegram_messages_role_check check (role in ('USER', 'ASSISTANT', 'SYSTEM_EVENT')),
  constraint telegram_messages_type_check check (message_type in ('TEXT', 'COMMAND', 'BRIEFING', 'ALERT')),
  constraint telegram_messages_content_not_blank check (btrim(content) <> ''),
  constraint telegram_messages_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create unique index telegram_messages_update_id_key
  on app_private.telegram_messages (telegram_update_id)
  where telegram_update_id is not null;

create index telegram_messages_thread_created_idx
  on app_private.telegram_messages (thread_id, created_at desc);

create table app_private.telegram_briefings (
  id uuid primary key default gen_random_uuid(),
  briefing_date date not null,
  thread_id uuid not null references app_private.telegram_threads(id) on delete cascade,
  match_context jsonb,
  candidate_snapshot jsonb not null,
  rendered_message text not null,
  generation_metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint telegram_briefings_thread_date_key unique (thread_id, briefing_date),
  constraint telegram_briefings_match_context_object check (match_context is null or jsonb_typeof(match_context) = 'object'),
  constraint telegram_briefings_candidate_snapshot_object check (jsonb_typeof(candidate_snapshot) = 'object'),
  constraint telegram_briefings_generation_metadata_object check (jsonb_typeof(generation_metadata) = 'object'),
  constraint telegram_briefings_message_not_blank check (btrim(rendered_message) <> '')
);

create table app_private.telegram_alert_events (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references app_private.telegram_threads(id) on delete cascade,
  event_type text not null,
  candidate_id uuid references public.content_candidates(id) on delete set null,
  match_id uuid references public.matches(id) on delete set null,
  event_fingerprint text not null,
  payload jsonb not null,
  status text not null,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  constraint telegram_alert_events_fingerprint_key unique (event_fingerprint),
  constraint telegram_alert_events_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint telegram_alert_events_status_check check (status in ('PENDING', 'SENT', 'FAILED')),
  constraint telegram_alert_events_type_check check (event_type in ('FIRST_MOVER', 'MUST_COVER', 'MATCH_STATUS', 'FIXTURE_KICKOFF_CHANGED', 'FIXTURE_POSTPONED', 'FIXTURE_CANCELLED', 'FIXTURE_VENUE_CHANGED'))
);

create table app_private.telegram_candidate_alert_state (
  candidate_id uuid primary key references public.content_candidates(id) on delete cascade,
  first_mover_flag boolean not null default false,
  must_cover_flag boolean not null default false,
  first_mover_transition integer not null default 0,
  must_cover_transition integer not null default 0,
  candidate_calculated_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint telegram_candidate_alert_first_transition_nonnegative check (first_mover_transition >= 0),
  constraint telegram_candidate_alert_must_transition_nonnegative check (must_cover_transition >= 0)
);

create table app_private.telegram_command_events (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references app_private.telegram_threads(id) on delete cascade,
  telegram_message_id bigint,
  telegram_update_id bigint,
  command_type text not null,
  target_candidate_id uuid references public.content_candidates(id) on delete set null,
  target_brief_id uuid references public.creative_briefs(id) on delete set null,
  input_args jsonb not null default '{}'::jsonb,
  status text not null,
  result_brief_id uuid references public.creative_briefs(id) on delete set null,
  error_code text,
  created_at timestamptz not null default now(),
  constraint telegram_command_events_input_args_object check (jsonb_typeof(input_args) = 'object'),
  constraint telegram_command_events_status_check check (status in ('PENDING', 'CONFIRMED', 'CANCELLED', 'SUCCEEDED', 'FAILED', 'EXPIRED'))
);

create unique index telegram_command_events_update_id_key
  on app_private.telegram_command_events (telegram_update_id)
  where telegram_update_id is not null;

create table app_private.match_calendar_sync_state (
  match_id uuid primary key references public.matches(id) on delete cascade,
  notion_page_id text unique,
  last_synced_hash text,
  last_synced_at timestamptz,
  last_error_category text,
  updated_at timestamptz not null default now()
);

create index matches_kickoff_idx
  on public.matches (kickoff_at);

create index matches_status_kickoff_idx
  on public.matches (status, kickoff_at);

create index telegram_briefings_date_idx
  on app_private.telegram_briefings (briefing_date desc);

create index telegram_alert_events_status_created_idx
  on app_private.telegram_alert_events (status, created_at);

create trigger matches_set_updated_at
before update on public.matches
for each row execute function app_private.set_updated_at();

create trigger telegram_agent_configs_set_updated_at
before update on public.telegram_agent_configs
for each row execute function app_private.set_updated_at();

create trigger fixture_sync_state_set_updated_at
before update on app_private.fixture_sync_state
for each row execute function app_private.set_updated_at();

create trigger telegram_users_set_updated_at
before update on app_private.telegram_users
for each row execute function app_private.set_updated_at();

create trigger telegram_threads_set_updated_at
before update on app_private.telegram_threads
for each row execute function app_private.set_updated_at();

create trigger telegram_candidate_alert_state_set_updated_at
before update on app_private.telegram_candidate_alert_state
for each row execute function app_private.set_updated_at();

create trigger match_calendar_sync_state_set_updated_at
before update on app_private.match_calendar_sync_state
for each row execute function app_private.set_updated_at();

alter table public.matches enable row level security;
alter table public.telegram_agent_configs enable row level security;

revoke all on table public.matches, public.telegram_agent_configs from public, anon, authenticated;
grant select, insert, update, delete on table public.matches, public.telegram_agent_configs to service_role;

alter table app_private.fixture_sync_state enable row level security;
alter table app_private.match_calendar_sync_state enable row level security;
alter table app_private.telegram_users enable row level security;
alter table app_private.telegram_threads enable row level security;
alter table app_private.telegram_messages enable row level security;
alter table app_private.telegram_briefings enable row level security;
alter table app_private.telegram_alert_events enable row level security;
alter table app_private.telegram_candidate_alert_state enable row level security;
alter table app_private.telegram_command_events enable row level security;

revoke all on table
  app_private.fixture_sync_state,
  app_private.match_calendar_sync_state,
  app_private.telegram_users,
  app_private.telegram_threads,
  app_private.telegram_messages,
  app_private.telegram_briefings,
  app_private.telegram_alert_events,
  app_private.telegram_candidate_alert_state,
  app_private.telegram_command_events
from public, anon, authenticated;

grant select, insert, update, delete on table
  app_private.fixture_sync_state,
  app_private.match_calendar_sync_state,
  app_private.telegram_users,
  app_private.telegram_threads,
  app_private.telegram_messages,
  app_private.telegram_briefings,
  app_private.telegram_alert_events,
  app_private.telegram_candidate_alert_state,
  app_private.telegram_command_events
to service_role;
