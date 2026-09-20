-- ESPN is public and unauthenticated; remove the legacy provider quota column.
alter table app_private.fixture_sync_state
  drop column if exists rate_limit_remaining;
