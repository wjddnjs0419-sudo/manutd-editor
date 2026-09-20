begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

create or replace function pg_temp.m6_active_config_count()
returns integer
language plpgsql
as $$
declare
  result integer;
begin
  if to_regclass('public.telegram_agent_configs') is null then
    return 0;
  end if;
  execute 'select count(*)::int from public.telegram_agent_configs where is_active' into result;
  return result;
end;
$$;

create or replace function pg_temp.m6_active_config_value(column_name text)
returns text
language plpgsql
as $$
declare
  result text;
begin
  if to_regclass('public.telegram_agent_configs') is null then
    return null;
  end if;
  execute format('select %I::text from public.telegram_agent_configs where is_active', column_name)
    into result;
  return result;
end;
$$;

select plan(34);

select has_table('public', 'matches', 'matches exists');
select has_table('public', 'telegram_agent_configs', 'agent config exists');
select has_table('app_private', 'telegram_users', 'telegram users exist');
select has_table('app_private', 'telegram_threads', 'telegram threads exist');
select has_table('app_private', 'telegram_messages', 'telegram messages exist');
select has_table('app_private', 'telegram_briefings', 'telegram briefings exist');
select has_table('app_private', 'telegram_alert_events', 'telegram alerts exist');
select has_table('app_private', 'telegram_candidate_alert_state', 'candidate alert state exists');
select has_table('app_private', 'telegram_command_events', 'command events exist');
select has_table('app_private', 'fixture_sync_state', 'fixture sync state exists');
select has_table('app_private', 'match_calendar_sync_state', 'match calendar state exists');

select col_is_pk('public', 'matches', 'id', 'matches uses id as primary key');
select has_column('public', 'matches', 'kickoff_at', 'matches stores kickoff');
select has_column('public', 'matches', 'manual_override', 'matches stores manual override');
select has_column('app_private', 'telegram_messages', 'telegram_update_id', 'messages store update id');
select has_column('app_private', 'telegram_threads', 'context_history', 'threads store context history');
select has_column('app_private', 'telegram_threads', 'pending_action', 'threads store pending action');
select has_column('app_private', 'telegram_briefings', 'candidate_snapshot', 'briefings freeze candidates');
select has_column('app_private', 'telegram_alert_events', 'event_fingerprint', 'alerts store fingerprint');

select isnt_empty(
  $$select 1 from pg_indexes where schemaname='public' and indexname='matches_provider_external_key'$$
);
select isnt_empty(
  $$select 1 from pg_indexes where schemaname='app_private' and indexname='telegram_messages_update_id_key'$$
);
select isnt_empty(
  $$select 1 from pg_indexes where schemaname='app_private' and indexname='telegram_alert_events_fingerprint_key'$$
);
select isnt_empty(
  $$select 1 from pg_indexes where schemaname='app_private' and indexname='telegram_briefings_thread_date_key'$$
);

select ok(coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.matches')), false), 'matches RLS');
select ok(coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.telegram_agent_configs')), false), 'agent config RLS');
select ok(coalesce((select relrowsecurity from pg_class where oid=to_regclass('app_private.telegram_messages')), false), 'messages RLS');

select is(pg_temp.m6_active_config_count(), 1, 'one active config');
select is(
  pg_temp.m6_active_config_value('timezone'),
  'Asia/Seoul',
  'KST config'
);
select is(
  pg_temp.m6_active_config_value('morning_brief_time'),
  '09:00:00',
  '09:00 brief'
);
select is(pg_temp.m6_active_config_value('briefing_top_n'), '3', 'top 3');
select is(pg_temp.m6_active_config_value('recent_message_limit'), '12', '12 recent');
select is(pg_temp.m6_active_config_value('summary_trigger_count'), '20', 'summary at 20');

select throws_ok(
  $$insert into public.matches(provider, external_match_id, competition, home_team, away_team, opponent, is_home, kickoff_at, status, last_synced_at)
    values ('espn','x','PL','A','B','B',true,now(),'BAD',now())$$,
  '23514'
);
select throws_ok(
  $$insert into app_private.telegram_alert_events(thread_id,event_type,event_fingerprint,payload,status)
    values (gen_random_uuid(),'FIRST_MOVER','x','{}','PENDING')$$,
  '23503'
);

select * from finish();
rollback;
