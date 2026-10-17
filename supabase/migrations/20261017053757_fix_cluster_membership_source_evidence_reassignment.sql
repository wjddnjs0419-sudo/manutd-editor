create or replace function app_private.move_story_cluster_member(
  p_raw_post_id uuid,
  p_target_cluster_id uuid,
  p_match_method text,
  p_match_confidence numeric
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old_cluster_id uuid;
  v_source record;
  v_move_source_ids uuid[] := '{}'::uuid[];
  v_source_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_raw_post_id::text, 0));

  select story_cluster_id
  into v_old_cluster_id
  from public.story_cluster_posts
  where raw_post_id = p_raw_post_id
  for update;

  if v_old_cluster_id is null then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;

  perform 1 from public.story_clusters where id = p_target_cluster_id for update;
  if not found then
    raise exception 'target cluster not found' using errcode = 'P0002';
  end if;

  if v_old_cluster_id = p_target_cluster_id then
    update public.story_cluster_posts
    set match_method = p_match_method,
        match_confidence = p_match_confidence
    where raw_post_id = p_raw_post_id;
    return p_target_cluster_id;
  end if;

  for v_source in
    select information_source_id, citation_count, extraction_confidence, evidence_text
    from public.story_cluster_sources
    where story_cluster_id = v_old_cluster_id
      and first_cited_post_id = p_raw_post_id
    for update
  loop
    perform 1
    from public.story_cluster_sources
    where story_cluster_id = p_target_cluster_id
      and information_source_id = v_source.information_source_id
    for update;

    if found then
      update public.story_cluster_sources
      set citation_count = citation_count + v_source.citation_count,
          extraction_confidence = greatest(extraction_confidence, v_source.extraction_confidence),
          evidence_text = coalesce(evidence_text, v_source.evidence_text)
      where story_cluster_id = p_target_cluster_id
        and information_source_id = v_source.information_source_id;

      delete from public.story_cluster_sources
      where story_cluster_id = v_old_cluster_id
        and information_source_id = v_source.information_source_id;
    else
      -- Detach the immediate RESTRICT FK before changing the referenced membership key.
      update public.story_cluster_sources
      set first_cited_post_id = null
      where story_cluster_id = v_old_cluster_id
        and information_source_id = v_source.information_source_id;
      v_move_source_ids := pg_catalog.array_append(v_move_source_ids, v_source.information_source_id);
    end if;
  end loop;

  update public.story_cluster_posts
  set story_cluster_id = p_target_cluster_id,
      match_method = p_match_method,
      match_confidence = p_match_confidence
  where raw_post_id = p_raw_post_id;

  foreach v_source_id in array v_move_source_ids loop
    update public.story_cluster_sources
    set story_cluster_id = p_target_cluster_id,
        first_cited_post_id = p_raw_post_id
    where story_cluster_id = v_old_cluster_id
      and information_source_id = v_source_id
      and first_cited_post_id is null;
  end loop;

  return p_target_cluster_id;
end;
$$;

revoke all on function app_private.move_story_cluster_member(uuid, uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function app_private.move_story_cluster_member(uuid, uuid, text, numeric)
  to service_role;

create or replace function public.upsert_story_cluster_member(
  p_raw_post_id uuid,
  p_cluster_id uuid,
  p_match_method text,
  p_match_confidence numeric,
  p_signature jsonb
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_id uuid;
  v_current_cluster_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_raw_post_id::text, 0));
  perform 1 from public.story_clusters where id = p_cluster_id for update;
  if not found then
    raise exception 'target cluster not found' using errcode = 'P0002';
  end if;

  select story_cluster_id
  into v_current_cluster_id
  from public.story_cluster_posts
  where raw_post_id = p_raw_post_id
  for update;

  select count(*) into v_count
  from public.story_cluster_posts
  where story_cluster_id = p_cluster_id;

  if v_current_cluster_id is null then
    insert into public.story_cluster_posts (story_cluster_id, raw_post_id, match_method, match_confidence)
    values (
      p_cluster_id,
      p_raw_post_id,
      case when v_count = 0 then 'SEED' else p_match_method end,
      case when v_count = 0 then 1.0 else p_match_confidence end
    ) returning story_cluster_id into v_id;
  else
    v_id := app_private.move_story_cluster_member(
      p_raw_post_id,
      p_cluster_id,
      case when v_count = 0 then 'SEED' else p_match_method end,
      case when v_count = 0 then 1.0 else p_match_confidence end
    );
  end if;

  update public.story_clusters
  set signature_json = coalesce(p_signature, '{}'::jsonb),
      signature_version = coalesce(p_signature->>'dictionary_version', signature_version),
      first_seen_at = least(first_seen_at, (select published_at from public.raw_posts where id = p_raw_post_id)),
      last_seen_at = greatest(last_seen_at, (select published_at from public.raw_posts where id = p_raw_post_id))
  where id = p_cluster_id;

  return v_id;
end;
$$;

create or replace function public.reassign_story_cluster_post(
  p_raw_post_id uuid,
  p_target_cluster_id uuid,
  p_reason text
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old_cluster_id uuid;
  v_promote uuid;
begin
  perform p_reason;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_raw_post_id::text, 0));

  select story_cluster_id
  into v_old_cluster_id
  from public.story_cluster_posts
  where raw_post_id = p_raw_post_id
  for update;

  if v_old_cluster_id is null then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;

  perform app_private.move_story_cluster_member(p_raw_post_id, p_target_cluster_id, 'MANUAL', 1.0);

  select raw_post_id
  into v_promote
  from public.story_cluster_posts
  where story_cluster_id = v_old_cluster_id
  order by created_at, raw_post_id
  limit 1;

  if v_promote is not null then
    update public.story_cluster_posts
    set match_method = 'SEED', match_confidence = 1.0
    where raw_post_id = v_promote;
  end if;

  return p_target_cluster_id;
end;
$$;
