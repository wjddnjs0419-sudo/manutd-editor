-- PostgREST on_conflict cannot infer an index with a WHERE predicate.
-- A normal UNIQUE index still allows multiple NULL outbound update IDs.
begin;
drop index app_private.telegram_messages_update_id_key;
create unique index telegram_messages_update_id_key
  on app_private.telegram_messages (telegram_update_id);
commit;
