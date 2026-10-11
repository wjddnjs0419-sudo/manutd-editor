begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(23);

select ok(app_private.is_safe_gnews_publisher_url('https://www.bbc.com/sport/football/story'),
  'public HTTPS publisher URLs are accepted');
select ok(not app_private.is_safe_gnews_publisher_url('https://news.google.com/rss/articles/wrapper-id'),
  'Google News wrappers are rejected as publisher URLs');
select ok(not app_private.is_safe_gnews_publisher_url('https://youtu.be/video-id'),
  'video hosts are rejected as publisher URLs');

insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, excerpt, platform, content_fingerprint, metadata, first_observed_at, last_observed_at
) values (
  'google-news', 'Google News', 'DISCOVERY_COMMUNITY', 'gnews-cache-first',
  'https://news.google.com/rss/articles/gnews-test-cache-001',
  'Manchester United team update', 'Google RSS snippet', 'RSS', 'gnews-cache-fingerprint-1',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-test-cache-001'),
  '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'
), (
  'google-news', 'Google News', 'DISCOVERY_COMMUNITY', 'gnews-cache-second',
  'https://news.google.com/rss/articles/gnews-test-cache-001',
  'Manchester United team update', 'Google RSS snippet', 'RSS', 'gnews-cache-fingerprint-2',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-test-cache-001'),
  '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'
);

select id as first_observation_id from app_private.discovery_observations
where provider_id = 'google-news' and external_id = 'gnews-cache-first' \gset
select id as second_observation_id from app_private.discovery_observations
where provider_id = 'google-news' and external_id = 'gnews-cache-second' \gset

select is((select canonical_url from app_private.discovery_observations where id = :'first_observation_id'::uuid),
  'https://news.google.com/rss/articles/gnews-test-cache-001', 'discovery keeps the original Google News URL');
select is((select google_news_article_id from app_private.discovery_observations where id = :'first_observation_id'::uuid),
  'gnews-test-cache-001', 'the original provider article identity is retained');

select app_private.gnews_resolver_claim_batch('claim-gnews-cache-01', 30, 'github-actions') as first_claim \gset
select is(jsonb_array_length(:'first_claim'::jsonb->'items'), 1,
  'a duplicate Google article ID is claimed once');
select is((:'first_claim'::jsonb->'items'->0->>'id')::uuid, :'first_observation_id'::uuid,
  'the earliest observation owns the unique article claim');
select (:'first_claim'::jsonb->>'lease_id') as first_lease_id \gset

update app_private.discovery_observations
set resolver_lease_expires_at = now() - interval '1 second'
where id = :'first_observation_id'::uuid;

select app_private.gnews_resolver_complete_batch(
  'complete-gnews-expired-01', 'github-actions', :'first_lease_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', :'first_observation_id', 'url_resolution_status', 'RESOLVED',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/story',
    'article_fetch_status', 'NOT_ATTEMPTED', 'article_extraction_status', 'NOT_ATTEMPTED',
    'article_final_url', null, 'article_content_excerpt', null, 'safe_error_category', null
  )), '[]'::jsonb, 0
) as expired_completion \gset
select is(:'expired_completion'::jsonb->>'status', 'LEASE_EXPIRED',
  'an expired lease cannot commit worker results');

select app_private.gnews_resolver_claim_batch('claim-gnews-cache-02', 30, 'github-actions') as second_claim \gset
select is(jsonb_array_length(:'second_claim'::jsonb->'items'), 1,
  'an expired lease is available for a fresh worker attempt');
select is((:'second_claim'::jsonb->'items'->0->>'id')::uuid, :'first_observation_id'::uuid,
  'the fresh lease keeps the same unique observation');
select (:'second_claim'::jsonb->>'lease_id') as second_lease_id \gset

