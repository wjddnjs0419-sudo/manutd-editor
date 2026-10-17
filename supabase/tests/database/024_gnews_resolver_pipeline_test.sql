begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(70);

select ok(app_private.is_safe_gnews_publisher_url('https://www.bbc.com/sport/football/story'),
  'public HTTPS publisher URLs are accepted');
select ok(not app_private.is_safe_gnews_publisher_url('https://news.google.com/rss/articles/wrapper-id'),
  'Google News wrappers are rejected as publisher URLs');
select ok(not app_private.is_safe_gnews_publisher_url('https://youtu.be/video-id'),
  'video hosts are rejected as publisher URLs');
select ok(has_function_privilege('service_role', 'app_private.is_safe_gnews_publisher_url(text)', 'EXECUTE'),
  'the privileged resolver role can run publisher URL validation');

insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, excerpt, platform, content_fingerprint, metadata, first_observed_at, last_observed_at
) values (
  'google-news', 'Google News', 'DISCOVERY_COMMUNITY', 'gnews-cache-first',
  'https://news.google.com/rss/articles/gnews-test-cache-001',
  'Manchester United team update', 'Google RSS snippet', 'RSS', 'gnews-cache-fingerprint-1',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-test-cache-001'),
  now() - interval '1 hour', now() - interval '1 hour'
), (
  'google-news', 'Google News', 'DISCOVERY_COMMUNITY', 'gnews-cache-second',
  'https://news.google.com/rss/articles/gnews-test-cache-001',
  'Manchester United team update', 'Google RSS snippet', 'RSS', 'gnews-cache-fingerprint-2',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-test-cache-001'),
  now() - interval '2 hours', now() - interval '2 hours'
);

select id as first_observation_id from app_private.discovery_observations
where provider_id = 'google-news' and external_id = 'gnews-cache-first' \gset
select id as second_observation_id from app_private.discovery_observations
where provider_id = 'google-news' and external_id = 'gnews-cache-second' \gset

select is((select canonical_url from app_private.discovery_observations where id = :'first_observation_id'::uuid),
  'https://news.google.com/rss/articles/gnews-test-cache-001', 'discovery keeps the original Google News URL');
select is((select google_news_article_id from app_private.discovery_observations where id = :'first_observation_id'::uuid),
  'gnews-test-cache-001', 'the original provider article identity is retained');

select app_private.gnews_resolver_claim_batch('claim-gnews-cache-01', 30, 'github-actions', 'recent') as first_claim \gset
select is(jsonb_array_length(:'first_claim'::jsonb->'items'), 1,
  'a duplicate Google article ID is claimed once');
select is((:'first_claim'::jsonb->'items'->0->>'id')::uuid, :'first_observation_id'::uuid,
  'the newest observation represents its duplicate article ID');
select (:'first_claim'::jsonb->>'lease_id') as first_lease_id \gset
select is((select app_private.gnews_resolver_claim_batch('claim-gnews-cache-01', 30, 'github-actions', 'recent')->>'lease_id'),
  :'first_lease_id', 'replaying a claim request returns the same lease');
select is((select resolver_attempt_count from app_private.discovery_observations where id = :'first_observation_id'::uuid),
  1, 'replaying a claim does not consume another attempt');

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

select app_private.gnews_resolver_claim_batch('claim-gnews-cache-02', 30, 'github-actions', 'recent') as second_claim \gset
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

select app_private.gnews_resolver_claim_batch('claim-gnews-cache-03', 30, 'github-actions', 'recent') as cached_claim \gset
select is(jsonb_array_length(:'cached_claim'::jsonb->'items'), 0,
  'cached successes are not decoded again');
update app_private.gnews_resolver_api_rate_limits
set window_started_at = date_trunc('minute', now()) - interval '1 minute'
where worker_id = 'github-actions';

