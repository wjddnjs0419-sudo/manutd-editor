begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;
select plan(14);

select has_function('app_private', 'move_story_cluster_member', array['uuid', 'uuid', 'text', 'numeric'], 'evidence-safe membership move helper exists');
select ok(
  coalesce(not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = to_regprocedure('app_private.move_story_cluster_member(uuid,uuid,text,numeric)')), false),
  'membership move helper is SECURITY INVOKER'
);
select ok(
  coalesce(has_function_privilege('service_role', to_regprocedure('app_private.move_story_cluster_member(uuid,uuid,text,numeric)'), 'EXECUTE'), false)
  and not coalesce(has_function_privilege('anon', to_regprocedure('app_private.move_story_cluster_member(uuid,uuid,text,numeric)'), 'EXECUTE'), false)
  and not coalesce(has_function_privilege('authenticated', to_regprocedure('app_private.move_story_cluster_member(uuid,uuid,text,numeric)'), 'EXECUTE'), false),
  'membership move helper is service-role-only'
);

create function pg_temp.member_evidence_reassignment_assertions()
returns setof text
language plpgsql
as $$
declare
  v_account uuid;
  v_old_cluster uuid;
  v_target_cluster uuid;
  v_target_post uuid;
  v_moving_post uuid;
  v_second_post uuid;
  v_overlap_source uuid;
  v_unique_source uuid;
begin
  insert into public.source_accounts (username, region, active, api_supported)
  values ('m8-evidence-regression-fixture', 'GLOBAL', true, true)
  returning id into v_account;

  insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
  values ('Evidence reassignment source', now(), now()) returning id into v_old_cluster;
  insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
  values ('Evidence reassignment destination', now(), now()) returning id into v_target_cluster;

  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, raw_payload)
  values (v_account, 'target-post', 'IMAGE', now(), '{}'::jsonb) returning id into v_target_post;
  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, raw_payload)
  values (v_account, 'moving-post', 'IMAGE', now(), '{}'::jsonb) returning id into v_moving_post;
  insert into public.raw_posts (source_account_id, external_post_id, media_type, published_at, raw_payload)
  values (v_account, 'second-moving-post', 'IMAGE', now(), '{}'::jsonb) returning id into v_second_post;

  perform public.upsert_story_cluster_member(v_target_post, v_target_cluster, 'DETERMINISTIC', 0.95, '{}'::jsonb);
  perform public.upsert_story_cluster_member(v_moving_post, v_old_cluster, 'DETERMINISTIC', 0.95, '{}'::jsonb);
  perform public.upsert_story_cluster_member(v_second_post, v_old_cluster, 'DETERMINISTIC', 0.95, '{}'::jsonb);

  insert into public.information_sources (canonical_name, entity_type, reliability_score, reliability_rationale)
  values ('Evidence overlap source fixture', 'MEDIA_OUTLET', 5, 'Database test fixture') returning id into v_overlap_source;
  insert into public.information_sources (canonical_name, entity_type, reliability_score, reliability_rationale)
  values ('Evidence unique source fixture', 'REPORTER', 5, 'Database test fixture') returning id into v_unique_source;

  insert into public.story_cluster_sources (story_cluster_id, information_source_id, first_cited_post_id, citation_count, extraction_confidence, evidence_text)
  values (v_old_cluster, v_overlap_source, v_moving_post, 2, 0.8, 'old cluster evidence'),
         (v_target_cluster, v_overlap_source, v_target_post, 3, 0.9, 'destination evidence'),
         (v_old_cluster, v_unique_source, v_moving_post, 1, 0.7, 'unique moved evidence');

  return next is(public.reassign_story_cluster_post(v_moving_post, v_target_cluster, 'test correction'), v_target_cluster, 'manual reassignment returns the destination cluster');
  return next is((select story_cluster_id from public.story_cluster_posts where raw_post_id = v_moving_post), v_target_cluster, 'manual reassignment moves the membership');
  return next ok(
    (select citation_count = 5 and first_cited_post_id = v_target_post and extraction_confidence = 0.9 and evidence_text = 'destination evidence'
     from public.story_cluster_sources where story_cluster_id = v_target_cluster and information_source_id = v_overlap_source),
    'duplicate source evidence is merged into the destination source row'
  );
  return next ok(
    (select story_cluster_id = v_target_cluster and first_cited_post_id = v_moving_post and citation_count = 1 and evidence_text = 'unique moved evidence'
     from public.story_cluster_sources where information_source_id = v_unique_source),
    'unique source evidence moves with its first-cited post'
  );
  return next is((select count(*)::integer from public.story_cluster_sources where story_cluster_id = v_old_cluster and first_cited_post_id = v_moving_post), 0, 'old cluster no longer keeps evidence tied to the moved post');

  insert into public.story_cluster_sources (story_cluster_id, information_source_id, first_cited_post_id, citation_count, extraction_confidence, evidence_text)
  values (v_old_cluster, v_unique_source, v_second_post, 1, 0.75, 'upsert path evidence');
  return next is(public.upsert_story_cluster_member(v_second_post, v_target_cluster, 'DETERMINISTIC', 0.95, '{}'::jsonb), v_target_cluster, 'upsert RPC reassigns membership with source evidence attached');
  return next is((select citation_count from public.story_cluster_sources where story_cluster_id = v_target_cluster and information_source_id = v_unique_source), 2, 'upsert RPC merges duplicate evidence counts');
  return next is((select story_cluster_id from public.story_cluster_posts where raw_post_id = v_second_post), v_target_cluster, 'upsert RPC moves the membership to the destination');
  return next is((select count(*)::integer from public.story_cluster_sources where story_cluster_id = v_old_cluster and first_cited_post_id = v_second_post), 0, 'upsert RPC leaves no stale source evidence in the old cluster');
  return next ok((select match_method = 'MANUAL' and match_confidence = 1.0 from public.story_cluster_posts where raw_post_id = v_moving_post), 'manual reassignment preserves its match metadata');
  return next ok((select citation_count = 2 and first_cited_post_id = v_moving_post from public.story_cluster_sources where story_cluster_id = v_target_cluster and information_source_id = v_unique_source), 'merged source evidence retains the original first citation');
end;
$$;

select * from pg_temp.member_evidence_reassignment_assertions();
select * from finish();
rollback;
