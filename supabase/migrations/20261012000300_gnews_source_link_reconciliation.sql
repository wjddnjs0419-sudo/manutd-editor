-- Reconcile legacy Google News discovery rows to existing source observations.
-- This migration adds an audited, bounded operator workflow. It does not run it.

create table app_private.gnews_source_link_reconciliation_quarantine (
  id uuid primary key default gen_random_uuid(),
  discovery_observation_id uuid not null,
  candidate_source_observation_id uuid,
  decision text not null,
  mismatch_fields text[] not null default '{}',
  discovery_audit jsonb not null default '{}'::jsonb,
  candidate_audit jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint gnews_source_link_reconciliation_decision_check check (
    decision in (
      'NO_MATCH', 'QUARANTINE_KEY_MISMATCH', 'QUARANTINE_AMBIGUOUS',
      'QUARANTINE_METADATA_MISMATCH', 'QUARANTINE_PLAN_CHANGED',
      'QUARANTINE_APPLY_REQUIRES_REVIEWED_SOURCE_ID',
      'QUARANTINE_ALREADY_LINKED_DIFFERENT_SOURCE'
    )
  ),
  constraint gnews_source_link_reconciliation_discovery_audit_object check (jsonb_typeof(discovery_audit) = 'object'),
  constraint gnews_source_link_reconciliation_candidate_audit_object check (jsonb_typeof(candidate_audit) = 'object')
);

create unique index gnews_source_link_reconciliation_candidate_key
  on app_private.gnews_source_link_reconciliation_quarantine (discovery_observation_id, candidate_source_observation_id)
  where candidate_source_observation_id is not null;
create unique index gnews_source_link_reconciliation_no_candidate_key
  on app_private.gnews_source_link_reconciliation_quarantine (discovery_observation_id)
  where candidate_source_observation_id is null;

alter table app_private.gnews_source_link_reconciliation_quarantine enable row level security;
revoke all on table app_private.gnews_source_link_reconciliation_quarantine from public, anon, authenticated, service_role;

