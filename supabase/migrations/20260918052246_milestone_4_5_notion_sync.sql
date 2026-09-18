create table app_private.notion_sync_state (
  sync_identity text primary key check (btrim(sync_identity) <> ''),
  candidate_id uuid not null references public.content_candidates(id) on delete cascade,
  story_cluster_id uuid not null references public.story_clusters(id) on delete cascade,
  ranking_date date not null,
  notion_page_id text,
  last_synced_hash text,
  last_synced_at timestamptz,
  sync_status text not null check (sync_status in ('CURRENT', 'DROPPED', 'EXPIRED', 'FAILED')),
  last_error_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (story_cluster_id, ranking_date),
  unique (notion_page_id),
  check (notion_page_id is null or btrim(notion_page_id) <> ''),
  check (last_synced_hash is null or btrim(last_synced_hash) <> '')
);

create index notion_sync_state_candidate_id_idx
  on app_private.notion_sync_state (candidate_id);

create index notion_sync_state_ranking_date_idx
  on app_private.notion_sync_state (ranking_date desc);

alter table app_private.notion_sync_state enable row level security;

revoke all on table app_private.notion_sync_state from public, anon, authenticated;
grant select, insert, update, delete on table app_private.notion_sync_state to service_role;
