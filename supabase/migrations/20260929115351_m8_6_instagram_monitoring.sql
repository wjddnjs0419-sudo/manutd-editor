-- Keep the monitoring classification separate from M8's editorial evidence roles.
create type public.source_account_monitor_role as enum (
  'OFFICIAL',
  'COMPETITOR',
  'COMMUNITY'
);

alter table public.source_accounts
  add column monitor_role public.source_account_monitor_role not null default 'COMMUNITY';

-- Retain account and raw-post history while removing the previous monitoring pool.
update public.source_accounts
set active = false,
    monitor_role = 'COMPETITOR'::public.source_account_monitor_role
where username in (
  'utdreport',
  'utddistrict',
  'manunitedzone',
  'all.man.united',
  'manutd_daily',
  'mufc_news.20',
  'manchesterunited_central',
  'todayfootball',
  'footballoop.mag'
);

-- Existing capability/probe data is deliberately left untouched on conflict.
insert into public.source_accounts (username, region, monitor_role, active)
values
  ('manutd', 'GLOBAL', 'OFFICIAL', true),
  ('manview_mufc', 'KR', 'COMPETITOR', true),
  ('m4nligan', 'KR', 'COMPETITOR', true),
  ('manchreds', 'KR', 'COMPETITOR', true),
  ('jrny_mnu', 'KR', 'COMPETITOR', true),
  ('otsemate', 'KR', 'COMPETITOR', true),
  ('man_sa_nam_', 'KR', 'COMPETITOR', true),
  ('mufc_gossip_', 'KR', 'COMPETITOR', true),
  ('manpogki', 'KR', 'COMPETITOR', true)
on conflict (username) do update
set region = excluded.region,
    monitor_role = excluded.monitor_role,
    active = excluded.active;

update public.information_sources
set instagram_username = 'manutd'
where canonical_name = 'Manchester United'
  and instagram_username is distinct from 'manutd';
