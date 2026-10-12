begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;
select plan(17);

select has_column('public', 'creative_briefs', 'exploration_fingerprint', 'creative briefs store an event-level exploration key');
select has_column('public', 'creative_briefs', 'input_tokens', 'creative briefs store input token usage');
select has_column('app_private', 'creative_generation_jobs', 'generation_intent', 'generation jobs distinguish standard and exploration intent');
select has_column('app_private', 'creative_generation_jobs', 'reserved_at', 'generation jobs retain the quota reservation time');
select has_index('public', 'creative_briefs', 'creative_briefs_exploration_fingerprint_idx', 'briefs have a unique event-level exploration key');
select has_index('app_private', 'creative_generation_jobs', 'creative_generation_jobs_exploration_fingerprint_idx', 'exploration reservations are globally unique');
select has_function('public', 'reserve_editorial_exploration_generation', ARRAY['uuid', 'text', 'text', 'timestamp with time zone', 'integer'], 'atomic daily exploration reservation RPC exists');
select ok(
  has_function_privilege('service_role', 'public.reserve_editorial_exploration_generation(uuid, text, text, timestamp with time zone, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.reserve_editorial_exploration_generation(uuid, text, text, timestamp with time zone, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.reserve_editorial_exploration_generation(uuid, text, text, timestamp with time zone, integer)', 'EXECUTE'),
  'only service_role can reserve an exploration slot'
);

insert into public.story_clusters (id, canonical_title, first_seen_at, last_seen_at, status)
values ('10000000-0000-4000-8000-000000000001', 'Exploration reservation fixture', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z', 'ACTIVE');
insert into public.scoring_configs (id, version, config, is_active)
values ('20000000-0000-4000-8000-000000000001', 'exploration-reservation-test', '{"comment_multiplier": 1, "component_weights": {}}', false);
insert into public.content_candidates (
  id, story_cluster_id, scoring_config_id,
  global_spread_score, engagement_outperformance_score, engagement_velocity_score,
  velocity_acceleration_score, korea_gap_score, first_mover_score,
  korean_saturation_score, reliability_score, source_diversity_score,
  freshness_score, data_confidence, ranking_date
) values (
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, '2026-10-12'
);

select is(
  (select status from public.reserve_editorial_exploration_generation(
    '30000000-0000-4000-8000-000000000001', 'event-a', 'MANUAL', '2026-10-11T15:00:00Z', 2
  )),
  'RESERVED'::text,
  'first story reservation is accepted at Seoul midnight'
);
select is(
  (select status from public.reserve_editorial_exploration_generation(
    '30000000-0000-4000-8000-000000000001', 'event-a', 'MANUAL', '2026-10-12T14:59:00Z', 2
  )),
  'EXISTING'::text,
  'duplicate event returns the existing reservation within the same Seoul day'
);
select is(
  (select job_id from public.reserve_editorial_exploration_generation(
    '30000000-0000-4000-8000-000000000001', 'event-a', 'MANUAL', '2026-10-12T14:59:00Z', 2
  )),
  (select id from app_private.creative_generation_jobs where exploration_fingerprint = 'event-a'),
  'duplicate event reuses its original job ID'
);
select is(
  (select status from public.reserve_editorial_exploration_generation(
    '30000000-0000-4000-8000-000000000001', 'event-b', 'AUTO_PRIORITY', '2026-10-12T14:59:00Z', 2
  )),
  'RESERVED'::text,
  'second distinct event fits the daily quota'
);
select is(
  (select status from public.reserve_editorial_exploration_generation(
    '30000000-0000-4000-8000-000000000001', 'event-c', 'AUTO_PRIORITY', '2026-10-12T14:59:00Z', 2
  )),
  'DAILY_LIMIT'::text,
  'the quota spans the Seoul business day and blocks a third distinct event'
);

update app_private.creative_generation_jobs
   set status = 'GENERATING', lease_expires_at = '2026-10-12T14:00:00Z'
 where exploration_fingerprint = 'event-a';
select is(
  (select status from public.reserve_editorial_exploration_generation(
    '30000000-0000-4000-8000-000000000001', 'event-a', 'MANUAL', '2026-10-12T14:59:00Z', 2
  )),
  'RESERVED'::text,
  'expired generation lease reuses the existing event job'
);
update app_private.creative_generation_jobs
   set status = 'FAILED_PROVIDER'
 where exploration_fingerprint = 'event-a';
select is(
  (select status from public.reserve_editorial_exploration_generation(
    '30000000-0000-4000-8000-000000000001', 'event-a', 'MANUAL', '2026-10-12T14:59:00Z', 2
  )),
  'RESERVED'::text,
  'failed event reservation can be recovered'
);
select is(
  (select count(*)::integer from app_private.creative_generation_jobs where exploration_fingerprint = 'event-a'),
  1,
  'retry recovery reuses the unique event job'
);
select throws_ok(
  $$select * from public.reserve_editorial_exploration_generation(
    '30000000-0000-4000-8000-000000000001', 'event-null-trigger', null, '2026-10-12T14:59:00Z', 2
  )$$,
  '22023'
);

select * from finish();
rollback;
