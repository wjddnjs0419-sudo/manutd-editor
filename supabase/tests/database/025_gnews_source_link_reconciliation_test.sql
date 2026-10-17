begin isolation level serializable;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(48);

insert into public.information_sources (
  canonical_name, entity_type, website_url, reliability_score, reliability_rationale, editorial_role
) values
  ('GNews Reconciliation BBC Fixture', 'MEDIA_OUTLET', 'https://www.bbc.com', 0, 'Test fixture.', 'DISCOVERY_COMMUNITY'),
  ('GNews Reconciliation Mirror Fixture', 'MEDIA_OUTLET', 'https://www.mirror.co.uk', 0, 'Test fixture.', 'DISCOVERY_COMMUNITY'),
  ('GNews Reconciliation Yahoo Fixture', 'MEDIA_OUTLET', 'https://sports.yahoo.com', 0, 'Test fixture.', 'DISCOVERY_COMMUNITY');

insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at, status)
values ('Reconciliation safe linked story', now() - interval '2 hours', now(), 'OPEN')
returning id as safe_story_id \gset
insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title, excerpt,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
)
select id, 'DISCOVERY_COMMUNITY', 'gnews-reconcile-safe',
  'https://news.google.com/rss/articles/reconcile-safe',
  'Manchester United injury update', 'Google RSS snippet', now() - interval '1 hour', now(),
  0.7, 'reconcile-safe-fingerprint',
  jsonb_build_object('google_news_original_url', 'https://news.google.com/rss/articles/reconcile-safe',
    'google_news_article_id', 'reconcile-safe', 'article_extraction_status', 'NOT_ATTEMPTED',
    'article_body_present', false, 'verification_status', 'PENDING')
from public.information_sources where canonical_name = 'GNews Reconciliation BBC Fixture'
returning id as safe_source_id \gset
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, excerpt, published_at, first_observed_at, last_observed_at, platform,
  content_fingerprint, metadata, story_cluster_id, source_observation_id
) values (
  'google-news', 'GNews Reconciliation BBC Fixture', 'DISCOVERY_COMMUNITY', 'gnews-reconcile-safe',
  'https://news.google.com/rss/articles/reconcile-safe', 'Manchester United injury update',
  'Google RSS snippet', now() - interval '1 hour', now() - interval '1 hour', now(), 'RSS',
  'reconcile-safe-fingerprint', jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/reconcile-safe'),
  :'safe_story_id'::uuid, null
) returning id as safe_discovery_id \gset

insert into app_private.story_claims (
  story_cluster_id, raw_post_id, discovery_observation_id, claim_fingerprint, subject,
  predicate, object, claim_text, origin, grounding_status, grounding_version
) values (
  :'safe_story_id'::uuid, null, :'safe_discovery_id'::uuid, 'reconcile-safe-claim-fingerprint',
  'Manchester United', 'reported', 'injury update', 'Manchester United injury update',
  'discovery_observation', 'DISCOVERY_ONLY', 'gnews-reconcile-test-v1'
) returning id as safe_claim_id \gset
insert into app_private.claim_evidence (
  claim_id, source_observation_id, relation, editorial_role, evidence_text, evidence_confidence, is_grounding
) values (
  :'safe_claim_id'::uuid, :'safe_source_id'::uuid, 'SUPPORTS', 'DISCOVERY_COMMUNITY',
  'Manchester United injury update', 0.5, false
);

select is((select decision from app_private.gnews_source_link_reconciliation_plan(array[:'safe_discovery_id'::uuid])),
  'SAFE_TO_LINK', 'one exact URL, external ID, and metadata match is safe to link');
select is((select candidate_count from app_private.gnews_source_link_reconciliation_plan(array[:'safe_discovery_id'::uuid])),
  1, 'the safe plan has one source candidate');
select is((select cardinality(mismatch_fields) from app_private.gnews_source_link_reconciliation_plan(array[:'safe_discovery_id'::uuid])),
  0, 'the safe plan has no identifying-field differences');

select count(*)::integer as source_count_before_link from app_private.source_observations \gset
select count(*)::integer as claim_count_before_link from app_private.story_claims where story_cluster_id = :'safe_story_id'::uuid \gset
select count(*)::integer as evidence_count_before_link from app_private.claim_evidence where source_observation_id = :'safe_source_id'::uuid \gset
select app_private.gnews_source_link_reconciliation_apply(
  array[:'safe_discovery_id'::uuid], array[:'safe_source_id'::uuid]
) as safe_apply \gset
select is(:'safe_apply'::jsonb->'results'->0->>'status', 'LINKED', 'a reviewed safe pair links by existing source ID');
select is((select source_observation_id::text from app_private.discovery_observations where id = :'safe_discovery_id'::uuid),
  :'safe_source_id', 'reconciliation sets only the existing source foreign key');