insert into public.information_sources (
  canonical_name, entity_type, website_url, reliability_score, reliability_rationale,
  editorial_role
) values (
  'Google News refresh fixture', 'MEDIA_OUTLET', 'https://news.google.com', 0,
  'Discovery source fixture.', 'DISCOVERY_COMMUNITY'
) returning id as refresh_information_source_id \gset
insert into public.story_clusters (canonical_title, first_seen_at, last_seen_at)
values ('Existing linked Manchester United story', now() - interval '2 hours', now())
returning id as refresh_story_id \gset
insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title, excerpt,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
) values (
  :'refresh_information_source_id'::uuid, 'DISCOVERY_COMMUNITY', 'gnews-linked-001',
  'https://news.google.com/rss/articles/gnews-linked-001',
  'Manchester United linked source title', 'Google RSS snippet', now() - interval '1 hour', now(),
  0.7, 'gnews-linked-source-fingerprint',
  jsonb_build_object(
    'google_news_original_url', 'https://news.google.com/rss/articles/gnews-linked-001',
    'google_news_article_id', 'gnews-linked-001',
    'article_extraction_status', 'NOT_ATTEMPTED', 'article_body_present', false,
    'verification_status', 'PENDING'
  )
) returning id as refresh_source_observation_id \gset
select published_at::text as refresh_source_published_at
from app_private.source_observations where id = :'refresh_source_observation_id'::uuid \gset
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, excerpt, published_at, first_observed_at, last_observed_at, platform,
  content_fingerprint, metadata, story_cluster_id, source_observation_id
) values (
  'google-news', 'Google News refresh fixture', 'DISCOVERY_COMMUNITY', 'gnews-linked-001',
  'https://news.google.com/rss/articles/gnews-linked-001',
  'Manchester United linked source title', 'Google RSS snippet', now() - interval '1 hour',
  now() - interval '1 hour', now(), 'RSS', 'gnews-linked-discovery-fingerprint',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-linked-001'),
  :'refresh_story_id'::uuid, :'refresh_source_observation_id'::uuid
);
select id as refresh_discovery_observation_id from app_private.discovery_observations
where provider_id = 'google-news' and external_id = 'gnews-linked-001' \gset
select app_private.gnews_resolver_claim_batch('claim-gnews-linked-01', 30, 'github-actions', 'recent') as refresh_claim \gset
select (:'refresh_claim'::jsonb->>'lease_id') as refresh_lease_id \gset
select is(jsonb_array_length(:'refresh_claim'::jsonb->'items'), 1,
  'an already-linked Google observation can be resolved');

select app_private.gnews_resolver_complete_batch(
  'complete-gnews-linked-01', 'github-actions', :'refresh_lease_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', :'refresh_discovery_observation_id', 'url_resolution_status', 'RESOLVED',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/linked-story',
    'article_fetch_status', 'FETCHED', 'article_extraction_status', 'EXTRACTED',
    'article_final_url', 'https://www.bbc.com/sport/football/linked-story',
    'article_content_excerpt', 'Publisher article body about Manchester United.',
    'safe_error_category', null
  )), '[]'::jsonb, 0
) as refresh_completion \gset
select is(:'refresh_completion'::jsonb->>'status', 'COMPLETED',
  'the linked observation result commits');
