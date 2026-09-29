create table app_private.tracked_entities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  canonical_name text not null,
  aliases text[] not null default '{}'::text[],
  active boolean not null default true,
  tracking_tier text not null default 'BACKGROUND',
  national_team text,
  is_injured boolean not null default false,
  hot_started_at timestamptz,
  hot_until timestamptz,
  last_signal_at timestamptz,
  hot_signal_family text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracked_entities_type_check
    check (entity_type in ('PLAYER', 'MANAGER', 'OWNER', 'TRANSFER_TARGET')),
  constraint tracked_entities_name_not_blank check (btrim(canonical_name) <> ''),
  constraint tracked_entities_aliases_bounded check (
    cardinality(aliases) <= 32 and array_position(aliases, '') is null
  ),
  constraint tracked_entities_tier_check check (tracking_tier in ('HOT', 'FIRST_TEAM', 'BACKGROUND')),
  constraint tracked_entities_national_team_not_blank check (national_team is null or btrim(national_team) <> ''),
  constraint tracked_entities_hot_signal_family_check check (
    hot_signal_family is null or hot_signal_family in ('INJURY', 'TRANSFER', 'CONTRACT', 'INTERNATIONAL_DUTY')
  ),
  constraint tracked_entities_hot_window_check check (
    (hot_started_at is null and hot_until is null)
    or (hot_started_at is not null and hot_until > hot_started_at and hot_until <= hot_started_at + interval '6 hours')
  ),
  constraint tracked_entities_signal_timestamp_check check (
    last_signal_at is null or hot_started_at is null or last_signal_at >= hot_started_at
  ),
  constraint tracked_entities_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint tracked_entities_entity_name_key unique (entity_type, canonical_name)
);

alter table app_private.tracked_entities enable row level security;
revoke all on table app_private.tracked_entities from public, anon, authenticated;
grant select, insert, update, delete on table app_private.tracked_entities to service_role;

create index tracked_entities_active_type_tier_name_idx
  on app_private.tracked_entities (active, entity_type, tracking_tier, canonical_name);
create index tracked_entities_active_hot_until_idx
  on app_private.tracked_entities (hot_until desc)
  where active and hot_until is not null;
create index tracked_entities_injured_player_idx
  on app_private.tracked_entities (canonical_name)
  where active and entity_type = 'PLAYER' and is_injured;
create index tracked_entities_aliases_gin_idx
  on app_private.tracked_entities using gin (aliases);
create index tracked_entities_last_signal_idx
  on app_private.tracked_entities (last_signal_at desc)
  where last_signal_at is not null;

create trigger tracked_entities_set_updated_at
before update on app_private.tracked_entities
for each row execute function app_private.set_updated_at();

create or replace function app_private.mark_tracked_entity_hot(
  p_entity_id uuid,
  p_signal_family text,
  p_signal_at timestamptz default now()
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  signal_at timestamptz := coalesce(p_signal_at, now());
  started_at timestamptz;
  expires_at timestamptz;
begin
  if p_signal_family is null or p_signal_family not in ('INJURY', 'TRANSFER', 'CONTRACT', 'INTERNATIONAL_DUTY') then
    raise exception 'tracked entity signal family is invalid' using errcode = '22023';
  end if;

  select entity.hot_started_at, entity.hot_until
    into started_at, expires_at
  from app_private.tracked_entities as entity
  where entity.id = p_entity_id and entity.active
  for update;

  if not found then
    raise exception 'tracked entity is unavailable' using errcode = 'P0002';
  end if;

  if started_at is not null and expires_at > signal_at then
    expires_at := least(started_at + interval '6 hours', greatest(expires_at, signal_at + interval '3 hours'));
  else
    started_at := signal_at;
    expires_at := signal_at + interval '3 hours';
  end if;

  update app_private.tracked_entities
  set hot_started_at = started_at,
      hot_until = expires_at,
      last_signal_at = greatest(coalesce(last_signal_at, signal_at), signal_at),
      hot_signal_family = p_signal_family
  where id = p_entity_id;
end
$function$;

revoke all on function app_private.mark_tracked_entity_hot(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function app_private.mark_tracked_entity_hot(uuid, text, timestamptz) to service_role;
