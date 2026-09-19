begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;
select plan(45);

-- A production change that removes an M4 boundary, changes a half-open time
-- predicate, includes the evaluated post in its baseline, or weakens lease
-- ownership must make one of these tests fail.
select has_table('app_private', 'intelligence_run_lock', 'singleton intelligence lease table exists');
select has_table('app_private', 'story_cluster_evaluations', 'AI evaluation audit table exists');
select has_column('public', 'story_clusters', 'signature_json', 'clusters persist aggregate signatures');
select has_column('public', 'content_candidates', 'score_version', 'candidates persist score version');
select has_column('public', 'content_candidates', 'korea_coverage_status', 'candidates persist Korea coverage status');
select has_function('public', 'try_acquire_intelligence_run', array['uuid', 'timestamp with time zone', 'timestamp with time zone'], 'lease acquire RPC exists');
select has_function('public', 'renew_intelligence_run', array['uuid', 'timestamp with time zone'], 'lease renew RPC exists');
select has_function('public', 'release_intelligence_run', array['uuid'], 'lease release RPC exists');
select has_function('public', 'upsert_story_cluster_member', array['uuid', 'uuid', 'text', 'numeric', 'jsonb'], 'membership RPC exists');
select has_function('public', 'reassign_story_cluster_post', array['uuid', 'uuid', 'text'], 'reassignment RPC exists');
select has_function('public', 'calculate_priority_candidates', array['timestamp with time zone', 'date'], 'candidate calculation RPC exists');
select has_function('public', 'get_todays_candidates', array['date'], 'candidate read RPC exists');
select has_function('app_private', 'm4_score_snapshots', array['uuid', 'timestamp with time zone', 'uuid'], 'M3 snapshot selection helper exists');
select has_function('app_private', 'm4_baseline', array['uuid', 'uuid', 'uuid[]', 'timestamp with time zone', 'uuid'], 'baseline helper exists');
select has_function('app_private', 'm4_refresh_lifecycle', array['timestamp with time zone'], 'lifecycle refresh helper exists');

select ok(
  coalesce((
    select 1 from pg_catalog.pg_proc p
    where p.oid = to_regprocedure('public.try_acquire_intelligence_run(uuid,timestamptz,timestamptz)')
      and not p.prosecdef
  )::boolean, false),
  'lease acquire is SECURITY INVOKER'
);
select ok(
  coalesce(has_function_privilege('service_role', to_regprocedure('public.try_acquire_intelligence_run(uuid,timestamptz,timestamptz)'), 'EXECUTE'), false)
  and not coalesce(has_function_privilege('anon', to_regprocedure('public.try_acquire_intelligence_run(uuid,timestamptz,timestamptz)'), 'EXECUTE'), false),
  'lease acquire is service-role-only'
);
select ok(
  coalesce(has_function_privilege('service_role', to_regprocedure('app_private.m4_refresh_lifecycle(timestamptz)'), 'EXECUTE'), false)
  and not coalesce(has_function_privilege('anon', to_regprocedure('app_private.m4_refresh_lifecycle(timestamptz)'), 'EXECUTE'), false)
  and not coalesce(has_function_privilege('authenticated', to_regprocedure('app_private.m4_refresh_lifecycle(timestamptz)'), 'EXECUTE'), false),
  'lifecycle refresh is service-role-only'
);

select skip(26, 'M4 behavior assertions wait for the M4 SQL boundary')
where to_regprocedure('public.try_acquire_intelligence_run(uuid,timestamptz,timestamptz)') is null;

create function pg_temp.m4_behavior_assertions()
returns setof text
language plpgsql
as $m4$
declare
  v_run_at timestamptz := date_trunc('minute', clock_timestamp());
  v_config uuid;
  v_global uuid;
  v_kr uuid;
  v_cluster uuid;
  v_target uuid;
  v_member uuid;
  v_older uuid;
  v_oldest uuid;
  v_future uuid;
  v_seed_cluster uuid;
  v_seed_target uuid;
  v_seed_remaining uuid;
  v_archived_sentinel uuid;
  v_archived_updated_at timestamptz;
  v_lease_a uuid := '11111111-1111-1111-1111-111111111111';
  v_lease_b uuid := '22222222-2222-2222-2222-222222222222';
  v_snapshot jsonb;
  v_baseline record;
  v_candidate_count integer;
