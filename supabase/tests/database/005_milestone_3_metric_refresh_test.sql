begin;

set role postgres;
set search_path = pgtap, extensions, public;
select plan(14);

select has_column(
  'public',
  'post_metric_snapshots',
  'capture_bucket_start',
  'metric snapshots expose a durable 30-minute bucket'
);

select is(
  app_private.metric_snapshot_interval(119),
  interval '30 minutes',
  'posts younger than two hours refresh every 30 minutes'
);
select is(
  app_private.metric_snapshot_interval(120),
  interval '1 hour',
  'posts from two to six hours old refresh hourly'
);
select is(
  app_private.metric_snapshot_interval(360),
  interval '2 hours',
  'posts from six to twelve hours old refresh every two hours'
);
select is(
  app_private.metric_snapshot_interval(720),
  interval '4 hours',
  'posts from twelve to twenty-four hours old refresh every four hours'
);
select is(
  app_private.metric_snapshot_interval(1440),
  null::interval,
  'posts at least twenty-four hours old stop refreshing'
);

select has_function(
  'public',
  'ingest_instagram_account_batch',
  array['uuid', 'jsonb', 'jsonb', 'timestamp with time zone'],
  'account-ID based Instagram ingest RPC exists'
);

select ok(
  not (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid =
      'public.ingest_instagram_account_batch(uuid,jsonb,jsonb,timestamptz)'::regprocedure
  ),
  'account ingest RPC uses SECURITY INVOKER'
);

select ok(
  (
    select p.proconfig @> array['search_path=""']
    from pg_catalog.pg_proc p
    where p.oid =
      'public.ingest_instagram_account_batch(uuid,jsonb,jsonb,timestamptz)'::regprocedure
  ),
  'account ingest RPC pins an empty search path'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.ingest_instagram_account_batch(uuid,jsonb,jsonb,timestamptz)',
    'EXECUTE'
  ),
  'service_role can execute account ingest RPC'
);

set local role service_role;

select public.ingest_instagram_account_batch(
  (select id from public.source_accounts where username = 'utdreport'),
  '{"instagram_account_id":"17841400000000001","followers_count":250000}'::jsonb,
  '[{
    "external_post_id":"metric-refresh-1",
    "caption":"Initial fixture",
    "permalink":"https://www.instagram.com/p/metric-refresh-1/",
    "media_type":"IMAGE",
    "published_at":"2026-09-17T00:31:00Z",
    "like_count":10,
    "comments_count":2,
    "followers_count_at_collection":250000,
    "raw_payload":{"id":"metric-refresh-1","media_type":"IMAGE"}
  }]'::jsonb,
  '2026-09-17T01:01:00Z'::timestamptz
);

select public.ingest_instagram_account_batch(
  (select id from public.source_accounts where username = 'utdreport'),
  '{"instagram_account_id":"17841400000000001","followers_count":250000}'::jsonb,
  '[{
    "external_post_id":"metric-refresh-1",
    "caption":"Same bucket retry",
    "permalink":"https://www.instagram.com/p/metric-refresh-1/",
    "media_type":"IMAGE",
    "published_at":"2026-09-17T00:31:00Z",
    "like_count":11,
    "comments_count":2,
    "followers_count_at_collection":250000,
    "raw_payload":{"id":"metric-refresh-1","media_type":"IMAGE"}
  }]'::jsonb,
  '2026-09-17T01:20:00Z'::timestamptz
);

select public.ingest_instagram_account_batch(
  (select id from public.source_accounts where username = 'utdreport'),
  '{"instagram_account_id":"17841400000000001","followers_count":250000}'::jsonb,
  '[{
    "external_post_id":"metric-refresh-1",
    "caption":"Next due bucket",
    "permalink":"https://www.instagram.com/p/metric-refresh-1/",
    "media_type":"IMAGE",
    "published_at":"2026-09-17T00:31:00Z",
    "like_count":12,
    "comments_count":3,
    "followers_count_at_collection":250000,
    "raw_payload":{"id":"metric-refresh-1","media_type":"IMAGE"}
  }]'::jsonb,
  '2026-09-17T01:31:00Z'::timestamptz
);

reset role;

select is(
  (select count(*)::integer from public.post_metric_snapshots),
  2,
  'retry before cadence creates no duplicate and the next due bucket creates one snapshot'
);

select is(
  (select count(distinct capture_bucket_start)::integer from public.post_metric_snapshots),
  2,
  'each stored snapshot has a distinct bucket for the post'
);

set local role service_role;

select throws_ok(
  $$
    select public.ingest_instagram_account_batch(
      (select id from public.source_accounts where username = 'utdreport'),
      '{"instagram_account_id":"17841400000000001","followers_count":250000}'::jsonb,
      '[{
        "external_post_id":"metric-refresh-1",
        "caption":"Invalid publish time mutation",
        "permalink":"https://www.instagram.com/p/metric-refresh-1/",
        "media_type":"IMAGE",
        "published_at":"2026-09-17T00:32:00Z",
        "like_count":13,
        "comments_count":3,
        "followers_count_at_collection":250000,
        "raw_payload":{"id":"metric-refresh-1","media_type":"IMAGE"}
      }]'::jsonb,
      '2026-09-17T01:32:00Z'::timestamptz
    )
  $$,
  '22023',
  'post metric-refresh-1 published_at cannot change',
  're-ingest rejects a changed published_at'
);

reset role;

select is(
  (
    select published_at
    from public.raw_posts
    where external_post_id = 'metric-refresh-1'
  ),
  '2026-09-17T00:31:00Z'::timestamptz,
  'failed mutation preserves the original published_at'
);

select * from finish();
rollback;