select is((select canonical_url from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  'https://www.bbc.com/sport/football/linked-story',
  'the existing source observation receives the validated publisher URL');
select is((select excerpt from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  'Publisher article body about Manchester United.',
  'a non-empty extracted body replaces the RSS snippet on the same source row');
select is((select metadata->>'google_news_original_url' from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  'https://news.google.com/rss/articles/gnews-linked-001',
  'the source row retains the original Google URL');
select is((select metadata->>'article_extraction_status' from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  'EXTRACTED', 'the source row records extraction only after receiving a non-empty body');
select is((select metadata->>'article_body_present' from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  'true', 'the source row records a body only when extraction succeeded');
select is((select source_observation_id from app_private.discovery_observations where id = :'refresh_discovery_observation_id'::uuid),
  :'refresh_source_observation_id'::uuid, 'the existing source foreign key remains unchanged');
select is((select story_cluster_id from app_private.discovery_observations where id = :'refresh_discovery_observation_id'::uuid),
  :'refresh_story_id'::uuid, 'the existing story cluster foreign key remains unchanged');
select is((select information_source_id from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  :'refresh_information_source_id'::uuid, 'publisher resolution does not replace provider identity');
select is((select published_at::text from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  :'refresh_source_published_at', 'publisher resolution preserves source publication time');
select is((select external_id from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  'gnews-linked-001', 'publisher resolution keeps the source external ID');
select is((select editorial_role::text from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  'DISCOVERY_COMMUNITY', 'publisher resolution does not promote discovery evidence to fact evidence');
select is((select metadata->>'verification_status' from app_private.source_observations where id = :'refresh_source_observation_id'::uuid),
  'PENDING', 'publisher resolution does not promote source verification');
select is((select canonical_title from public.story_clusters where id = :'refresh_story_id'::uuid),
  'Existing linked Manchester United story', 'publisher resolution does not change the existing story');
select is((select count(*)::integer from app_private.source_observations where information_source_id = :'refresh_information_source_id'::uuid and external_id = 'gnews-linked-001'),
  1, 'publisher resolution does not create a duplicate source observation');
select is((select app_private.gnews_resolver_complete_batch(
  'complete-gnews-linked-01', 'github-actions', :'refresh_lease_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', :'refresh_discovery_observation_id', 'url_resolution_status', 'RESOLVED',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/linked-story',
    'article_fetch_status', 'FETCHED', 'article_extraction_status', 'EXTRACTED',
    'article_final_url', 'https://www.bbc.com/sport/football/linked-story',
    'article_content_excerpt', 'Publisher article body about Manchester United.',
    'safe_error_category', null
  )), '[]'::jsonb, 0
)->>'status'), 'COMPLETED', 'replaying the completion key is idempotent');

insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title, excerpt,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
) values (
  :'refresh_information_source_id'::uuid, 'DISCOVERY_COMMUNITY', 'gnews-linked-403',
  'https://news.google.com/rss/articles/gnews-linked-403',
  'Manchester United restricted source', 'Original Google RSS snippet', now() - interval '2 hours', now(),
  0.7, 'gnews-linked-source-fingerprint-403',
  jsonb_build_object('google_news_original_url', 'https://news.google.com/rss/articles/gnews-linked-403',
    'article_extraction_status', 'NOT_ATTEMPTED', 'article_body_present', false,
    'verification_status', 'PENDING')
) returning id as refresh_403_source_observation_id \gset
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, excerpt, published_at, first_observed_at, last_observed_at, platform,
  content_fingerprint, metadata, story_cluster_id, source_observation_id
) values (
  'google-news', 'Google News refresh fixture', 'DISCOVERY_COMMUNITY', 'gnews-linked-403',
  'https://news.google.com/rss/articles/gnews-linked-403', 'Manchester United restricted source',
  'Original Google RSS snippet', now() - interval '2 hours', now() - interval '2 hours', now(), 'RSS',
  'gnews-linked-discovery-fingerprint-403', jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-linked-403'),
  :'refresh_story_id'::uuid, :'refresh_403_source_observation_id'::uuid
) returning id as refresh_403_discovery_observation_id \gset
update app_private.gnews_resolver_api_rate_limits
set window_started_at = date_trunc('minute', now()) - interval '1 minute'
where worker_id = 'github-actions';
select app_private.gnews_resolver_claim_batch('claim-gnews-linked-403', 1, 'github-actions', 'recent') as refresh_403_claim \gset
select (:'refresh_403_claim'::jsonb->>'lease_id') as refresh_403_lease_id \gset
select app_private.gnews_resolver_complete_batch(
  'complete-gnews-linked-403', 'github-actions', :'refresh_403_lease_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', :'refresh_403_discovery_observation_id', 'url_resolution_status', 'RESOLVED',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/restricted-story',
    'article_fetch_status', 'ACCESS_RESTRICTED', 'article_extraction_status', 'NOT_ATTEMPTED',
    'article_final_url', null, 'article_content_excerpt', null, 'safe_error_category', 'PUBLISHER_HTTP_403'
  )), '[]'::jsonb, 0
) as refresh_403_completion \gset
select is(:'refresh_403_completion'::jsonb->>'status', 'COMPLETED', 'a 403 publisher response records URL resolution independently');
select is((select excerpt from app_private.source_observations where id = :'refresh_403_source_observation_id'::uuid),
  'Original Google RSS snippet', 'a 403 response preserves the prior source excerpt');
select is((select metadata->>'article_extraction_status' from app_private.source_observations where id = :'refresh_403_source_observation_id'::uuid),
  'NOT_ATTEMPTED', 'a 403 response does not record successful extraction');
select is((select metadata->>'article_body_present' from app_private.source_observations where id = :'refresh_403_source_observation_id'::uuid),
  'false', 'a 403 response does not claim an extracted body');
select is((select metadata->>'article_fetch_status' from app_private.source_observations where id = :'refresh_403_source_observation_id'::uuid),
  'ACCESS_RESTRICTED', 'the source row records publisher access restriction');
select is((select metadata->>'article_safe_error_category' from app_private.source_observations where id = :'refresh_403_source_observation_id'::uuid),
  'PUBLISHER_HTTP_403', 'the source row keeps the bounded 403 reason');
select is((select metadata->>'verification_status' from app_private.source_observations where id = :'refresh_403_source_observation_id'::uuid),
  'PENDING', 'a 403 response does not promote source verification');

insert into app_private.source_observations (
  information_source_id, editorial_role, external_id, canonical_url, title, excerpt,
  published_at, observed_at, discovery_signal, content_fingerprint, metadata
) values (
  :'refresh_information_source_id'::uuid, 'DISCOVERY_COMMUNITY', 'gnews-linked-empty',
  'https://news.google.com/rss/articles/gnews-linked-empty',
  'Manchester United bodyless source', 'Original Google RSS snippet', now() - interval '3 hours', now(),
  0.7, 'gnews-linked-source-fingerprint-empty',
  jsonb_build_object('google_news_original_url', 'https://news.google.com/rss/articles/gnews-linked-empty',
    'article_extraction_status', 'NOT_ATTEMPTED', 'article_body_present', false)
) returning id as refresh_empty_source_observation_id \gset
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, excerpt, published_at, first_observed_at, last_observed_at, platform,
  content_fingerprint, metadata, story_cluster_id, source_observation_id
) values (
  'google-news', 'Google News refresh fixture', 'DISCOVERY_COMMUNITY', 'gnews-linked-empty',
  'https://news.google.com/rss/articles/gnews-linked-empty', 'Manchester United bodyless source',
  'Original Google RSS snippet', now() - interval '3 hours', now() - interval '3 hours', now(), 'RSS',
  'gnews-linked-discovery-fingerprint-empty', jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-linked-empty'),
  :'refresh_story_id'::uuid, :'refresh_empty_source_observation_id'::uuid
) returning id as refresh_empty_discovery_observation_id \gset
update app_private.gnews_resolver_api_rate_limits
set window_started_at = date_trunc('minute', now()) - interval '1 minute'
where worker_id = 'github-actions';
select app_private.gnews_resolver_claim_batch('claim-gnews-linked-empty', 1, 'github-actions', 'recent') as refresh_empty_claim \gset
select (:'refresh_empty_claim'::jsonb->>'lease_id') as refresh_empty_lease_id \gset
select app_private.gnews_resolver_complete_batch(
  'complete-gnews-linked-empty', 'github-actions', :'refresh_empty_lease_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', :'refresh_empty_discovery_observation_id', 'url_resolution_status', 'RESOLVED',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/bodyless-story',
    'article_fetch_status', 'FETCHED', 'article_extraction_status', 'EMPTY_BODY',
    'article_final_url', 'https://www.bbc.com/sport/football/bodyless-story',
    'article_content_excerpt', null, 'safe_error_category', 'NO_ARTICLE_BODY'
  )), '[]'::jsonb, 0
) as refresh_empty_completion \gset
select is(:'refresh_empty_completion'::jsonb->>'status', 'COMPLETED', 'a fetched page without a body completes safely');
select is((select excerpt from app_private.source_observations where id = :'refresh_empty_source_observation_id'::uuid),
  'Original Google RSS snippet', 'an empty body does not replace the existing excerpt');
