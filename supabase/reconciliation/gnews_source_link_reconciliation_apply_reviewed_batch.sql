-- Operator template only. Replace both arrays with IDs copied from a reviewed
-- read-only dry run. Keep both arrays aligned, include only SAFE_TO_LINK rows,
-- and apply no more than 30 pairs in a single transaction.
-- This file is not run by migrations or tests.

\set reviewed_discovery_ids '{00000000-0000-4000-8000-000000000001}'
\set reviewed_source_ids '{00000000-0000-4000-8000-000000000002}'

begin isolation level serializable;
select app_private.gnews_source_link_reconciliation_apply(
  :'reviewed_discovery_ids'::uuid[],
  :'reviewed_source_ids'::uuid[]
);
commit;
