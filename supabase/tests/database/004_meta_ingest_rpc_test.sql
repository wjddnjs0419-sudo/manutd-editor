begin;

set role postgres;
set search_path = pgtap, extensions, public;
select plan(27);

select has_function(
  'public',
  'ingest_instagram_batch',
  array['text', 'jsonb', 'jsonb', 'timestamp with time zone'],
  'Instagram batch ingest RPC exists'
);

select ok(
  not (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid = 'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)'::regprocedure
  ),
  'ingest RPC uses SECURITY INVOKER'
);

select ok(
  (
    select p.proconfig @> array['search_path=""']
    from pg_catalog.pg_proc p
    where p.oid = 'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)'::regprocedure
  ),
  'ingest RPC pins an empty search_path'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc p
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    where p.oid = 'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)'::regprocedure
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  0,
  'PUBLIC has no execute privilege on ingest RPC'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)',
    'EXECUTE'
  ),
  'anon cannot execute ingest RPC'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)',
    'EXECUTE'
  ),
  'authenticated cannot execute ingest RPC'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.ingest_instagram_batch(text,jsonb,jsonb,timestamptz)',
    'EXECUTE'
  ),
  'service_role can execute ingest RPC'
);

set local role service_role;

create temporary table first_ingest_result as
select public.ingest_instagram_batch(
  'utdreport',
  jsonb_build_object(
    'instagram_account_id', '17841400000000001',
    'followers_count', 250000,
    'followers_available', true,
    'likes_available', true,
    'comments_available', true,
    'views_available', false,
    'media_url_available', true,
    'carousel_children_available', true
  ),
  jsonb_build_array(
    jsonb_build_object(
      'external_post_id', 'image-1',
      'caption', 'Image fixture',
      'permalink', 'https://www.instagram.com/p/image-1/',
      'media_type', 'IMAGE',
      'media_product_type', null,
      'published_at', '2026-09-17T00:30:00Z',
      'like_count', 10,
      'comments_count', 2,
      'view_count', null,
      'followers_count_at_collection', 250000,
      'post_age_minutes', 30,
      'raw_payload', jsonb_build_object('id', 'image-1', 'media_type', 'IMAGE')
    ),
    jsonb_build_object(
      'external_post_id', 'carousel-1',
      'caption', 'Carousel fixture',
      'permalink', 'https://www.instagram.com/p/carousel-1/',
      'media_type', 'CAROUSEL_ALBUM',
      'media_product_type', null,
      'published_at', '2026-09-17T00:00:00Z',
      'like_count', 20,
      'comments_count', 3,
      'view_count', null,
      'followers_count_at_collection', 250000,
      'post_age_minutes', 60,
      'raw_payload', jsonb_build_object('id', 'carousel-1', 'media_type', 'CAROUSEL_ALBUM')
    ),
    jsonb_build_object(
      'external_post_id', 'reel-1',
      'caption', 'Reel fixture',
      'permalink', 'https://www.instagram.com/reel/reel-1/',
      'media_type', 'VIDEO',
      'media_product_type', 'REELS',
      'published_at', '2026-09-16T23:30:00Z',
      'like_count', 30,
      'comments_count', 4,
      'view_count', null,
      'followers_count_at_collection', 250000,
      'post_age_minutes', 90,
      'raw_payload', jsonb_build_object(
        'id', 'reel-1',
        'media_type', 'VIDEO',
        'media_product_type', 'REELS'
      )
    )
  ),
  '2026-09-17T01:00:00Z'::timestamptz
) as result;

reset role;

select is(
  (select instagram_account_id from public.source_accounts where username = 'utdreport'),
  '17841400000000001',
  'ingest updates the discovered Instagram account ID'
);

select is(
  (
    select count(*)::integer
    from public.raw_posts rp
    join public.source_accounts sa on sa.id = rp.source_account_id
    where sa.username = 'utdreport'
  ),
  3,
  'first ingest stores three raw posts'
);

select is(
  (
    select count(*)::integer
    from public.post_metric_snapshots pms
    join public.raw_posts rp on rp.id = pms.raw_post_id
    join public.source_accounts sa on sa.id = rp.source_account_id
    where sa.username = 'utdreport'
  ),
  3,
  'first ingest stores one initial snapshot per post'
);

select is((select (result ->> 'inserted_posts')::integer from first_ingest_result), 3, 'summary reports inserted posts');
select is((select (result ->> 'updated_posts')::integer from first_ingest_result), 0, 'summary reports no updated posts');
select is((select (result ->> 'inserted_snapshots')::integer from first_ingest_result), 3, 'summary reports inserted snapshots');

select is(
  (select view_count from public.raw_posts where external_post_id = 'reel-1'),
  null::bigint,
  'Reel raw post accepts a missing view count'
);

select is(
  (
    select pms.view_count
    from public.post_metric_snapshots pms
    join public.raw_posts rp on rp.id = pms.raw_post_id
    where rp.external_post_id = 'reel-1'
  ),
  null::bigint,
  'Reel initial snapshot accepts a missing view count'
);

set local role service_role;