create or replace function app_private.gnews_source_link_reconciliation_plan(
  p_discovery_observation_ids uuid[] default null
)
returns table (
  discovery_observation_id uuid,
  story_cluster_id uuid,
  current_source_observation_id uuid,
  candidate_count integer,
  candidate_source_observation_ids uuid[],
  decision text,
  mismatch_fields text[],
  discovery_audit jsonb,
  candidate_audit jsonb
)
language sql
stable
set search_path = ''
as $function$
  with targets as (
    select
      observation.id,
      observation.story_cluster_id,
      observation.source_observation_id,
      observation.external_id,
      observation.canonical_url,
      observation.source_canonical_name,
      observation.title,
      observation.published_at,
      observation.content_fingerprint,
      observation.editorial_role,
      coalesce(observation.google_news_original_url, observation.metadata->>'google_news_url', observation.canonical_url) as google_news_original_url,
      coalesce(observation.article_final_url, observation.resolved_publisher_url) as resolved_publisher_url
    from app_private.discovery_observations as observation
    where observation.provider_id = 'google-news'
      and observation.story_cluster_id is not null
      and observation.source_observation_id is null
      and (p_discovery_observation_ids is null or observation.id = any(p_discovery_observation_ids))
  ), external_id_candidates as (
    select
      target.id,
      target.story_cluster_id,
      target.source_observation_id,
      target.external_id,
      target.canonical_url,
      target.title,
      target.published_at,
      target.content_fingerprint,
      target.editorial_role,
      target.google_news_original_url,
      target.resolved_publisher_url,
      target.source_canonical_name as discovery_source_canonical_name,
      source.id as candidate_id,
      source.canonical_url as source_canonical_url,
      source.external_id as source_external_id,
      source.title as source_title,
      source.published_at as source_published_at,
      source.content_fingerprint as source_content_fingerprint,
      source.editorial_role as source_editorial_role,
      source.information_source_id,
      information_source.canonical_name::text as source_canonical_name,
      source.metadata as source_metadata,
      source.canonical_url = target.canonical_url as canonical_url_exact,
      source.metadata->>'google_news_original_url' = target.google_news_original_url as google_original_url_exact,
      target.resolved_publisher_url is not null
        and source.canonical_url = target.resolved_publisher_url
        and source.metadata->>'google_news_original_url' = target.google_news_original_url as resolved_publisher_url_exact
    from targets as target
    join app_private.source_observations as source
      on source.external_id = target.external_id
        or source.canonical_url = target.canonical_url
        or source.metadata->>'google_news_original_url' = target.google_news_original_url
        or (target.resolved_publisher_url is not null
          and source.canonical_url = target.resolved_publisher_url
          and source.metadata->>'google_news_original_url' = target.google_news_original_url)
    join public.information_sources as information_source
      on information_source.id = source.information_source_id
  ), annotated_candidates as (
    select
      candidate.*,
      (candidate.canonical_url_exact or candidate.google_original_url_exact or candidate.resolved_publisher_url_exact) as url_identity_match,
      (candidate.source_external_id = candidate.external_id
        and (candidate.canonical_url_exact or candidate.google_original_url_exact or candidate.resolved_publisher_url_exact)) as full_identity_match,
      case
        when candidate.source_external_id = candidate.external_id and candidate.canonical_url_exact then 'CANONICAL_URL_EXACT'
        when candidate.source_external_id = candidate.external_id and candidate.resolved_publisher_url_exact then 'RESOLVED_PUBLISHER_URL'
        when candidate.source_external_id = candidate.external_id and candidate.google_original_url_exact then 'GOOGLE_ORIGINAL_URL_PROVENANCE'
        when candidate.canonical_url_exact then 'URL_ONLY'
        when candidate.resolved_publisher_url_exact then 'PUBLISHER_URL_ONLY'
        when candidate.google_original_url_exact then 'GOOGLE_PROVENANCE_ONLY'
        else 'EXTERNAL_ID_ONLY'
      end as match_basis,
      (
        candidate.google_original_url_exact
        and app_private.is_safe_gnews_publisher_url(candidate.source_canonical_url)
        and candidate.source_metadata->>'resolved_publisher_url' = candidate.source_canonical_url
      ) as restored_publisher_url_provenance,
      array_remove(array[
        case when candidate.source_external_id is distinct from candidate.external_id then 'external_id' end,
        case when candidate.canonical_url_exact
          or (candidate.google_original_url_exact
            and app_private.is_safe_gnews_publisher_url(candidate.source_canonical_url)
            and candidate.source_metadata->>'resolved_publisher_url' = candidate.source_canonical_url)
          or candidate.resolved_publisher_url_exact then null else 'canonical_url' end,
        case when candidate.source_canonical_name is distinct from candidate.discovery_source_canonical_name then 'source_canonical_name' end,
        case when candidate.source_title is distinct from candidate.title then 'title' end,
        case when candidate.source_published_at is distinct from candidate.published_at then 'published_at' end,
        case when candidate.source_content_fingerprint is distinct from candidate.content_fingerprint then 'content_fingerprint' end,
        case when candidate.source_editorial_role is distinct from candidate.editorial_role then 'editorial_role' end
      ], null) as mismatch_fields
    from external_id_candidates as candidate
  ), candidates as (
    -- Prefer rows whose external ID and URL/provenance identify the same article.
    -- If none exist, retain URL-only or external-ID-only rows as key-mismatch candidates.
    select annotated.*
    from annotated_candidates as annotated
    where annotated.full_identity_match is true
    union all
    select annotated.*
    from annotated_candidates as annotated
    where not exists (
        select 1 from annotated_candidates as matched
        where matched.id = annotated.id and matched.full_identity_match is true
      )
  ), candidate_groups as (
    select
      target.id,
      count(candidate.candidate_id)::integer as candidate_count,
      coalesce(array_agg(candidate.candidate_id order by candidate.candidate_id)
        filter (where candidate.candidate_id is not null), '{}'::uuid[]) as candidate_ids,
      coalesce(jsonb_agg(jsonb_build_object(
        'source_observation_id', candidate.candidate_id,
        'information_source_id', candidate.information_source_id,
        'external_id', candidate.source_external_id,
        'canonical_url', candidate.source_canonical_url,
        'source_canonical_name', candidate.source_canonical_name,
        'discovery_source_canonical_name', candidate.discovery_source_canonical_name,
        'title', candidate.source_title,
        'published_at', candidate.source_published_at,
        'content_fingerprint', candidate.source_content_fingerprint,
        'editorial_role', candidate.source_editorial_role,
        'match_basis', candidate.match_basis,
        'url_identity_match', candidate.url_identity_match,
        'full_identity_match', candidate.full_identity_match,
        'restored_publisher_url_provenance', candidate.restored_publisher_url_provenance,
        'canonical_url_exact', candidate.canonical_url_exact,
        'google_original_url_exact', candidate.google_original_url_exact,
        'resolved_publisher_url_exact', candidate.resolved_publisher_url_exact,
        'exact_source_name', candidate.source_canonical_name = candidate.discovery_source_canonical_name,
        'exact_title', candidate.source_title = candidate.title,
        'exact_published_at', candidate.source_published_at is not distinct from candidate.published_at,
        'exact_fingerprint', candidate.source_content_fingerprint = candidate.content_fingerprint,
        'exact_editorial_role', candidate.source_editorial_role = candidate.editorial_role,
        'mismatch_fields', to_jsonb(candidate.mismatch_fields),
        'metadata', candidate.source_metadata
      ) order by candidate.candidate_id) filter (where candidate.candidate_id is not null), '[]'::jsonb) as candidate_audit,
      coalesce(bool_or(candidate.full_identity_match is true), false) as has_full_identity_match,
      coalesce(bool_or(cardinality(candidate.mismatch_fields) > 0), false) as has_metadata_mismatch,
      coalesce(bool_or(candidate.full_identity_match is true and cardinality(candidate.mismatch_fields) = 0), false) as has_safe_metadata_match,
      (select candidate_row.mismatch_fields from candidates as candidate_row
        where candidate_row.id = target.id order by candidate_row.candidate_id limit 1) as representative_mismatch_fields
    from targets as target
    left join candidates as candidate on candidate.id = target.id
    group by target.id
  )
  select
    target.id as discovery_observation_id,
    target.story_cluster_id,
    target.source_observation_id as current_source_observation_id,
    candidate_group.candidate_count,
    candidate_group.candidate_ids as candidate_source_observation_ids,
    case
      when candidate_group.candidate_count = 0 then 'NO_MATCH'
      when not candidate_group.has_full_identity_match and candidate_group.candidate_count = 1 then 'QUARANTINE_KEY_MISMATCH'
      when not candidate_group.has_full_identity_match and candidate_group.candidate_count > 1 then 'QUARANTINE_AMBIGUOUS'
      when candidate_group.has_full_identity_match and candidate_group.candidate_count > 1 then 'QUARANTINE_AMBIGUOUS'
      when candidate_group.has_metadata_mismatch then 'QUARANTINE_METADATA_MISMATCH'
      when candidate_group.has_safe_metadata_match then 'SAFE_TO_LINK'
      else 'QUARANTINE_METADATA_MISMATCH'
    end as decision,
    case
      when candidate_group.candidate_count = 0 then '{}'::text[]
      when not candidate_group.has_full_identity_match then array['external_id', 'canonical_url']::text[]
      when candidate_group.candidate_count > 1 then array['ambiguous_candidates']::text[]
      else coalesce(candidate_group.representative_mismatch_fields, '{}'::text[])
    end as mismatch_fields,
    jsonb_build_object(
      'discovery_observation_id', target.id,
      'story_cluster_id', target.story_cluster_id,
      'current_source_observation_id', target.source_observation_id,
      'external_id', target.external_id,
      'canonical_url', target.canonical_url,
      'google_news_original_url', target.google_news_original_url,
      'resolved_publisher_url', target.resolved_publisher_url,
      'source_canonical_name', target.source_canonical_name,
      'title', target.title,
      'published_at', target.published_at,
      'content_fingerprint', target.content_fingerprint,
      'editorial_role', target.editorial_role
    ) as discovery_audit,
    candidate_group.candidate_audit
  from targets as target
  join candidate_groups as candidate_group on candidate_group.id = target.id
  order by target.id;