select is((select story_cluster_id::text from app_private.discovery_observations where id = :'safe_discovery_id'::uuid),
  :'safe_story_id', 'the pre-existing story cluster ID is preserved');
select is((select count(*)::integer from app_private.source_observations), :'source_count_before_link'::integer,
  'linking creates no duplicate source observation');
select is((select metadata->>'verification_status' from app_private.source_observations where id = :'safe_source_id'::uuid),
  'PENDING', 'linking preserves the existing source verification state');
select is((select canonical_url from app_private.source_observations where id = :'safe_source_id'::uuid),
  'https://news.google.com/rss/articles/reconcile-safe', 'linking leaves the source URL untouched until resolver completion');
select is((select count(*)::integer from app_private.story_claims where story_cluster_id = :'safe_story_id'::uuid),
  :'claim_count_before_link'::integer, 'linking preserves existing story claims');
select is((select grounding_status from app_private.story_claims where id = :'safe_claim_id'::uuid),
  'DISCOVERY_ONLY', 'linking does not promote claim verification');
select is((select count(*)::integer from app_private.claim_evidence where source_observation_id = :'safe_source_id'::uuid),
  :'evidence_count_before_link'::integer, 'linking preserves existing claim evidence');

select app_private.gnews_resolver_claim_batch('claim-reconcile-linked-01', 1, 'github-actions', 'recent') as safe_claim_batch \gset
select is(jsonb_array_length(:'safe_claim_batch'::jsonb->'items'), 1,
  'the already-assigned observation enters the resolver refresh path');
select (:'safe_claim_batch'::jsonb->>'lease_id') as safe_lease_id \gset
select app_private.gnews_resolver_complete_batch(
  'complete-reconcile-linked-01', 'github-actions', :'safe_lease_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', :'safe_discovery_id', 'url_resolution_status', 'RESOLVED',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/reconcile-safe',
    'article_fetch_status', 'FETCHED', 'article_extraction_status', 'EXTRACTED',
    'article_final_url', 'https://www.bbc.com/sport/football/reconcile-safe',
    'article_content_excerpt', 'BBC reports a Manchester United injury update.', 'safe_error_category', null
  )), '[]'::jsonb, 0
) as safe_completion \gset
select is(:'safe_completion'::jsonb->>'status', 'COMPLETED', 'resolver completion succeeds after source ID recovery');
select is((select canonical_url from app_private.source_observations where id = :'safe_source_id'::uuid),
  'https://www.bbc.com/sport/football/reconcile-safe', 'resolver refresh reaches the source through the recovered ID');
select is((select excerpt from app_private.source_observations where id = :'safe_source_id'::uuid),
  'BBC reports a Manchester United injury update.', 'a non-empty fetched body updates the existing source excerpt');
select is((select metadata->>'article_extraction_status' from app_private.source_observations where id = :'safe_source_id'::uuid),
  'EXTRACTED', 'the existing source stores extracted-body status only after a non-empty body');
select is((select metadata->>'article_body_present' from app_private.source_observations where id = :'safe_source_id'::uuid),
  'true', 'the existing source reports a body only when one was extracted');
select is((select metadata->>'verification_status' from app_private.source_observations where id = :'safe_source_id'::uuid),
  'PENDING', 'URL and body refresh do not promote source verification');
select is((select grounding_status from app_private.story_claims where id = :'safe_claim_id'::uuid),
  'DISCOVERY_ONLY', 'URL and body refresh preserve claim grounding status');
select is((select story_cluster_id::text from app_private.discovery_observations where id = :'safe_discovery_id'::uuid),
  :'safe_story_id', 'URL refresh preserves the existing story assignment');

-- A prior successful URL restore is identified by its Google URL provenance.
insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
values ('Previously restored GNews story', now() - interval '2 hours', now())
returning id as restored_story_id \gset
insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title, excerpt,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
)
select id, 'DISCOVERY_COMMUNITY', 'gnews-reconcile-restored',
  'https://www.bbc.com/sport/football/restored', 'Manchester United restored URL report',
  'Existing source excerpt', now() - interval '2 hours', now(), 0.7, 'reconcile-restored-fingerprint',
  jsonb_build_object('google_news_original_url', 'https://news.google.com/rss/articles/reconcile-restored',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/restored',
    'article_extraction_status', 'NOT_ATTEMPTED', 'article_body_present', false,
    'verification_status', 'PENDING')