create temporary table second_ingest_result as
select public.ingest_instagram_batch(
  'utdreport',
  jsonb_build_object(
    'instagram_account_id', '17841400000000001',
    'followers_count', 250000,
    'followers_available', true,
    'likes_available', true,
    'comments_available', true,
    'views_available', false,
    'media_url_available', true,
    'carousel_children_available', true
  ),
  (
    select jsonb_agg(
      case
        when item ->> 'external_post_id' = 'image-1'
          then jsonb_set(item, '{like_count}', '99'::jsonb)
        else item
      end
    )
    from jsonb_array_elements(
      jsonb_build_array(
        jsonb_build_object(
          'external_post_id', 'image-1', 'caption', 'Updated image fixture',
          'permalink', 'https://www.instagram.com/p/image-1/', 'media_type', 'IMAGE',
          'media_product_type', null, 'published_at', '2026-09-17T00:30:00Z',
          'like_count', 10, 'comments_count', 2, 'view_count', null,
          'followers_count_at_collection', 250000, 'post_age_minutes', 40,
          'raw_payload', jsonb_build_object('id', 'image-1', 'media_type', 'IMAGE')
        ),
        jsonb_build_object(
          'external_post_id', 'carousel-1', 'caption', 'Carousel fixture',
          'permalink', 'https://www.instagram.com/p/carousel-1/', 'media_type', 'CAROUSEL_ALBUM',
          'media_product_type', null, 'published_at', '2026-09-17T00:00:00Z',
          'like_count', 20, 'comments_count', 3, 'view_count', null,
          'followers_count_at_collection', 250000, 'post_age_minutes', 70,
          'raw_payload', jsonb_build_object('id', 'carousel-1', 'media_type', 'CAROUSEL_ALBUM')
        ),
        jsonb_build_object(
          'external_post_id', 'reel-1', 'caption', 'Reel fixture',
          'permalink', 'https://www.instagram.com/reel/reel-1/', 'media_type', 'VIDEO',
          'media_product_type', 'REELS', 'published_at', '2026-09-16T23:30:00Z',
          'like_count', 30, 'comments_count', 4, 'view_count', null,
          'followers_count_at_collection', 250000, 'post_age_minutes', 100,
          'raw_payload', jsonb_build_object('id', 'reel-1', 'media_type', 'VIDEO', 'media_product_type', 'REELS')
        )
      )
    ) as media_item(item)
  ),
  '2026-09-17T01:10:00Z'::timestamptz
) as result;

reset role;

select is((select count(*)::integer from public.raw_posts), 3, 'retry does not duplicate raw posts');
select is((select count(*)::integer from public.post_metric_snapshots), 3, 'retry does not duplicate initial snapshots');
select is((select (result ->> 'inserted_posts')::integer from second_ingest_result), 0, 'retry reports no inserted posts');
select is((select (result ->> 'updated_posts')::integer from second_ingest_result), 3, 'retry reports three updated posts');
select is((select (result ->> 'inserted_snapshots')::integer from second_ingest_result), 0, 'retry reports no inserted snapshots');
select is((select like_count from public.raw_posts where external_post_id = 'image-1'), 99::bigint, 'retry refreshes raw metrics');
select is(
  (
    select pms.like_count
    from public.post_metric_snapshots pms
    join public.raw_posts rp on rp.id = pms.raw_post_id
    where rp.external_post_id = 'image-1'
  ),
  10::bigint,
  'retry preserves the first metric snapshot'
);

set local role service_role;

select throws_ok(
  $$
    select public.ingest_instagram_batch(
      'utdreport',
      '{"instagram_account_id":"17841400000000999","followers_count":250001}'::jsonb,
      '[
        {
          "external_post_id":"atomic-valid",
          "media_type":"IMAGE",
          "published_at":"2026-09-17T00:40:00Z",
          "like_count":1,
          "comments_count":0,
          "post_age_minutes":30,
          "raw_payload":{"id":"atomic-valid","media_type":"IMAGE"}
        },
        {
          "external_post_id":"atomic-invalid",
          "media_type":"IMAGE",
          "published_at":"2026-09-17T00:45:00Z",
          "like_count":-1,
          "comments_count":0,
          "post_age_minutes":25,
          "raw_payload":{"id":"atomic-invalid","media_type":"IMAGE"}
        }
      ]'::jsonb,
      '2026-09-17T01:10:00Z'::timestamptz
    )
  $$,
  '22023',
  'post atomic-invalid has invalid like_count',
  'one malformed post rejects the complete batch'
);

reset role;

select is(
  (select instagram_account_id from public.source_accounts where username = 'utdreport'),
  '17841400000000001',
  'failed batch rolls back the account update'
);
select is((select count(*)::integer from public.raw_posts where external_post_id = 'atomic-valid'), 0, 'failed batch rolls back valid post insert');
select is((select count(*)::integer from public.post_metric_snapshots), 3, 'failed batch creates no snapshots');

set local role service_role;

select throws_ok(
  $$
    select public.ingest_instagram_batch(
      'utddistrict',
      '{"instagram_account_id":"17841400000000002"}'::jsonb,
      '[]'::jsonb,
      '2026-09-17T01:10:00Z'::timestamptz
    )
  $$,
  '22023',
  'Milestone 2 only supports utdreport',
  'RPC rejects accounts outside the Milestone 2 slice'
);

reset role;

select * from finish();
rollback;
