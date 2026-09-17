begin;

set role postgres;
set search_path = pgtap, extensions, public;
select plan(27);

select has_function(
  'public', 'prepare_instagram_media_assets', array['uuid', 'jsonb'],
  'media asset prepare RPC exists'
);
select has_function(
  'public', 'finalize_instagram_media_assets', array['uuid', 'jsonb'],
  'media asset finalize RPC exists'
);
select ok(
  not (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid = 'public.prepare_instagram_media_assets(uuid,jsonb)'::regprocedure
  ),
  'prepare RPC uses SECURITY INVOKER'
);
select ok(
  not (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid = 'public.finalize_instagram_media_assets(uuid,jsonb)'::regprocedure
  ),
  'finalize RPC uses SECURITY INVOKER'
);
select ok(
  not has_function_privilege(
    'anon', 'public.prepare_instagram_media_assets(uuid,jsonb)', 'EXECUTE'
  ),
  'anon cannot execute prepare RPC'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.finalize_instagram_media_assets(uuid,jsonb)', 'EXECUTE'
  ),
  'authenticated cannot execute finalize RPC'
);
select is(
  (select count(*)::integer from storage.buckets where id = 'instagram-analysis'),
  1,
  'instagram analysis bucket exists'
);
select is(
  (select public from storage.buckets where id = 'instagram-analysis'),
  false,
  'instagram analysis bucket is private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'instagram-analysis'),
  20971520::bigint,
  'instagram analysis bucket limits objects to 20 MiB'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'instagram-analysis'),
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[],
  'instagram analysis bucket allows only supported image MIME types'
);

set local role service_role;

select public.ingest_instagram_account_batch(
  (select id from public.source_accounts where username = 'utdreport'),
  '{"instagram_account_id":"17841400000000001","followers_count":250000}'::jsonb,
  '[{
    "external_post_id":"asset-image-1",
    "media_type":"IMAGE",
    "published_at":"2026-09-17T02:30:00Z",
    "like_count":10,
    "comments_count":2,
    "raw_payload":{"id":"asset-image-1","media_type":"IMAGE"}
  }]'::jsonb,
  '2026-09-17T03:00:00Z'::timestamptz
);

select public.ingest_instagram_account_batch(
  (select id from public.source_accounts where username = 'utddistrict'),
  '{"instagram_account_id":"17841400000000002","followers_count":100000}'::jsonb,
  '[{
    "external_post_id":"other-account-image",
    "media_type":"IMAGE",
    "published_at":"2026-09-17T02:30:00Z",
    "like_count":1,
    "comments_count":0,
    "raw_payload":{"id":"other-account-image","media_type":"IMAGE"}
  }]'::jsonb,
  '2026-09-17T03:00:00Z'::timestamptz
);

create temporary table first_prepare as
select public.prepare_instagram_media_assets(
  (select id from public.source_accounts where username = 'utdreport'),
  jsonb_build_array(jsonb_build_object(
    'raw_post_id', (select id from public.raw_posts where external_post_id = 'asset-image-1'),
    'external_media_id', 'asset-image-1',
    'asset_type', 'IMAGE',
    'carousel_index', null,
    'original_media_url', 'https://cdn.example/asset-image-1.jpg'
  ))
) as result;

reset role;

select is((select count(*)::integer from public.media_assets), 1,
  'prepare creates one media asset row');
select is(
  (select jsonb_array_length(result -> 'pending') from first_prepare), 1,
  'prepare returns the new asset as pending'
);

set local role service_role;

create temporary table second_prepare as
select public.prepare_instagram_media_assets(
  (select id from public.source_accounts where username = 'utdreport'),
  jsonb_build_array(jsonb_build_object(
    'raw_post_id', (select id from public.raw_posts where external_post_id = 'asset-image-1'),
    'external_media_id', 'asset-image-1',
    'asset_type', 'IMAGE',
    'carousel_index', null,
    'original_media_url', 'https://cdn.example/asset-image-1-v2.jpg'
  ))
) as result;

reset role;

select is((select count(*)::integer from public.media_assets), 1,
  'prepare retry does not duplicate metadata');
select is(
  (select original_media_url from public.media_assets),
  'https://cdn.example/asset-image-1-v2.jpg',
  'prepare retry refreshes the original URL'
);

update public.media_assets
set storage_path = 'instagram/account/post/asset-image-1.jpg';

set local role service_role;

create temporary table stored_prepare as
select public.prepare_instagram_media_assets(
  (select id from public.source_accounts where username = 'utdreport'),
  jsonb_build_array(jsonb_build_object(
    'raw_post_id', (select id from public.raw_posts where external_post_id = 'asset-image-1'),
    'external_media_id', 'asset-image-1',
    'asset_type', 'IMAGE',
    'carousel_index', null,
    'original_media_url', 'https://cdn.example/asset-image-1-v3.jpg'
  ))
) as result;

reset role;

