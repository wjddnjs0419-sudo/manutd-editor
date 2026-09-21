begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(8);
select has_table('app_private', 'intelligence_readiness', 'intelligence readiness exists');
select has_column('app_private', 'intelligence_readiness', 'ranking_date', 'readiness stores business date');
select has_column('app_private', 'intelligence_readiness', 'status', 'readiness stores status');
select has_column('app_private', 'intelligence_readiness', 'candidate_count', 'readiness stores candidate count');
select ok(coalesce((select relrowsecurity from pg_class where oid=to_regclass('app_private.intelligence_readiness')), false), 'readiness RLS');
select isnt_empty($$select 1 from pg_indexes where schemaname='app_private' and indexname='intelligence_readiness_status_idx'$$, 'readiness status index');
select throws_ok(
  $$insert into app_private.intelligence_readiness(ranking_date,status,candidate_count,started_at) values ('2026-09-21','READY',0,now())$$,
  '23514',
  null,
  'readiness rejects unknown status'
);
select throws_ok(
  $$insert into app_private.intelligence_readiness(ranking_date,status,candidate_count,started_at) values ('2026-09-21','SUCCEEDED',-1,now())$$,
  '23514',
  null,
  'readiness rejects negative candidate counts'
);

select * from finish();
rollback;
