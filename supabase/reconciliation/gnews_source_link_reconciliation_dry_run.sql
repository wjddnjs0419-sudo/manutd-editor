-- Read-only reconciliation plan. Requires migration
-- 20261012000300_gnews_source_link_reconciliation.sql to be installed in the
-- database being inspected. No rows are linked and quarantine is not written.
begin read only;

-- 1. Target total and decision totals before any apply.
select 'TOTAL' as decision, count(*)::integer as observation_count
from app_private.gnews_source_link_reconciliation_plan(null)
union all
select decision, count(*)::integer as observation_count
from app_private.gnews_source_link_reconciliation_plan(null)
group by decision
order by decision;

-- 2. Field discrepancy totals. Candidate JSON records each source separately,
-- including the exact outlet/title/date/fingerprint/role values used.
select mismatch_field, count(distinct plan.discovery_observation_id)::integer as observation_count
from app_private.gnews_source_link_reconciliation_plan(null) as plan
cross join lateral unnest(plan.mismatch_fields) as fields(mismatch_field)
group by mismatch_field
order by mismatch_field;

-- 3. Full review worksheet with IDs and before-state identity snapshots.
select
  discovery_observation_id,
  story_cluster_id,
  current_source_observation_id,
  candidate_source_observation_ids,
  candidate_count,
  decision,
  mismatch_fields,
  discovery_audit,
  candidate_audit
from app_private.gnews_source_link_reconciliation_plan(null)
order by decision, discovery_observation_id;

-- 4. Explicit no-match report. These rows are never auto-created or linked.
select discovery_observation_id, story_cluster_id, discovery_audit
from app_private.gnews_source_link_reconciliation_plan(null)
where decision = 'NO_MATCH'
order by discovery_observation_id;

rollback;