select is((select metadata->>'article_extraction_status' from app_private.source_observations where id = :'refresh_empty_source_observation_id'::uuid),
  'EMPTY_BODY', 'an empty body is not marked extracted');
select is((select metadata->>'article_body_present' from app_private.source_observations where id = :'refresh_empty_source_observation_id'::uuid),
  'false', 'an empty body remains absent in source metadata');

insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, excerpt, published_at, first_observed_at, last_observed_at, platform,
  content_fingerprint, metadata
) values (
  'google-news', 'Google News', 'DISCOVERY_COMMUNITY', 'gnews-new-unassigned',
  'https://news.google.com/rss/articles/gnews-new-unassigned', 'Manchester United newly discovered report',
  'RSS snippet only', now() - interval '4 hours', now() - interval '4 hours', now(), 'RSS',
  'gnews-new-unassigned-fingerprint', jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-new-unassigned')
) returning id as new_unassigned_observation_id \gset
select app_private.gnews_resolver_claim_batch('claim-gnews-new-unassigned', 1, 'github-actions', 'recent') as new_unassigned_claim \gset
select (:'new_unassigned_claim'::jsonb->>'lease_id') as new_unassigned_lease_id \gset
select app_private.gnews_resolver_complete_batch(
  'complete-gnews-new-unassigned', 'github-actions', :'new_unassigned_lease_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', :'new_unassigned_observation_id', 'url_resolution_status', 'RESOLVED',
    'resolved_publisher_url', 'https://www.bbc.com/sport/football/new-unassigned-story',
    'article_fetch_status', 'NOT_ATTEMPTED', 'article_extraction_status', 'NOT_ATTEMPTED',
    'article_final_url', null, 'article_content_excerpt', null, 'safe_error_category', null
  )), '[]'::jsonb, 0
) as new_unassigned_completion \gset
select is(:'new_unassigned_completion'::jsonb->>'status', 'COMPLETED', 'a fresh unassigned observation resolves successfully');
select is((select url_resolution_status from app_private.discovery_observations where id = :'new_unassigned_observation_id'::uuid),
  'RESOLVED', 'a fresh unassigned observation is ready for M8 promotion');