from public.information_sources where canonical_name = 'GNews Reconciliation BBC Fixture'
returning id as restored_source_id \gset
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, published_at, first_observed_at, last_observed_at, platform,
  content_fingerprint, metadata, story_cluster_id, source_observation_id,
  google_news_original_url, url_resolution_status, resolved_publisher_url, resolved_at
) values (
  'google-news', 'GNews Reconciliation BBC Fixture', 'DISCOVERY_COMMUNITY', 'gnews-reconcile-restored',
  'https://news.google.com/rss/articles/reconcile-restored', 'Manchester United restored URL report',
  now() - interval '2 hours', now() - interval '2 hours', now(), 'RSS',
  'reconcile-restored-fingerprint', jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/reconcile-restored'),
  :'restored_story_id'::uuid, null, 'https://news.google.com/rss/articles/reconcile-restored',
  'RESOLVED', 'https://www.bbc.com/sport/football/restored', now()
) returning id as restored_discovery_id \gset
select is((select decision from app_private.gnews_source_link_reconciliation_plan(array[:'restored_discovery_id'::uuid])),
  'SAFE_TO_LINK', 'a completed URL restore matches through retained Google URL provenance');
select is((select candidate_audit->0->>'match_basis' from app_private.gnews_source_link_reconciliation_plan(array[:'restored_discovery_id'::uuid])),
  'RESOLVED_PUBLISHER_URL', 'the audit identifies the restored publisher URL match basis');
select app_private.gnews_source_link_reconciliation_apply(
  array[:'restored_discovery_id'::uuid], array[:'restored_source_id'::uuid]
) as restored_apply \gset
select is(:'restored_apply'::jsonb->'results'->0->>'status', 'LINKED',
  'previously restored observation links to its existing source row');
select is((select source_observation_id::text from app_private.discovery_observations where id = :'restored_discovery_id'::uuid),
  :'restored_source_id', 'completed restore keeps the original source observation identity');

-- Two URL-identity matches are an ambiguity, even when one resembles the row more closely.
insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
values ('Ambiguous GNews story', now() - interval '3 hours', now())
returning id as ambiguous_story_id \gset
insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
)
select id, 'DISCOVERY_COMMUNITY', 'gnews-reconcile-ambiguous',
  'https://news.google.com/rss/articles/reconcile-ambiguous', 'Manchester United ambiguous report',
  now() - interval '3 hours', now(), 0.7, 'reconcile-ambiguous-fingerprint', '{}'::jsonb
from public.information_sources where canonical_name in ('GNews Reconciliation BBC Fixture', 'GNews Reconciliation Mirror Fixture');
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url, title,
  published_at, first_observed_at, last_observed_at, platform, content_fingerprint,
  metadata, story_cluster_id, url_resolution_status, resolved_publisher_url
) values (
  'google-news', 'GNews Reconciliation BBC Fixture', 'DISCOVERY_COMMUNITY', 'gnews-reconcile-ambiguous',
  'https://news.google.com/rss/articles/reconcile-ambiguous', 'Manchester United ambiguous report',
  now() - interval '3 hours', now() - interval '3 hours', now(), 'RSS', 'reconcile-ambiguous-fingerprint',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/reconcile-ambiguous'),
  :'ambiguous_story_id'::uuid, 'RESOLVED', 'https://www.bbc.com/sport/football/ambiguous'
) returning id as ambiguous_discovery_id \gset
select is((select decision from app_private.gnews_source_link_reconciliation_plan(array[:'ambiguous_discovery_id'::uuid])),
  'QUARANTINE_AMBIGUOUS', 'multiple source rows with matching URL and external ID are quarantined');
select is((select candidate_count from app_private.gnews_source_link_reconciliation_plan(array[:'ambiguous_discovery_id'::uuid])),
  2, 'ambiguous candidates are both visible in the plan');
select app_private.gnews_source_link_reconciliation_apply(
  array[:'ambiguous_discovery_id'::uuid], array[null::uuid]
) as ambiguous_apply \gset
select is(:'ambiguous_apply'::jsonb->'results'->0->>'status', 'QUARANTINE_AMBIGUOUS',
  'ambiguous apply writes an audit row and does not link');
select is((select source_observation_id from app_private.discovery_observations where id = :'ambiguous_discovery_id'::uuid),
  null::uuid, 'ambiguous discovery observation remains unlinked');
