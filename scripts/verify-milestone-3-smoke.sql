\set ON_ERROR_STOP on

select sa.username,
       sa.instagram_account_id is not null as has_instagram_id,
       max(rp.followers_count_at_collection) as followers,
       count(distinct rp.id) as posts,
       count(distinct pms.id) as snapshots,
       count(distinct ma.id) as media_assets,
       count(distinct ma.id) filter (where ma.storage_path is not null) as stored_assets,
       count(distinct rp.id) filter (
         where rp.media_product_type = 'REELS' and rp.view_count is null
       ) as reels_with_nullable_views
from public.source_accounts sa
left join public.raw_posts rp on rp.source_account_id = sa.id
left join public.post_metric_snapshots pms on pms.raw_post_id = rp.id
left join public.media_assets ma on ma.raw_post_id = rp.id
where sa.username in ('utdreport', 'utddistrict', 'manunitedzone')
group by sa.username
order by sa.username;

select count(*) as duplicate_raw_posts
from (
  select source_account_id, external_post_id
  from public.raw_posts
  group by source_account_id, external_post_id
  having count(*) > 1
) duplicates;

select count(*) as duplicate_snapshot_buckets
from (
  select raw_post_id, capture_bucket_start
  from public.post_metric_snapshots
  group by raw_post_id, capture_bucket_start
  having count(*) > 1
) duplicates;

select count(*) as duplicate_storage_paths
from (
  select storage_path
  from public.media_assets
  where storage_path is not null
  group by storage_path
  having count(*) > 1
) duplicates;