select is((select story_cluster_id from app_private.discovery_observations where id = :'new_unassigned_observation_id'::uuid),
  null::uuid, 'resolver completion does not create or assign a story');
select is((select source_observation_id from app_private.discovery_observations where id = :'new_unassigned_observation_id'::uuid),
  null::uuid, 'resolver completion does not create or assign an M8 source row');
select is((select count(*)::integer from app_private.source_observations where external_id = 'gnews-new-unassigned'),
  0, 'resolver completion creates no source observation for an unassigned item');

update app_private.gnews_resolver_api_rate_limits
set window_started_at = date_trunc('minute', now()) - interval '1 minute'
where worker_id = 'github-actions';
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, published_at, first_observed_at, last_observed_at, platform, content_fingerprint, metadata
)
select 'google-news', 'Google News', 'DISCOVERY_COMMUNITY', 'gnews-recent-' || hours || 'h',
  'https://news.google.com/rss/articles/gnews-recent-' || hours || 'h',
  'Manchester United recent item ' || hours, now() - make_interval(hours => hours),
  now() - make_interval(hours => hours), now() - make_interval(hours => hours), 'RSS',
  'gnews-recent-fingerprint-' || hours,
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-recent-' || hours || 'h')
from unnest(array[6, 20, 70, 73, -1]) as hours;
select app_private.gnews_resolver_claim_batch('claim-gnews-recent-window', 30, 'github-actions', 'recent') as recent_claim \gset
select is(jsonb_array_length(:'recent_claim'::jsonb->'items'), 3,
  'recent mode includes only observations inside the 72-hour window');
select is(:'recent_claim'::jsonb->'items'->0->>'google_article_id', 'gnews-recent-6h',
  'recent mode prioritizes the latest 24 hours first');
select is(:'recent_claim'::jsonb->'items'->1->>'google_article_id', 'gnews-recent-20h',
  'recent mode sorts newer observations before older 24-to-72-hour items');
select is(:'recent_claim'::jsonb->'items'->2->>'google_article_id', 'gnews-recent-70h',
  'recent mode includes the older edge of its 72-hour window');

update app_private.gnews_resolver_api_rate_limits
set window_started_at = date_trunc('minute', now()) - interval '1 minute'
where worker_id = 'github-actions';
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, published_at, first_observed_at, last_observed_at, platform, content_fingerprint, metadata
)
select 'google-news', 'Google News', 'DISCOVERY_COMMUNITY', 'gnews-backfill-' || n,
  'https://news.google.com/rss/articles/gnews-backfill-' || n,
  'Manchester United historical item ' || n, now() - make_interval(hours => 100 + n),
  now() - make_interval(hours => 100 + n), now() - make_interval(hours => 100 + n), 'RSS',
  'gnews-backfill-fingerprint-' || n,
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-backfill-' || n)
from generate_series(1, 31) as n;
select app_private.gnews_resolver_claim_batch('claim-gnews-backfill-bounded', 30, 'github-actions', 'backfill') as backfill_claim \gset
select is(jsonb_array_length(:'backfill_claim'::jsonb->'items'), 30,
  'backfill mode remains limited to one maximum-size batch');
select is(:'backfill_claim'::jsonb->'items'->0->>'google_article_id', 'gnews-backfill-31',
  'backfill mode processes the oldest historical row first');
select is((app_private.gnews_resolver_claim_batch(
  'claim-gnews-backfill-bounded', 30, 'github-actions', 'backfill'
)->>'lease_id'), :'backfill_claim'::jsonb->>'lease_id',
  'replaying a backfill claim returns the same bounded lease');
select is((select count(*)::integer from app_private.discovery_observations
  where external_id like 'gnews-backfill-%' and resolver_attempt_count = 1 and url_resolution_status = 'CLAIMED'),
  30, 'replaying the backfill does not claim additional historical rows');
