begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(35);

select has_table('app_private', 'telegram_console_state', 'console state table exists');
select has_column('app_private', 'telegram_console_state', 'thread_id', 'console state belongs to a Telegram thread');
select has_column('app_private', 'telegram_console_state', 'view_name', 'console state stores current view');
select has_column('app_private', 'telegram_console_state', 'page', 'console state stores pagination');
select has_column('app_private', 'telegram_console_state', 'ranking_date', 'console state stores ranking date');
select has_column('app_private', 'telegram_console_state', 'candidate_id', 'console state stores candidate target');
select has_column('app_private', 'telegram_console_state', 'story_cluster_id', 'console state stores canonical story target');
select has_column('app_private', 'telegram_console_state', 'brief_id', 'console state stores brief target');
select has_column('app_private', 'telegram_console_state', 'telegram_message_id', 'console state stores navigation message');
select has_column('app_private', 'telegram_console_state', 'state_version', 'console state versions navigation state');
select isnt_empty($$select 1 from pg_indexes where schemaname = 'app_private' and indexname = 'telegram_console_state_thread_key'$$, 'one console state per thread');

select has_table('app_private', 'telegram_editorial_dispositions', 'editorial dispositions table exists');
select has_column('app_private', 'telegram_editorial_dispositions', 'story_fingerprint', 'dispositions freeze story identity');
select has_column('app_private', 'telegram_editorial_dispositions', 'disposition', 'dispositions store editor decision');
select isnt_empty($$select 1 from pg_indexes where schemaname = 'app_private' and indexname = 'telegram_editorial_dispositions_identity_key'$$, 'dispositions are idempotent per story window');

select has_table('app_private', 'telegram_console_events', 'console event table exists');
select has_column('app_private', 'telegram_console_events', 'action', 'console events store action');
select has_column('app_private', 'telegram_console_events', 'status', 'console events store status');
select has_column('app_private', 'telegram_console_events', 'metadata', 'console events store bounded metadata');
select isnt_empty($$select 1 from pg_indexes where schemaname = 'app_private' and indexname = 'telegram_console_events_thread_created_idx'$$, 'console events are indexed by thread and time');

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'app_private.telegram_alert_events'::regclass
      and pg_get_constraintdef(oid) ilike '%INTELLIGENCE_COMPLETE%'
  ),
  'alert outbox accepts intelligence-complete events'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'app_private.telegram_messages'::regclass
      and pg_get_constraintdef(oid) ilike '%CONSOLE%'
  ),
  'Telegram messages accept console updates'
);

select has_column('public', 'creative_briefs', 'style_profile', 'creative briefs store style profile');
select has_column('public', 'creative_briefs', 'style_version', 'creative briefs store style version');
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.creative_briefs'::regclass
      and conname = 'creative_briefs_style_profile_not_blank'
  ),
  'style profile cannot be blank when present'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.creative_briefs'::regclass
      and conname = 'creative_briefs_style_version_not_blank'
  ),
  'style version cannot be blank when present'
);

select ok(coalesce((select relrowsecurity from pg_class where oid = to_regclass('app_private.telegram_console_state')), false), 'console state RLS');
select ok(coalesce((select relrowsecurity from pg_class where oid = to_regclass('app_private.telegram_editorial_dispositions')), false), 'dispositions RLS');
select ok(coalesce((select relrowsecurity from pg_class where oid = to_regclass('app_private.telegram_console_events')), false), 'console events RLS');
select ok(has_table_privilege('service_role', 'app_private.telegram_console_state', 'SELECT, INSERT, UPDATE, DELETE'), 'service role owns console state');
select ok(has_table_privilege('service_role', 'app_private.telegram_editorial_dispositions', 'SELECT, INSERT, UPDATE, DELETE'), 'service role owns dispositions');
select ok(has_table_privilege('service_role', 'app_private.telegram_console_events', 'SELECT, INSERT, UPDATE, DELETE'), 'service role owns console events');
select ok(not has_table_privilege('anon', 'app_private.telegram_console_state', 'SELECT') and not has_table_privilege('authenticated', 'app_private.telegram_console_state', 'SELECT'), 'client roles cannot read console state');

select isnt_empty($$select 1 from pg_indexes where schemaname = 'app_private' and indexname = 'telegram_alert_events_fingerprint_key'$$, 'existing alert fingerprint idempotency remains');
select isnt_empty($$select 1 from pg_indexes where schemaname = 'public' and indexname = 'creative_briefs_candidate_fingerprint_idx'$$, 'existing creative generation idempotency remains');

select * from finish();
rollback;