select is((select count(*)::integer from app_private.gnews_source_link_reconciliation_quarantine
  where discovery_observation_id = :'ambiguous_discovery_id'::uuid), 2,
  'both ambiguous source candidates have separate audit entries');

-- A unique candidate with mismatched identifying fields is also review-only.
insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
values ('Metadata mismatch GNews story', now() - interval '4 hours', now())
returning id as mismatch_story_id \gset
insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
)
select id, 'DISCOVERY_COMMUNITY', 'gnews-reconcile-mismatch',
  'https://news.google.com/rss/articles/reconcile-mismatch', 'Manchester United OLD headline',
  now() - interval '4 hours', now(), 0.7, 'reconcile-mismatch-source-fingerprint', '{}'::jsonb
from public.information_sources where canonical_name = 'GNews Reconciliation BBC Fixture';
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url, title,
  published_at, first_observed_at, last_observed_at, platform, content_fingerprint,
  metadata, story_cluster_id, url_resolution_status, resolved_publisher_url
) values (
  'google-news', 'GNews Reconciliation BBC Fixture', 'DISCOVERY_COMMUNITY', 'gnews-reconcile-mismatch',
  'https://news.google.com/rss/articles/reconcile-mismatch', 'Manchester United NEW headline',
  now() - interval '4 hours', now() - interval '4 hours', now(), 'RSS', 'reconcile-mismatch-discovery-fingerprint',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/reconcile-mismatch'),
  :'mismatch_story_id'::uuid, 'RESOLVED', 'https://www.bbc.com/sport/football/mismatch'
) returning id as mismatch_discovery_id \gset
select is((select decision from app_private.gnews_source_link_reconciliation_plan(array[:'mismatch_discovery_id'::uuid])),
  'QUARANTINE_METADATA_MISMATCH', 'a unique URL match with metadata disagreements is not auto-linked');
select ok(exists (select 1 from app_private.gnews_source_link_reconciliation_plan(array[:'mismatch_discovery_id'::uuid]) where 'title' = any(mismatch_fields)),
  'the title disagreement is explicit in the review fields');
select app_private.gnews_source_link_reconciliation_apply(
  array[:'mismatch_discovery_id'::uuid], array[null::uuid]
) as mismatch_apply \gset
select is(:'mismatch_apply'::jsonb->'results'->0->>'status', 'QUARANTINE_METADATA_MISMATCH',
  'metadata mismatch is persisted for manual review');

-- A matching URL with a different external ID is a key conflict, not a match.
insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
values ('Key mismatch GNews story', now() - interval '5 hours', now())
returning id as key_mismatch_story_id \gset
insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
)
select id, 'DISCOVERY_COMMUNITY', 'gnews-reconcile-key-mismatch-source',
  'https://news.google.com/rss/articles/reconcile-key-mismatch', 'Manchester United key mismatch report',
  now() - interval '5 hours', now(), 0.7, 'reconcile-key-mismatch-fingerprint', '{}'::jsonb
from public.information_sources where canonical_name = 'GNews Reconciliation BBC Fixture';
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url, title,
  published_at, first_observed_at, last_observed_at, platform, content_fingerprint,
  metadata, story_cluster_id, url_resolution_status, resolved_publisher_url
) values (
  'google-news', 'GNews Reconciliation BBC Fixture', 'DISCOVERY_COMMUNITY', 'gnews-reconcile-key-mismatch-discovery',
  'https://news.google.com/rss/articles/reconcile-key-mismatch', 'Manchester United key mismatch report',
  now() - interval '5 hours', now() - interval '5 hours', now(), 'RSS', 'reconcile-key-mismatch-fingerprint',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/reconcile-key-mismatch'),
  :'key_mismatch_story_id'::uuid, 'RESOLVED', 'https://www.bbc.com/sport/football/key-mismatch'
) returning id as key_mismatch_discovery_id \gset
select is((select decision from app_private.gnews_source_link_reconciliation_plan(array[:'key_mismatch_discovery_id'::uuid])),
  'QUARANTINE_KEY_MISMATCH', 'a URL match with a different external ID is quarantined');
select ok(exists (select 1 from app_private.gnews_source_link_reconciliation_plan(array[:'key_mismatch_discovery_id'::uuid]) where 'external_id' = any(mismatch_fields)),
  'the external-ID disagreement is visible in the review fields');
select app_private.gnews_source_link_reconciliation_apply(
  array[:'key_mismatch_discovery_id'::uuid], array[null::uuid]
) as key_mismatch_apply \gset
select is(:'key_mismatch_apply'::jsonb->'results'->0->>'status', 'QUARANTINE_KEY_MISMATCH',
  'key-mismatch apply records a review item');