select is(app_private.gnews_resolver_claim_batch(
  'claim-gnews-backfill-bounded', 30, 'github-actions', 'recent'
)->>'status', 'IDEMPOTENCY_CONFLICT', 'a backfill request key cannot be replayed in recent mode');

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
update app_private.gnews_resolver_api_rate_limits
set window_started_at = date_trunc('minute', now()) - interval '1 minute'
where worker_id = 'github-actions';
select app_private.gnews_resolver_claim_batch('claim-crash-lease-01', 1, 'github-actions', 'recent') as crash_claim_1 \gset
select is(jsonb_array_length(:'crash_claim_1'::jsonb->'items'), 1, 'the first worker attempt receives a lease');
update app_private.discovery_observations set resolver_lease_expires_at = now() - interval '1 second'
where id = :'crash_observation_id'::uuid;
select app_private.gnews_resolver_claim_batch('claim-crash-lease-02', 1, 'github-actions', 'recent') as crash_claim_2 \gset
select is(jsonb_array_length(:'crash_claim_2'::jsonb->'items'), 1, 'the second worker attempt receives a lease');
update app_private.discovery_observations set resolver_lease_expires_at = now() - interval '1 second'
where id = :'crash_observation_id'::uuid;
select app_private.gnews_resolver_claim_batch('claim-crash-lease-03', 1, 'github-actions', 'recent') as crash_claim_3 \gset
select is(jsonb_array_length(:'crash_claim_3'::jsonb->'items'), 1, 'the third worker attempt receives a lease');
update app_private.discovery_observations set resolver_lease_expires_at = now() - interval '1 second'
where id = :'crash_observation_id'::uuid;
select app_private.gnews_resolver_claim_batch('claim-crash-lease-04', 1, 'github-actions', 'recent') as crash_claim_4 \gset
select is(jsonb_array_length(:'crash_claim_4'::jsonb->'items'), 0,
  'an expired third lease is recovered without issuing a fourth attempt');
select is((select url_resolution_status from app_private.discovery_observations where id = :'crash_observation_id'::uuid),
  'FAILED', 'three worker lease expirations terminate the resolver attempt');
select is((select safe_error_category from app_private.discovery_observations where id = :'crash_observation_id'::uuid),
  'WORKER_LEASE_EXPIRED', 'worker termination remains an explicit safe failure category');
select is((select resolver_attempt_count from app_private.discovery_observations where id = :'crash_observation_id'::uuid),
  3, 'expired leases consume the bounded retry budget');

update app_private.gnews_resolver_api_rate_limits
set window_started_at = date_trunc('minute', now()) - interval '1 minute'
where worker_id = 'github-actions';
insert into app_private.discovery_observations (
  provider_id, source_canonical_name, editorial_role, external_id, canonical_url,
  title, published_at, first_observed_at, last_observed_at, platform, content_fingerprint, metadata
) values (
  'google-news', 'Google News', 'DISCOVERY_COMMUNITY', 'gnews-google-429',
  'https://news.google.com/rss/articles/gnews-google-429', 'Manchester United Google rate limited',
  now() - interval '2 hours', now() - interval '2 hours', now(), 'RSS', 'gnews-google-429-fingerprint',
  jsonb_build_object('google_news_url', 'https://news.google.com/rss/articles/gnews-google-429')
) returning id as google_429_observation_id \gset
select app_private.gnews_resolver_claim_batch('claim-gnews-google-429', 1, 'github-actions', 'recent') as google_429_claim \gset
select (:'google_429_claim'::jsonb->>'lease_id') as google_429_lease_id \gset
select app_private.gnews_resolver_complete_batch(
  'complete-gnews-google-429', 'github-actions', :'google_429_lease_id'::uuid,
  jsonb_build_array(jsonb_build_object(
    'id', :'google_429_observation_id', 'url_resolution_status', 'RATE_LIMITED',
    'resolved_publisher_url', null, 'article_fetch_status', 'NOT_ATTEMPTED',
    'article_extraction_status', 'NOT_ATTEMPTED', 'article_final_url', null,
    'article_content_excerpt', null, 'safe_error_category', 'GOOGLE_HTTP_429'
  )), '[]'::jsonb, 900
) as google_429_completion \gset
select is(:'google_429_completion'::jsonb->>'status', 'COMPLETED', 'Google 429 writes a bounded cooldown');
select ok((select global_cooldown_until > now() from app_private.gnews_resolver_control where singleton),
  'Google 429 keeps a global cooldown active');
select * from finish();
rollback;
