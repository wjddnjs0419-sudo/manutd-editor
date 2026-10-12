begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(14);

insert into public.information_sources (
  canonical_name, entity_type, website_url, reliability_score, reliability_rationale, editorial_role
) values
  ('M8 Publisher Grounding Test Google News', 'MEDIA_OUTLET', 'https://news.google.com', 0,
   'Discovery wrapper fixture only.', 'DISCOVERY_COMMUNITY'),
  ('M8 Publisher Grounding Test BBC', 'MEDIA_OUTLET', 'https://www.bbc.com/sport', 8,
   'Reviewed publisher fixture for pgTAP.', 'FACT_INDEPENDENT');

insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at, status)
values ('M8 publisher report provenance fixture', now() - interval '1 hour', now(), 'OPEN')
returning id as story_id \gset

insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url, title, excerpt,
  published_at, first_observed_at, last_observed_at, platform, content_fingerprint, metadata
) values (
  'google-news', 'BBC Sport', 'DISCOVERY_COMMUNITY', 'm8-publisher-grounding-gnews-001',
  'https://news.google.com/rss/articles/m8-publisher-grounding-001',
  'Manchester United transfer report', 'Google News feed description.', now() - interval '1 hour',
  now() - interval '1 hour', now(), 'RSS', 'm8-publisher-grounding-discovery-fingerprint',
  jsonb_build_object('google_news_original_url', 'https://news.google.com/rss/articles/m8-publisher-grounding-001',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/m8-publisher-grounding-001')
) returning id as discovery_id \gset

insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title, excerpt,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
) values (
  (select id from public.information_sources where canonical_name = 'M8 Publisher Grounding Test Google News'),
  'DISCOVERY_COMMUNITY', 'm8-publisher-grounding-gnews-001',
  'https://news.google.com/rss/articles/m8-publisher-grounding-001',
  'Manchester United transfer report', 'Google News feed description.', now() - interval '1 hour', now(),
  0.7, 'm8-publisher-grounding-google-observation',
  jsonb_build_object('google_news_original_url', 'https://news.google.com/rss/articles/m8-publisher-grounding-001',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/m8-publisher-grounding-001',
    'article_extraction_status', 'EXTRACTED')
) returning id as google_source_observation_id \gset

insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title, excerpt,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
) values (
  (select id from public.information_sources where canonical_name = 'M8 Publisher Grounding Test BBC'),
  'FACT_INDEPENDENT', 'https://www.bbc.com/sport/football/m8-publisher-grounding-001',
  'https://www.bbc.com/sport/football/m8-publisher-grounding-001',
  'Manchester United transfer report',
  'BBC Sport reports that United are considering a move, but no agreement has been reached.',
  now() - interval '1 hour', now(), 0, 'm8-publisher-grounding-bbc-observation',
  jsonb_build_object(
    'google_news_original_url', 'https://news.google.com/rss/articles/m8-publisher-grounding-001',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/m8-publisher-grounding-001',
    'article_fetch_status', 'FETCHED', 'article_extraction_status', 'EXTRACTED',
    'publisher_canonical_name', 'BBC Sport',
    'supporting_sentence', 'BBC Sport reports that United are considering a move, but no agreement has been reached.'
  )
)
on conflict (information_source_id, external_id) do update set metadata = excluded.metadata
returning id as publisher_source_observation_id \gset

insert into app_private.story_claims (
  story_cluster_id, raw_post_id, discovery_observation_id, publisher_source_observation_id,
  claim_fingerprint, subject, predicate, object, claim_text, origin, claim_scope,
  claim_modality, grounding_status, grounding_confidence, grounding_version, decision_reason
) values (
  :'story_id'::uuid, null, :'discovery_id'::uuid, :'publisher_source_observation_id'::uuid,
  'm8-publisher-grounding-report-claim', 'Manchester United', 'reported',
  'BBC Sport reports that United are considering a move, but no agreement has been reached.',
  'BBC Sport reports: BBC Sport reports that United are considering a move, but no agreement has been reached.',
  'publisher_article', 'PUBLISHER_REPORT', 'RUMOR', 'VERIFIED', 0.9, 'm8-b-v1', 'VERIFIED_PUBLISHER_REPORT'
) returning id as publisher_report_claim_id \gset

