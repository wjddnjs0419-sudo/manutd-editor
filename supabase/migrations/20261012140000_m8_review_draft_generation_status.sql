alter table app_private.creative_generation_jobs
  drop constraint creative_generation_jobs_status,
  add constraint creative_generation_jobs_status check (
    status in ('QUEUED', 'GENERATING', 'READY', 'DRAFT', 'BLOCKED_EVIDENCE',
      'CLASSIFICATION_UNCERTAIN', 'FAILED_VALIDATION', 'FAILED_PROVIDER')
  );