select is(
  (select jsonb_array_length(result -> 'pending') from stored_prepare), 0,
  'prepare excludes assets that already have a storage path'
);

update public.media_assets
set storage_path = null;

set local role service_role;

create temporary table finalize_result as
select public.finalize_instagram_media_assets(
  (select id from public.source_accounts where username = 'utdreport'),
  jsonb_build_array(jsonb_build_object(
    'media_asset_id', (select id from public.media_assets),
    'storage_path', 'instagram/account/post/asset-image-1.jpg',
    'mime_type', 'image/jpeg',
    'fetched_at', '2026-09-17T03:05:00Z'
  ))
) as result;

reset role;

select is((select (result ->> 'finalized')::integer from finalize_result), 1,
  'finalize reports one completed asset');
select is((select storage_path from public.media_assets),
  'instagram/account/post/asset-image-1.jpg', 'finalize records storage path');
select is((select mime_type from public.media_assets), 'image/jpeg',
  'finalize records MIME type');
select is((select fetched_at from public.media_assets),
  '2026-09-17T03:05:00Z'::timestamptz, 'finalize records fetch time');
select is((select retention_until from public.media_assets),
  '2026-10-17T03:05:00Z'::timestamptz, 'finalize records thirty-day retention');

set local role service_role;

select throws_ok(
  $$
    select public.prepare_instagram_media_assets(
      (select id from public.source_accounts where username = 'utdreport'),
      jsonb_build_array(jsonb_build_object(
        'raw_post_id', (select id from public.raw_posts where external_post_id = 'other-account-image'),
        'external_media_id', 'foreign-image', 'asset_type', 'IMAGE',
        'carousel_index', null, 'original_media_url', 'https://cdn.example/foreign.jpg'
      ))
    )
  $$,
  '22023', 'media asset raw post is not owned by source account',
  'prepare rejects a raw post owned by another account'
);
select throws_ok(
  $$
    select public.prepare_instagram_media_assets(
      (select id from public.source_accounts where username = 'utdreport'),
      jsonb_build_array(jsonb_build_object(
        'raw_post_id', (select id from public.raw_posts where external_post_id = 'asset-image-1'),
        'external_media_id', 'video-1', 'asset_type', 'VIDEO',
        'carousel_index', null, 'original_media_url', 'https://cdn.example/video.mp4'
      ))
    )
  $$,
  '22023', 'media asset has unsupported asset_type',
  'prepare rejects unsupported asset types'
);
select throws_ok(
  $$
    select public.prepare_instagram_media_assets(
      (select id from public.source_accounts where username = 'utdreport'),
      jsonb_build_array(jsonb_build_object(
        'raw_post_id', (select id from public.raw_posts where external_post_id = 'asset-image-1'),
        'external_media_id', 'child-negative', 'asset_type', 'CAROUSEL_CHILD',
        'carousel_index', -1, 'original_media_url', 'https://cdn.example/child.jpg'
      ))
    )
  $$,
  '22023', 'media asset has invalid carousel_index',
  'prepare rejects a negative carousel index'
);
select throws_ok(
  $$
    select public.prepare_instagram_media_assets(
      (select id from public.source_accounts where username = 'utdreport'),
      jsonb_build_array(jsonb_build_object(
        'raw_post_id', (select id from public.raw_posts where external_post_id = 'asset-image-1'),
        'external_media_id', ' ', 'asset_type', 'IMAGE',
        'carousel_index', null, 'original_media_url', 'https://cdn.example/blank.jpg'
      ))
    )
  $$,
  '22023', 'media asset external_media_id is required',
  'prepare rejects a blank external media ID'
);
select throws_ok(
  $$
    select public.prepare_instagram_media_assets(
      (select id from public.source_accounts where username = 'utdreport'),
      jsonb_build_array(jsonb_build_object(
        'raw_post_id', (select id from public.raw_posts where external_post_id = 'asset-image-1'),
        'external_media_id', 'http-image', 'asset_type', 'IMAGE',
        'carousel_index', null, 'original_media_url', 'http://cdn.example/image.jpg'
      ))
    )
  $$,
  '22023', 'media asset original_media_url must use HTTPS',
  'prepare rejects an HTTP media URL'
);
select throws_ok(
  $$
    select public.finalize_instagram_media_assets(
      (select id from public.source_accounts where username = 'utddistrict'),
      jsonb_build_array(jsonb_build_object(
        'media_asset_id', (select id from public.media_assets),
        'storage_path', 'instagram/other/post/asset-image-1.jpg',
        'mime_type', 'image/jpeg',
        'fetched_at', '2026-09-17T03:06:00Z'
      ))
    )
  $$,
  '22023', 'media asset is not owned by source account',
  'finalize rejects an asset owned by another account'
);

reset role;

select is((select storage_path from public.media_assets),
  'instagram/account/post/asset-image-1.jpg',
  'failed cross-account finalize preserves the stored path');

select * from finish();
rollback;