insert into app_private.claim_evidence (
  claim_id, source_observation_id, relation, editorial_role, evidence_text, evidence_confidence, is_grounding
) values (
  :'publisher_report_claim_id'::uuid, :'publisher_source_observation_id'::uuid, 'SUPPORTS', 'FACT_INDEPENDENT',
  'BBC Sport reports that United are considering a move, but no agreement has been reached.', 0.9, true
);

select is((select editorial_role::text from app_private.source_observations where id = :'google_source_observation_id'::uuid),
  'DISCOVERY_COMMUNITY', 'the Google News observation remains discovery-only');
select is((select canonical_url from app_private.source_observations where id = :'google_source_observation_id'::uuid),
  'https://news.google.com/rss/articles/m8-publisher-grounding-001', 'Google wrapper URL remains on its discovery observation');
select is((select information_source_id from app_private.source_observations where id = :'google_source_observation_id'::uuid),
  (select id from public.information_sources where canonical_name = 'M8 Publisher Grounding Test Google News'),
  'discovery observation uses the Google News source identity');
select is((select editorial_role::text from app_private.source_observations where id = :'publisher_source_observation_id'::uuid),
  'FACT_INDEPENDENT', 'publisher article uses its reviewed fact role');
select is((select canonical_url from app_private.source_observations where id = :'publisher_source_observation_id'::uuid),
  'https://www.bbc.com/sport/football/m8-publisher-grounding-001', 'publisher article keeps its canonical URL');
select is((select published_at from app_private.source_observations where id = :'publisher_source_observation_id'::uuid),
  (select published_at from app_private.discovery_observations where id = :'discovery_id'::uuid),
  'publisher observation keeps article publication time');
select is((select metadata->>'google_news_original_url' from app_private.source_observations where id = :'publisher_source_observation_id'::uuid),
  'https://news.google.com/rss/articles/m8-publisher-grounding-001', 'publisher evidence keeps original Google URL as provenance');
select is((select metadata->>'publisher_canonical_name' from app_private.source_observations where id = :'publisher_source_observation_id'::uuid),
  'BBC Sport', 'publisher evidence records reviewed outlet name');
select is((select metadata->>'supporting_sentence' from app_private.source_observations where id = :'publisher_source_observation_id'::uuid),
  'BBC Sport reports that United are considering a move, but no agreement has been reached.',
  'publisher evidence stores the exact supporting sentence');
select is((select count(*)::integer from app_private.source_observations where information_source_id =
  (select id from public.information_sources where canonical_name = 'M8 Publisher Grounding Test BBC')
  and external_id = 'https://www.bbc.com/sport/football/m8-publisher-grounding-001'), 1,
  'repeated source/article identity remains idempotent');
select is((select claim_scope from app_private.story_claims where id = :'publisher_report_claim_id'::uuid),
  'PUBLISHER_REPORT', 'claim scope preserves report-level semantics');
select is((select claim_modality from app_private.story_claims where id = :'publisher_report_claim_id'::uuid),
  'RUMOR', 'claim modality preserves uncertainty');
select is((select publisher_source_observation_id from app_private.story_claims where id = :'publisher_report_claim_id'::uuid),
  :'publisher_source_observation_id'::uuid, 'report claim links to its exact publisher observation');
select is((select evidence_text from app_private.claim_evidence where claim_id = :'publisher_report_claim_id'::uuid),
  'BBC Sport reports that United are considering a move, but no agreement has been reached.',
  'claim evidence stores the exact article sentence');

select * from finish();
rollback;
