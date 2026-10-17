-- Read-only post-apply verification template. Replace the example UUID values
-- with pairs copied from a reviewed dry-run and the operator's captured before
-- state. Never paste production IDs into repository files or run an apply here.
begin read only;

with reviewed(discovery_observation_id, pre_apply_source_observation_id, expected_source_observation_id, expected_story_cluster_id) as (
  values
    ('00000000-0000-4000-8000-000000000001'::uuid,
     null::uuid,
     '00000000-0000-4000-8000-000000000002'::uuid,
     '00000000-0000-4000-8000-000000000003'::uuid)
), current_rows as (
  select
    reviewed.discovery_observation_id,
    reviewed.pre_apply_source_observation_id,
    reviewed.expected_source_observation_id,
    reviewed.expected_story_cluster_id,
    discovery.provider_id,
    discovery.external_id as discovery_external_id,
    discovery.canonical_url as discovery_canonical_url,
    discovery.story_cluster_id as actual_story_cluster_id,
    discovery.source_observation_id as actual_source_observation_id,
    source.external_id as source_external_id,
    source.canonical_url as source_canonical_url,
    source.title as source_title,
    source.content_fingerprint as source_content_fingerprint,
    source.metadata as source_metadata,
    information_source.canonical_name::text as source_canonical_name,
    story.status as story_status,
    (select count(*) from app_private.story_claims claim
      where claim.story_cluster_id = discovery.story_cluster_id) as story_claim_count,
    (select count(*) from app_private.claim_evidence evidence
      where evidence.source_observation_id = source.id) as source_evidence_count
  from reviewed
  left join app_private.discovery_observations discovery
    on discovery.id = reviewed.discovery_observation_id
  left join app_private.source_observations source
    on source.id = discovery.source_observation_id
  left join public.information_sources information_source
    on information_source.id = source.information_source_id
  left join public.story_clusters story
    on story.id = discovery.story_cluster_id
)
select *,
  provider_id = 'google-news' as is_google_news,
  actual_source_observation_id = expected_source_observation_id as expected_source_link_present,
  actual_source_observation_id is distinct from pre_apply_source_observation_id as source_link_changed_from_captured_before,
  actual_story_cluster_id = expected_story_cluster_id as original_story_link_preserved,
  discovery_external_id = source_external_id as external_id_preserved,
  (source_metadata->>'google_news_original_url') is not null as google_news_provenance_present
from current_rows
order by discovery_observation_id;

-- Compare reviewed before-state IDs and the after-state target count/list.
with reviewed(discovery_observation_id, pre_apply_source_observation_id, expected_source_observation_id, expected_story_cluster_id) as (
  values
    ('00000000-0000-4000-8000-000000000001'::uuid,
     null::uuid,
     '00000000-0000-4000-8000-000000000002'::uuid,
     '00000000-0000-4000-8000-000000000003'::uuid)
), checked as (
  select reviewed.*,
    discovery.provider_id,
    discovery.source_observation_id as actual_source_observation_id,
    discovery.story_cluster_id as actual_story_cluster_id,
    source.external_id as source_external_id,
    discovery.external_id as discovery_external_id
  from reviewed
  left join app_private.discovery_observations discovery
    on discovery.id = reviewed.discovery_observation_id
  left join app_private.source_observations source
    on source.id = discovery.source_observation_id
)
select
  count(*)::integer as reviewed_before_count,
  count(*) filter (where actual_source_observation_id = expected_source_observation_id)::integer as linked_after_count,
  count(*) filter (where actual_story_cluster_id = expected_story_cluster_id)::integer as story_preserved_count,
  array_agg(discovery_observation_id order by discovery_observation_id)
    filter (where provider_id is distinct from 'google-news'
      or actual_source_observation_id is distinct from expected_source_observation_id
      or actual_story_cluster_id is distinct from expected_story_cluster_id
      or source_external_id is distinct from discovery_external_id) as failed_discovery_ids,
  count(*) filter (where provider_id is distinct from 'google-news'
    or actual_source_observation_id is distinct from expected_source_observation_id
    or actual_story_cluster_id is distinct from expected_story_cluster_id
    or source_external_id is distinct from discovery_external_id)::integer as failed_pair_count
from checked;

rollback;
