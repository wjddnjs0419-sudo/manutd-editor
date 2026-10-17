-- Restored source for the production-applied M9 private preview job table.
-- The runtime must use the service role; anon/authenticated get no table access.
create table if not exists app_private.m9_preview_jobs (
  id uuid primary key default gen_random_uuid(),
  job_key text not null unique,
  creative_brief_id uuid not null references public.creative_briefs(id) on delete restrict,
  status text not null default 'CLAIMED'
    check (status in ('CLAIMED','RENDERED','UPLOADED','SENDING','SENT','SEND_UNCERTAIN','FAILED')),
  media_manifest jsonb not null default '{}'::jsonb check(jsonb_typeof(media_manifest)='object'),
  rendered_manifest jsonb not null default '{}'::jsonb check(jsonb_typeof(rendered_manifest)='object'),
  telegram_message_ids jsonb not null default '[]'::jsonb check(jsonb_typeof(telegram_message_ids)='array'),
  error_category text,
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table app_private.m9_preview_jobs enable row level security;
revoke all on app_private.m9_preview_jobs from public, anon, authenticated;
grant select, insert, update on app_private.m9_preview_jobs to service_role;
create index if not exists m9_preview_jobs_brief_idx on app_private.m9_preview_jobs(creative_brief_id, claimed_at desc);
-- Duplicate claims are rejected by unique(job_key).
-- The worker must update with equality guards on BOTH job_key and previous status.
-- SENDING or SEND_UNCERTAIN must NEVER be retried without explicit operator reconciliation.