$function$;

create or replace function app_private._record_gnews_source_link_quarantine(
  p_discovery_observation_id uuid,
  p_decision text,
  p_mismatch_fields text[],
  p_discovery_audit jsonb,
  p_candidates jsonb
)
returns integer
language plpgsql
set search_path = ''
as $function$
declare
  candidate jsonb;
  candidate_id uuid;
  rows_written integer := 0;
begin
  if jsonb_typeof(p_candidates) = 'array' and jsonb_array_length(p_candidates) > 0 then
    for candidate in select value from jsonb_array_elements(p_candidates)
    loop
      candidate_id := nullif(candidate->>'source_observation_id', '')::uuid;
      if candidate_id is null then
        insert into app_private.gnews_source_link_reconciliation_quarantine as quarantine (
          discovery_observation_id, candidate_source_observation_id, decision,
          mismatch_fields, discovery_audit, candidate_audit, last_seen_at
        ) values (
          p_discovery_observation_id, null, p_decision, coalesce(p_mismatch_fields, '{}'),
          coalesce(p_discovery_audit, '{}'::jsonb), candidate, now()
        )
        on conflict (discovery_observation_id) where candidate_source_observation_id is null
        do update set decision = excluded.decision, mismatch_fields = excluded.mismatch_fields,
          discovery_audit = excluded.discovery_audit, candidate_audit = excluded.candidate_audit,
          last_seen_at = now();
      else
        insert into app_private.gnews_source_link_reconciliation_quarantine as quarantine (
          discovery_observation_id, candidate_source_observation_id, decision,
          mismatch_fields, discovery_audit, candidate_audit, last_seen_at
        ) values (
          p_discovery_observation_id, candidate_id, p_decision, coalesce(p_mismatch_fields, '{}'),
          coalesce(p_discovery_audit, '{}'::jsonb), candidate, now()
        )
        on conflict (discovery_observation_id, candidate_source_observation_id)
          where candidate_source_observation_id is not null
        do update set decision = excluded.decision, mismatch_fields = excluded.mismatch_fields,
          discovery_audit = excluded.discovery_audit, candidate_audit = excluded.candidate_audit,
          last_seen_at = now();
      end if;
      rows_written := rows_written + 1;
    end loop;
  else
    insert into app_private.gnews_source_link_reconciliation_quarantine as quarantine (
      discovery_observation_id, candidate_source_observation_id, decision,
      mismatch_fields, discovery_audit, candidate_audit, last_seen_at
    ) values (
      p_discovery_observation_id, null, p_decision, coalesce(p_mismatch_fields, '{}'),
      coalesce(p_discovery_audit, '{}'::jsonb), '{}'::jsonb, now()
    )
    on conflict (discovery_observation_id) where candidate_source_observation_id is null
    do update set decision = excluded.decision, mismatch_fields = excluded.mismatch_fields,
      discovery_audit = excluded.discovery_audit, candidate_audit = excluded.candidate_audit,
      last_seen_at = now();
    rows_written := 1;
  end if;
  return rows_written;
