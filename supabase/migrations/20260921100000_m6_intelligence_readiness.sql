create table app_private.intelligence_readiness (
  ranking_date date primary key,
  status text not null,
  candidate_count integer not null default 0,
  started_at timestamptz not null,
  completed_at timestamptz,
  error_category text,
  updated_at timestamptz not null default now(),
  constraint intelligence_readiness_status_check check (status in ('RUNNING', 'SUCCEEDED', 'FAILED')),
  constraint intelligence_readiness_candidate_count_nonnegative check (candidate_count >= 0),
  constraint intelligence_readiness_completed_after_started check (completed_at is null or completed_at >= started_at)
);

alter table app_private.intelligence_readiness enable row level security;
revoke all on table app_private.intelligence_readiness from public, anon, authenticated;
grant select, insert, update, delete on table app_private.intelligence_readiness to service_role;

create index intelligence_readiness_status_idx
  on app_private.intelligence_readiness (status, ranking_date desc);
