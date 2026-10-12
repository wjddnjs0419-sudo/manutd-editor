-- Preserve the scope and modality of claims so publisher reporting can be
-- grounded without silently changing the truth status of the reported event.
alter table app_private.story_claims
  add column claim_scope text not null default 'EVENT',
  add column claim_modality text not null default 'UNKNOWN',
  add column publisher_source_observation_id uuid references app_private.source_observations(id) on delete cascade,
  drop constraint if exists story_claims_origin_check;

alter table app_private.story_claims
  add constraint story_claims_origin_check
    check (origin in ('caption', 'image', 'carousel_slide', 'thumbnail', 'discovery_observation', 'publisher_article')),
  add constraint story_claims_scope_check
    check (claim_scope in ('PUBLISHER_REPORT', 'EVENT')),
  add constraint story_claims_modality_check
    check (claim_modality in ('CONFIRMED', 'RUMOR', 'PREDICTION', 'DENIAL', 'OPINION', 'UNKNOWN')),
  add constraint story_claims_publisher_report_origin_check
    check (claim_scope <> 'PUBLISHER_REPORT' or origin = 'publisher_article'),
  add constraint story_claims_publisher_article_source_check
    check (origin <> 'publisher_article' or (raw_post_id is null and discovery_observation_id is not null and publisher_source_observation_id is not null)),
  add constraint story_claims_publisher_report_scope_check
    check (claim_scope <> 'PUBLISHER_REPORT' or publisher_source_observation_id is not null);

comment on column app_private.story_claims.claim_scope is
  'PUBLISHER_REPORT verifies only that the reviewed publisher made the statement; EVENT is an event-level assertion.';
comment on column app_private.story_claims.claim_modality is
  'Semantic modality preserved from the source claim: confirmed, rumor, prediction, denial, opinion, or unknown.';

create index story_claims_publisher_observation_idx
  on app_private.story_claims (publisher_source_observation_id, grounding_status)
  where publisher_source_observation_id is not null;