begin
  if to_regprocedure('public.try_acquire_intelligence_run(uuid,timestamptz,timestamptz)') is null
     or to_regprocedure('app_private.m4_score_snapshots(uuid,timestamptz,uuid)') is null
     or to_regprocedure('app_private.m4_baseline(uuid,uuid,uuid[],timestamptz,uuid)') is null
  then
    return;
  end if;

  select id into v_config from public.scoring_configs where is_active order by effective_from desc limit 1;
  select id into v_global from public.source_accounts where username = 'utdreport';
  select id into v_kr from public.source_accounts where username = 'mufc_gossip_';
  update public.source_accounts
  set active = true, api_supported = true, priority_weight = 1, last_probe_at = v_run_at, probe_error = null
  where id in (v_global, v_kr);

  insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
  values ('M4 snapshot fixture', v_run_at - interval '1 hour', v_run_at - interval '1 hour') returning id into v_cluster;

  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, collected_at, like_count, comments_count, followers_count_at_collection, raw_payload)
  values (v_global, 'm4-target', 'IMAGE', v_run_at - interval '2 hours', v_run_at - interval '1 hour', 100, 10, 1000, '{}'::jsonb)
  returning id into v_target;
  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, collected_at, like_count, comments_count, followers_count_at_collection, raw_payload)
  values (v_global, 'm4-member', 'IMAGE', v_run_at - interval '2 hours', v_run_at - interval '1 hour', 90, 9, 1000, '{}'::jsonb)
  returning id into v_member;
  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, collected_at, like_count, comments_count, followers_count_at_collection, raw_payload)
  values (v_global, 'm4-older', 'VIDEO', v_run_at - interval '2 hours', v_run_at - interval '1 hour', 20, 2, 1000, '{}'::jsonb)
  returning id into v_older;
  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, collected_at, like_count, comments_count, followers_count_at_collection, raw_payload)
  values (v_global, 'm4-oldest', 'VIDEO', v_run_at - interval '2 hours', v_run_at - interval '1 hour', 10, 1, 1000, '{}'::jsonb)
  returning id into v_oldest;
  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, collected_at, like_count, comments_count, followers_count_at_collection, raw_payload)
  values (v_global, 'm4-future', 'VIDEO', v_run_at - interval '2 hours', v_run_at - interval '1 hour', 999, 99, 1000, '{}'::jsonb)
  returning id into v_future;

  perform public.upsert_story_cluster_member(v_target, v_cluster, 'DETERMINISTIC', 0.95, '{"entities":["bruno_fernandes"],"dictionary_version":"entity-v1"}'::jsonb);
  perform public.upsert_story_cluster_member(v_member, v_cluster, 'DETERMINISTIC', 0.95, '{"entities":["bruno_fernandes"],"dictionary_version":"entity-v1"}'::jsonb);

  insert into public.post_metric_snapshots (raw_post_id, captured_at, capture_bucket_start, followers_count, like_count, comments_count, post_age_minutes)
  values
    (v_target, v_run_at - interval '90 minutes', v_run_at - interval '90 minutes', 1000, 20, 2, 30),
    (v_target, v_run_at - interval '60 minutes', v_run_at - interval '60 minutes', 1000, 40, 4, 60),
    (v_target, v_run_at - interval '29 minutes', v_run_at - interval '30 minutes', 1000, 80, 8, 91),
    (v_target, v_run_at + interval '1 minute', v_run_at, 1000, 999, 99, 121);

  select jsonb_agg(jsonb_build_object('slot', slot, 'captured_at', captured_at) order by slot)
  into v_snapshot
  from app_private.m4_score_snapshots(v_target, v_run_at, v_config);
  return next is(
    v_snapshot,
    jsonb_build_array(
      jsonb_build_object('slot', 's0', 'captured_at', to_jsonb(v_run_at - interval '29 minutes')),
      jsonb_build_object('slot', 's1', 'captured_at', to_jsonb(v_run_at - interval '60 minutes')),
      jsonb_build_object('slot', 's2', 'captured_at', to_jsonb(v_run_at - interval '90 minutes'))
    ),
    'snapshot helper chooses s0/s1/s2 at or before run_at with at least 30-minute gaps'
  );

  insert into public.post_metric_snapshots (raw_post_id, captured_at, capture_bucket_start, followers_count, like_count, comments_count, post_age_minutes)
  values (v_oldest, v_run_at - interval '88 minutes', v_run_at - interval '90 minutes', 1000, 10, 1, 32), (v_oldest, v_run_at - interval '59 minutes', v_run_at - interval '60 minutes', 1000, 20, 2, 61), (v_oldest, v_run_at - interval '30 minutes', v_run_at - interval '30 minutes', 1000, 30, 3, 90);
  return next is((select count(*)::integer from app_private.m4_score_snapshots(v_oldest, v_run_at, v_config)), 0, 'snapshots with sub-30-minute actual gaps do not form a valid M3 series');

  return next is(app_private.m4_age_bucket(v_run_at - interval '1 minute', v_run_at), '0-60'::text, 'age bucket [0,60) includes 59 minutes');
  return next is(app_private.m4_age_bucket(v_run_at - interval '60 minutes', v_run_at), '60-180'::text, 'age bucket [60,180) includes 60 minutes');
  return next is(app_private.m4_age_bucket(v_run_at - interval '180 minutes', v_run_at), '180-360'::text, 'age bucket [180,360) includes 180 minutes');
  return next is(app_private.m4_age_bucket(v_run_at - interval '360 minutes', v_run_at), '360-720'::text, 'age bucket [360,720) includes 360 minutes');
  return next is(app_private.m4_age_bucket(v_run_at - interval '720 minutes', v_run_at), '720-1440'::text, 'age bucket [720,1440) includes 720 minutes');
  return next is(app_private.m4_age_bucket(v_run_at - interval '1440 minutes', v_run_at), null::text, 'age bucket excludes exactly 1440 minutes');
  return next is(app_private.m4_age_bucket(v_run_at + interval '1 minute', v_run_at), null::text, 'age bucket excludes future posts');

  -- The target and its cluster member have extreme ER values; an eligible baseline must not use either.
  for i in 1..5 loop
    insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, collected_at, like_count, comments_count, followers_count_at_collection, raw_payload)
    values (v_global, 'm4-baseline-' || i, 'IMAGE', v_run_at - interval '2 hours', v_run_at - interval '1 hour', 10, 1, 1000, '{}'::jsonb);
  end loop;
  select * into v_baseline from app_private.m4_baseline(v_target, v_cluster, array[v_target, v_member], v_run_at, v_config);
  return next is(v_baseline.sample_count, 5, 'baseline sample count is evaluated after target and cluster members are excluded');
  return next is(v_baseline.fallback_level, 'ACCOUNT_MEDIA_AGE'::text, 'baseline keeps the primary fallback after post and member exclusion');
  return next ok(not (v_baseline.excluded_post_ids ? v_target::text) is false and v_baseline.excluded_post_ids ? v_member::text, 'baseline audit records evaluated and cluster-member exclusions');

  insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
  values ('M4 seed source', v_run_at - interval '2 hours', v_run_at - interval '1 hour') returning id into v_seed_cluster;
  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, collected_at, raw_payload)
  values (v_global, 'm4-seed-target', 'IMAGE', v_run_at - interval '2 hours', v_run_at - interval '1 hour', '{}'::jsonb) returning id into v_seed_target;
  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, collected_at, raw_payload)
  values (v_global, 'm4-seed-remaining', 'IMAGE', v_run_at - interval '2 hours', v_run_at - interval '1 hour', '{}'::jsonb) returning id into v_seed_remaining;
  perform public.upsert_story_cluster_member(v_seed_target, v_seed_cluster, 'AI', 0.91, '{}'::jsonb);
  perform public.upsert_story_cluster_member(v_seed_remaining, v_seed_cluster, 'DETERMINISTIC', 0.95, '{}'::jsonb);
  return next is((select match_method from public.story_cluster_posts where raw_post_id = v_seed_target), 'SEED'::text, 'founding membership is always stored as SEED');
  return next is((select match_confidence from public.story_cluster_posts where raw_post_id = v_seed_target), 1.0::numeric, 'founding SEED confidence is always 1.0');
  perform public.reassign_story_cluster_post(v_seed_target, v_cluster, 'test correction');
  return next is((select match_method from public.story_cluster_posts where raw_post_id = v_seed_remaining), 'SEED'::text, 'reassignment promotes the deterministic earliest remaining member to SEED');
  return next is((select match_confidence from public.story_cluster_posts where raw_post_id = v_seed_remaining), 1.0::numeric, 'promoted SEED confidence is 1.0');

  insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
  values ('M4 exactly recent', v_run_at - interval '24 hours', v_run_at - interval '6 hours'),
         ('M4 exactly stale', v_run_at - interval '8 days', v_run_at - interval '7 days'),
         ('M4 archived', v_run_at - interval '8 days', v_run_at - interval '7 days 1 second'),
         ('M4 old candidate', v_run_at - interval '24 hours 1 second', v_run_at - interval '1 hour');
  insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at, status, updated_at)
  values ('M4 archived sentinel', v_run_at - interval '8 days', v_run_at - interval '7 days 1 second', 'ARCHIVED', '2020-01-01 00:00:00+00')
  returning id, updated_at into v_archived_sentinel, v_archived_updated_at;
  select public.calculate_priority_candidates(v_run_at, v_run_at::date) into v_candidate_count;
  return next is((select status from public.story_clusters where canonical_title = 'M4 exactly recent'), 'OPEN'::public.story_cluster_status, 'exactly six hours is recent, not stale');
  return next is((select status from public.story_clusters where canonical_title = 'M4 exactly stale'), 'STALE'::public.story_cluster_status, 'exactly seven days is stale, not archived');
  return next is((select status from public.story_clusters where canonical_title = 'M4 archived'), 'ARCHIVED'::public.story_cluster_status, 'older than seven days is archived');
  return next is((select count(*)::integer from public.content_candidates cc join public.story_clusters sc on sc.id = cc.story_cluster_id where sc.canonical_title = 'M4 old candidate' and cc.ranking_date = v_run_at::date), 0, 'candidate window excludes a cluster older than exactly 24 hours');
  return next is((select updated_at from public.story_clusters where id = v_archived_sentinel), v_archived_updated_at, 'lifecycle refresh does not rewrite already archived clusters');

  return next ok(public.try_acquire_intelligence_run(v_lease_a, v_run_at, v_run_at + interval '5 minutes'), 'first run acquires an unleased singleton');
  return next ok(not public.try_acquire_intelligence_run(v_lease_b, v_run_at + interval '1 minute', v_run_at + interval '6 minutes'), 'second run cannot acquire a live lease');
  return next ok(not public.renew_intelligence_run(v_lease_b, v_run_at + interval '6 minutes'), 'non-owner cannot renew the lease');
  return next ok(public.renew_intelligence_run(v_lease_a, v_run_at + interval '6 minutes'), 'owner renews the lease');
  return next ok(public.release_intelligence_run(v_lease_a), 'owner releases the lease');
  return next ok(public.try_acquire_intelligence_run(v_lease_b, v_run_at + interval '7 minutes', v_run_at + interval '12 minutes'), 'a later run acquires after release');
end;
$m4$;

select * from pg_temp.m4_behavior_assertions();

select * from finish();
rollback;