select app_private.gnews_resolver_complete_batch(
  'complete-gnews-cache-01', 'github-actions', :'second_lease_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', :'first_observation_id', 'url_resolution_status', 'RESOLVED',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/story',
    'article_fetch_status', 'NOT_ATTEMPTED', 'article_extraction_status', 'NOT_ATTEMPTED',
    'article_final_url', null, 'article_content_excerpt', null, 'safe_error_category', null
  )), '[]'::jsonb, 0
) as completion \gset
select is(:'completion'::jsonb->>'status', 'COMPLETED', 'a valid lease commits the URL resolution');
select is((select url_resolution_status from app_private.discovery_observations where id = :'second_observation_id'::uuid),
  'RESOLVED', 'the durable URL cache resolves duplicate observations');
select is((select resolved_publisher_url from app_private.discovery_observations where id = :'second_observation_id'::uuid),
  'https://www.bbc.com/sport/football/story', 'the same publisher URL propagates to duplicates');
select is((select canonical_url from app_private.discovery_observations where id = :'first_observation_id'::uuid),
  'https://news.google.com/rss/articles/gnews-test-cache-001', 'resolution does not overwrite canonical Google provenance');
select is((select count(*)::integer from app_private.gnews_article_url_cache where google_article_id = 'gnews-test-cache-001'),
  1, 'one persistent cache row exists per Google article ID');

select app_private.gnews_resolver_claim_batch('claim-gnews-cache-03', 30, 'github-actions') as cached_claim \gset
select is(jsonb_array_length(:'cached_claim'::jsonb->'items'), 0,
  'cached successes are not decoded again');

insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, excerpt, platform, content_fingerprint, metadata
) values (
  'google-news', 'Google News', 'DISCOVERY_COMMUNITY', 'gnews-crash-loop',
  'https://news.google.com/rss/articles/gnews-test-crash-002',
  'Manchester United injury update', 'Google RSS snippet', 'RSS', 'gnews-crash-fingerprint',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-test-crash-002')
);
select id as crash_observation_id from app_private.discovery_observations
where provider_id = 'google-news' and external_id = 'gnews-crash-loop' \gset
select app_private.gnews_resolver_claim_batch('claim-crash-lease-01', 1, 'github-actions') as crash_claim_1 \gset
select is(jsonb_array_length(:'crash_claim_1'::jsonb->'items'), 1, 'the first worker attempt receives a lease');
update app_private.discovery_observations set resolver_lease_expires_at = now() - interval '1 second'
where id = :'crash_observation_id'::uuid;
select app_private.gnews_resolver_claim_batch('claim-crash-lease-02', 1, 'github-actions') as crash_claim_2 \gset
select is(jsonb_array_length(:'crash_claim_2'::jsonb->'items'), 1, 'the second worker attempt receives a lease');
update app_private.discovery_observations set resolver_lease_expires_at = now() - interval '1 second'
where id = :'crash_observation_id'::uuid;
select app_private.gnews_resolver_claim_batch('claim-crash-lease-03', 1, 'github-actions') as crash_claim_3 \gset
select is(jsonb_array_length(:'crash_claim_3'::jsonb->'items'), 1, 'the third worker attempt receives a lease');
update app_private.discovery_observations set resolver_lease_expires_at = now() - interval '1 second'
where id = :'crash_observation_id'::uuid;
select is((select url_resolution_status from app_private.discovery_observations where id = :'crash_observation_id'::uuid),
  'FAILED', 'three worker lease expirations terminate the resolver attempt');
select is((select safe_error_category from app_private.discovery_observations where id = :'crash_observation_id'::uuid),
  'WORKER_LEASE_EXPIRED', 'worker termination remains an explicit safe failure category');
select is((select resolver_attempt_count from app_private.discovery_observations where id = :'crash_observation_id'::uuid),
  3, 'expired leases consume the bounded retry budget');
select app_private.gnews_resolver_claim_batch('claim-crash-lease-04', 1, 'github-actions') as crash_claim_4 \gset
select is(jsonb_array_length(:'crash_claim_4'::jsonb->'items'), 0,
  'a fourth lease is not issued after the attempt cap');

select * from finish();
rollback;