select is((select source_observation_id from app_private.discovery_observations where id = :'key_mismatch_discovery_id'::uuid),
  null::uuid, 'a key-conflict candidate is not linked');

-- No candidate is reported distinctly and never results in source creation.
insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
values ('No-match GNews story', now() - interval '5 hours', now())
returning id as unmatched_story_id \gset
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url, title,
  published_at, first_observed_at, last_observed_at, platform, content_fingerprint,
  metadata, story_cluster_id, url_resolution_status, resolved_publisher_url
) values (
  'google-news', 'Unknown test publisher', 'DISCOVERY_COMMUNITY', 'gnews-reconcile-no-match',
  'https://news.google.com/rss/articles/reconcile-no-match', 'Manchester United no-match report',
  now() - interval '5 hours', now() - interval '5 hours', now(), 'RSS', 'reconcile-no-match-fingerprint',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/reconcile-no-match'),
  :'unmatched_story_id'::uuid, 'RESOLVED', 'https://www.bbc.com/sport/football/no-match'
) returning id as unmatched_discovery_id \gset
select count(*)::integer as source_count_before_unmatched from app_private.source_observations \gset
select is((select decision from app_private.gnews_source_link_reconciliation_plan(array[:'unmatched_discovery_id'::uuid])),
  'NO_MATCH', 'a row with no source candidate is reported as NO_MATCH');
select is((select candidate_count from app_private.gnews_source_link_reconciliation_plan(array[:'unmatched_discovery_id'::uuid])),
  0, 'a no-match row has no source candidates');
select app_private.gnews_source_link_reconciliation_apply(
  array[:'unmatched_discovery_id'::uuid], array[null::uuid]
) as unmatched_apply \gset
select is(:'unmatched_apply'::jsonb->'results'->0->>'status', 'NO_MATCH',
  'no-match apply records the separate report without creating a source');
select is((select count(*)::integer from app_private.source_observations), :'source_count_before_unmatched'::integer,
  'no-match reconciliation does not create a source observation');
select is((select count(*)::integer from app_private.gnews_source_link_reconciliation_quarantine
  where discovery_observation_id = :'unmatched_discovery_id'::uuid and candidate_source_observation_id is null), 1,
  'no-match report has one idempotent quarantine entry');

-- Repeated apply calls neither duplicate source rows nor multiply audit rows.
select app_private.gnews_source_link_reconciliation_apply(
  array[:'ambiguous_discovery_id'::uuid], array[null::uuid]
) as ambiguous_repeat \gset
select is(:'ambiguous_repeat'::jsonb->'results'->0->>'status', 'QUARANTINE_AMBIGUOUS',
  'repeating an unsafe apply preserves the quarantine decision');
select is((select count(*)::integer from app_private.gnews_source_link_reconciliation_quarantine
  where discovery_observation_id = :'ambiguous_discovery_id'::uuid), 2,
  'repeated quarantine apply upserts the same candidate audit rows');
select app_private.gnews_source_link_reconciliation_apply(
  array[:'safe_discovery_id'::uuid], array[:'safe_source_id'::uuid]
) as safe_repeat \gset
select is(:'safe_repeat'::jsonb->'results'->0->>'status', 'ALREADY_LINKED',
  'repeating a successful apply is idempotent');
select is((select count(*)::integer from app_private.source_observations), :'source_count_before_unmatched'::integer,
  'successful and repeated reconciliation creates no source rows');

-- A new, unassigned observation is outside this repair plan and remains for M8.
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url, title,
  published_at, first_observed_at, last_observed_at, platform, content_fingerprint, metadata
) values (
  'google-news', 'GNews Reconciliation BBC Fixture', 'DISCOVERY_COMMUNITY', 'gnews-reconcile-new-unassigned',
  'https://news.google.com/rss/articles/reconcile-new-unassigned', 'Manchester United new unassigned report',
  now() - interval '20 minutes', now() - interval '20 minutes', now(), 'RSS', 'reconcile-new-unassigned-fingerprint',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/reconcile-new-unassigned')
) returning id as new_unassigned_discovery_id \gset
select is((select count(*)::integer from app_private.gnews_source_link_reconciliation_plan(array[:'new_unassigned_discovery_id'::uuid])),
  0, 'new unassigned observations stay on the M8 promotion path');
select is((select source_observation_id from app_private.discovery_observations where id = :'new_unassigned_discovery_id'::uuid),
  null::uuid, 'the reconciliation repair does not pre-create a source for a new story');

select * from finish();
rollback;
