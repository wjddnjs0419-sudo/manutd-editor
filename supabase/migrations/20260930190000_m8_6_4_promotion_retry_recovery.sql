alter table app_private.discovery_observations
  add column promotion_job_id uuid;

create index discovery_observations_promotion_job_idx
  on app_private.discovery_observations (promotion_job_id, last_observed_at, id)
  where promotion_job_id is not null;
