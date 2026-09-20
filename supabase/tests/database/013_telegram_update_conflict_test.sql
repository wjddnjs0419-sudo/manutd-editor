begin;
set search_path = extensions, public;
select plan(1);
select lives_ok(
  $$explain insert into app_private.telegram_messages
    (thread_id, telegram_update_id, role, message_type, content)
    values ('00000000-0000-0000-0000-000000000000', 1, 'USER', 'COMMAND', '/help')
    on conflict (telegram_update_id) do nothing$$,
  'PostgREST update deduplication conflict target is inferable'
);
select * from finish();
rollback;