end
$function$;

create or replace function app_private.gnews_source_link_reconciliation_apply(
  p_discovery_observation_ids uuid[],
  p_expected_source_observation_ids uuid[]
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  item record;
  source_id uuid;
  row_count integer;
  found_count integer;
  current_story_id uuid;
  current_source_id uuid;
  plan_row record;
  status text;
  mismatch_fields text[];
  results jsonb := '[]'::jsonb;
begin
  if current_setting('transaction_isolation') <> 'serializable' then
    raise exception 'gnews reconciliation requires SERIALIZABLE isolation' using errcode = '25001';
  end if;
  if p_discovery_observation_ids is null or p_expected_source_observation_ids is null
    or cardinality(p_discovery_observation_ids) not between 1 and 30
    or cardinality(p_expected_source_observation_ids) <> cardinality(p_discovery_observation_ids)
    or (select count(distinct id) from unnest(p_discovery_observation_ids) as ids(id)) <> cardinality(p_discovery_observation_ids) then
    raise exception 'invalid gnews reconciliation batch' using errcode = '22023';
  end if;

  select count(*)::integer into found_count
  from app_private.discovery_observations as observation
  where observation.id = any(p_discovery_observation_ids);
  if found_count <> cardinality(p_discovery_observation_ids) then
    raise exception 'gnews reconciliation observation not found' using errcode = 'P0002';
  end if;

  -- All callers lock discovery rows first, then candidate sources in UUID order.
  perform observation.id
  from app_private.discovery_observations as observation
  where observation.id = any(p_discovery_observation_ids)
  order by observation.id
  for update;

  for source_id in
    select distinct candidate_id
    from app_private.gnews_source_link_reconciliation_plan(p_discovery_observation_ids) as plan
    cross join lateral unnest(plan.candidate_source_observation_ids) as ids(candidate_id)
    order by candidate_id
  loop
    perform source.id from app_private.source_observations as source where source.id = source_id for share;
  end loop;

  for item in
    select input.discovery_id, input.expected_source_id
    from unnest(p_discovery_observation_ids, p_expected_source_observation_ids) as input(discovery_id, expected_source_id)
    order by input.discovery_id
  loop
    select observation.story_cluster_id, observation.source_observation_id
      into current_story_id, current_source_id
    from app_private.discovery_observations as observation
    where observation.id = item.discovery_id
      and observation.provider_id = 'google-news'
      and observation.story_cluster_id is not null
    for update;

    if not found then
      results := results || jsonb_build_array(jsonb_build_object(
        'discovery_observation_id', item.discovery_id, 'status', 'NOT_ELIGIBLE'
      ));
      continue;
    end if;

    if current_source_id is not null then
      if current_source_id = item.expected_source_id then
        results := results || jsonb_build_array(jsonb_build_object(
          'discovery_observation_id', item.discovery_id, 'source_observation_id', current_source_id,
          'status', 'ALREADY_LINKED'
        ));
      else
        perform app_private._record_gnews_source_link_quarantine(
          item.discovery_id, 'QUARANTINE_ALREADY_LINKED_DIFFERENT_SOURCE',
          array['source_observation_id'],
          jsonb_build_object('discovery_observation_id', item.discovery_id,
            'story_cluster_id', current_story_id, 'current_source_observation_id', current_source_id,
            'expected_source_observation_id', item.expected_source_id), '[]'::jsonb
        );
        results := results || jsonb_build_array(jsonb_build_object(
          'discovery_observation_id', item.discovery_id, 'current_source_observation_id', current_source_id,
          'status', 'QUARANTINE_ALREADY_LINKED_DIFFERENT_SOURCE'
        ));
      end if;
      continue;
    end if;

    select * into plan_row
    from app_private.gnews_source_link_reconciliation_plan(array[item.discovery_id]::uuid[]);

    if not found then
      results := results || jsonb_build_array(jsonb_build_object(
        'discovery_observation_id', item.discovery_id, 'status', 'NOT_ELIGIBLE'
      ));
      continue;
    end if;

    if plan_row.decision = 'SAFE_TO_LINK'
      and item.expected_source_id is not null
      and plan_row.candidate_source_observation_ids[1] = item.expected_source_id then
      update app_private.discovery_observations as observation
      set source_observation_id = item.expected_source_id
      where observation.id = item.discovery_id
        and observation.provider_id = 'google-news'
        and observation.story_cluster_id = current_story_id
        and observation.source_observation_id is null;
      get diagnostics row_count = row_count;
      if row_count = 1 then
        results := results || jsonb_build_array(jsonb_build_object(
          'discovery_observation_id', item.discovery_id,
          'story_cluster_id', current_story_id,
          'source_observation_id', item.expected_source_id,
          'status', 'LINKED'
        ));
        continue;
      end if;
      status := 'QUARANTINE_PLAN_CHANGED';
      mismatch_fields := array['source_observation_id'];
    elsif plan_row.decision = 'SAFE_TO_LINK' and item.expected_source_id is null then
      status := 'QUARANTINE_APPLY_REQUIRES_REVIEWED_SOURCE_ID';
      mismatch_fields := array['expected_source_observation_id'];
    elsif plan_row.decision = 'SAFE_TO_LINK' then
      status := 'QUARANTINE_PLAN_CHANGED';
      mismatch_fields := array['candidate_source_observation_id'];
    else
      status := plan_row.decision;
      mismatch_fields := plan_row.mismatch_fields;
    end if;

    perform app_private._record_gnews_source_link_quarantine(
      item.discovery_id, status, mismatch_fields,
      plan_row.discovery_audit, plan_row.candidate_audit
    );
    results := results || jsonb_build_array(jsonb_build_object(
      'discovery_observation_id', item.discovery_id, 'status', status,
      'candidate_count', plan_row.candidate_count,
      'candidate_source_observation_ids', to_jsonb(plan_row.candidate_source_observation_ids),
      'mismatch_fields', to_jsonb(mismatch_fields)
    ));
  end loop;

  return jsonb_build_object('mode', 'APPLY', 'batch_size', cardinality(p_discovery_observation_ids), 'results', results);
end
$function$;

revoke all on function app_private.gnews_source_link_reconciliation_plan(uuid[]) from public, anon, authenticated, service_role;
revoke all on function app_private._record_gnews_source_link_quarantine(uuid, text, text[], jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function app_private.gnews_source_link_reconciliation_apply(uuid[], uuid[]) from public, anon, authenticated, service_role;
