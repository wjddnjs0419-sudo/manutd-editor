begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(37);

select ok(
  (select count(*)::integer from pg_enum e
   join pg_type t on t.oid = e.enumtypid
   join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public' and t.typname = 'editorial_source_role'
     and e.enumlabel = any(array[
       'FACT_PRIMARY', 'FACT_INDEPENDENT', 'DISCOVERY_COMPETITOR',
       'DISCOVERY_COMMUNITY', 'DISCOVERY_VIDEO', 'MATCH_CONTEXT',
       'OWN_PERFORMANCE'
     ])) = 7,
  'all seven editorial source roles exist'
);
select has_column('public', 'information_sources', 'editorial_role', 'information sources store editorial role');

select has_table('app_private', 'source_observations', 'source observations exist');
select has_table('app_private', 'story_claims', 'story claims exist');
select has_table('app_private', 'claim_evidence', 'claim evidence exists');
select has_table('app_private', 'editorial_rankings', 'editorial rankings exist');

select col_is_pk('app_private', 'source_observations', 'id', 'source observations use id primary key');
select col_is_pk('app_private', 'story_claims', 'id', 'story claims use id primary key');
select col_is_pk('app_private', 'claim_evidence', array['claim_id', 'source_observation_id', 'relation'], 'claim evidence uses a stable composite identity');
select col_is_pk('app_private', 'editorial_rankings', 'id', 'editorial rankings use id primary key');

select has_column('app_private', 'source_observations', 'information_source_id', 'observations reference source registry');
select has_column('app_private', 'source_observations', 'editorial_role', 'observations copy editorial role');
select has_column('app_private', 'source_observations', 'external_id', 'observations store stable external identity');
select has_column('app_private', 'source_observations', 'content_fingerprint', 'observations store content fingerprint');
select has_column('app_private', 'story_claims', 'story_cluster_id', 'claims reference story cluster');
select has_column('app_private', 'story_claims', 'grounding_status', 'claims store grounding status');
select has_column('app_private', 'claim_evidence', 'is_grounding', 'claim evidence marks grounding');
select has_column('app_private', 'claim_evidence', 'editorial_role', 'claim evidence copies editorial role');
select has_column('app_private', 'editorial_rankings', 'information_gap_score', 'rankings store information gap score');
select has_column('app_private', 'editorial_rankings', 'news_eligible', 'rankings store news eligibility');
select has_column('app_private', 'editorial_rankings', 'input_snapshot', 'rankings store input snapshot');

select ok((select relrowsecurity from pg_class where oid = to_regclass('app_private.source_observations')), 'source observations enable RLS');
select ok((select relrowsecurity from pg_class where oid = to_regclass('app_private.story_claims')), 'story claims enable RLS');
select ok((select relrowsecurity from pg_class where oid = to_regclass('app_private.claim_evidence')), 'claim evidence enable RLS');
select ok((select relrowsecurity from pg_class where oid = to_regclass('app_private.editorial_rankings')), 'editorial rankings enable RLS');
select ok(has_table_privilege('service_role', 'app_private.source_observations', 'SELECT, INSERT, UPDATE, DELETE'), 'service role owns observations');
select ok(has_table_privilege('service_role', 'app_private.story_claims', 'SELECT, INSERT, UPDATE, DELETE'), 'service role owns claims');
select ok(has_table_privilege('service_role', 'app_private.claim_evidence', 'SELECT, INSERT, UPDATE, DELETE'), 'service role owns evidence');
select ok(has_table_privilege('service_role', 'app_private.editorial_rankings', 'SELECT, INSERT, UPDATE, DELETE'), 'service role owns rankings');
select ok(not has_table_privilege('anon', 'app_private.source_observations', 'SELECT') and not has_table_privilege('authenticated', 'app_private.source_observations', 'SELECT'), 'client roles cannot read observations');

select isnt_empty(
  $$select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'app_private' and r.relname = 'source_observations'
     and c.contype = 'u' and pg_get_constraintdef(c.oid) ilike '%information_source_id%external_id%'$$,
  'observation identity is unique per source and external id'
);
select isnt_empty(
  $$select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'app_private' and r.relname = 'story_claims'
     and c.contype = 'u' and pg_get_constraintdef(c.oid) ilike '%story_cluster_id%claim_fingerprint%grounding_version%'$$,
  'claim identity is unique per cluster fingerprint and version'
);
select isnt_empty(
  $$select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'app_private' and r.relname = 'editorial_rankings'
     and c.contype = 'u' and pg_get_constraintdef(c.oid) ilike '%story_cluster_id%ranking_date%ranking_version%'$$,
  'ranking identity is unique per cluster date and version'
);
select isnt_empty(
  $$select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'app_private' and r.relname = 'claim_evidence'
     and pg_get_constraintdef(c.oid) ilike '%is_grounding%' and pg_get_constraintdef(c.oid) ilike '%FACT_PRIMARY%'$$,
  'only fact roles can be grounding evidence'
);
select ok(
  (select count(*) = 0 from pg_constraint c
   join pg_class r on r.oid = c.conrelid
   join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'app_private' and r.relname in ('source_observations', 'story_claims', 'claim_evidence', 'editorial_rankings')
     and pg_get_constraintdef(c.oid) ilike '%published_posts%')
  and (select count(*) = 0 from pg_constraint c
   join pg_class r on r.oid = c.conrelid
   join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'app_private' and r.relname in ('source_observations', 'story_claims', 'claim_evidence', 'editorial_rankings')
     and pg_get_constraintdef(c.oid) ilike '%performance_metrics%'),
  'grounding and ranking do not depend on own performance tables'
);

select results_eq(
  $$select canonical_name::text, editorial_role::text from public.information_sources order by canonical_name::text$$,
  $$values
    ('BBC Sport', 'FACT_INDEPENDENT'),
    ('Fabrizio Romano', 'FACT_INDEPENDENT'),
    ('Manchester United', 'FACT_PRIMARY'),
    ('Sky Sports', 'FACT_INDEPENDENT'),
    ('The Athletic', 'FACT_INDEPENDENT')$$,
  'seeded fact sources have explicit roles'
);

select ok(
  (select count(*)::integer from information_schema.role_table_grants
   where table_schema = 'app_private' and table_name in ('source_observations', 'story_claims', 'claim_evidence', 'editorial_rankings')
     and grantee in ('anon', 'authenticated')) = 0,
  'client roles have no M8 B/C table grants'
);

select * from finish();
rollback;
