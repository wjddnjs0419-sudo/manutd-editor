select 1 from public.matches limit 1;
select 1 from public.telegram_agent_configs where is_active;
select 1 from app_private.telegram_briefings limit 1;
select 1 from app_private.telegram_alert_events limit 1;
select relrowsecurity from pg_class where oid = 'app_private.telegram_messages'::regclass;
select relrowsecurity from pg_class where oid = 'app_private.telegram_command_events'::regclass;
