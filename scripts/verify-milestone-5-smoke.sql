\set ON_ERROR_STOP on

begin;

create temporary table m5_smoke_failures (assertion text not null) on commit drop;

insert into m5_smoke_failures
select 'exactly_one_active_generation_config'
where (select count(*) from public.creative_generation_configs where is_active) <> 1;

insert into m5_smoke_failures
select 'ready_briefs_have_frozen_evidence_and_grounding'
where exists (
  select 1 from public.creative_briefs
  where status = 'READY' and (evidence_snapshot is null or grounding_json is null or input_fingerprint is null)
);

insert into m5_smoke_failures
select 'grounding_ids_are_in_frozen_evidence'
where exists (
  select 1
  from public.creative_briefs cb
  cross join lateral jsonb_array_elements(coalesce(cb.grounding_json -> 'claims', '[]'::jsonb)) claim
  where cb.status = 'READY'
    and exists (
      select 1
      from jsonb_array_elements_text(coalesce(claim -> 'evidence_ids', '[]'::jsonb)) evidence_id
      where not exists (
        select 1
        from jsonb_array_elements(coalesce(cb.evidence_snapshot -> 'posts', '[]'::jsonb) || coalesce(cb.evidence_snapshot -> 'sources', '[]'::jsonb) || coalesce(cb.evidence_snapshot -> 'scores', '[]'::jsonb)) frozen
        where frozen ->> 'evidence_id' = evidence_id
      )
    )
);

insert into m5_smoke_failures
select 'generation_jobs_have_allowed_status_and_single_repair_flag'
where exists (
  select 1 from app_private.creative_generation_jobs
  where status not in ('QUEUED', 'GENERATING', 'READY', 'BLOCKED_EVIDENCE', 'CLASSIFICATION_UNCERTAIN', 'FAILED_VALIDATION', 'FAILED_PROVIDER')
     or repair_attempted not in (true, false)
);

do $$
declare failed text;
begin
  select string_agg(assertion, ', ' order by assertion) into failed from m5_smoke_failures;
  if failed is not null then raise exception 'milestone 5 smoke assertions failed: %', failed; end if;
end
$$;

select 'milestone 5 smoke assertions passed' as result;
rollback;
