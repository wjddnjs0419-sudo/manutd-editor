create or replace function public.ingest_instagram_batch(
  p_username text,
  p_account jsonb,
  p_posts jsonb,
  p_collected_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source_account_id uuid;
  v_instagram_account_id text;
  v_followers_count bigint;
  v_post jsonb;
  v_external_post_id text;
  v_media_type text;
  v_media_product_type text;
  v_published_at timestamptz;
  v_like_count bigint;
  v_comments_count bigint;
  v_view_count bigint;
  v_post_followers_count bigint;
  v_post_age_minutes integer;
  v_raw_post_id uuid;
  v_inserted_posts integer := 0;
  v_updated_posts integer := 0;
  v_inserted_snapshots integer := 0;
begin
  if p_username is distinct from 'utdreport' then
    raise exception using
      errcode = '22023',
      message = 'Milestone 2 only supports utdreport';
  end if;

  if p_collected_at is null then
    raise exception using
      errcode = '22023',
      message = 'collected_at is required';
  end if;

  if p_account is null or pg_catalog.jsonb_typeof(p_account) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'account payload must be an object';
  end if;

  if p_posts is null or pg_catalog.jsonb_typeof(p_posts) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'posts payload must be an array';
  end if;

  v_instagram_account_id := pg_catalog.btrim(p_account ->> 'instagram_account_id');
  if v_instagram_account_id is null or v_instagram_account_id = '' then
    raise exception using
      errcode = '22023',
      message = 'instagram_account_id is required';
  end if;

  if p_account ? 'followers_count'
    and pg_catalog.jsonb_typeof(p_account -> 'followers_count') <> 'null'
  then
    if pg_catalog.jsonb_typeof(p_account -> 'followers_count') <> 'number' then
      raise exception using
        errcode = '22023',
        message = 'account has invalid followers_count';
    end if;
    v_followers_count := (p_account ->> 'followers_count')::bigint;
    if v_followers_count < 0 then
      raise exception using
        errcode = '22023',
        message = 'account has invalid followers_count';
    end if;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_posts) as post_item(value)
    group by post_item.value ->> 'external_post_id'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using
      errcode = '22023',
      message = 'posts payload contains duplicate external_post_id';
  end if;

  select sa.id
  into v_source_account_id
  from public.source_accounts as sa
  where sa.username::text = p_username
    and sa.active
  for update;

  if v_source_account_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'active source account utdreport was not found';
  end if;

  update public.source_accounts
  set
    instagram_account_id = v_instagram_account_id,
    api_supported = true,
    followers_available = coalesce(
      (p_account ->> 'followers_available')::boolean,
      v_followers_count is not null
    ),
    likes_available = coalesce((p_account ->> 'likes_available')::boolean, likes_available),
    comments_available = coalesce(
      (p_account ->> 'comments_available')::boolean,
      comments_available
    ),
    views_available = coalesce((p_account ->> 'views_available')::boolean, views_available),
    media_url_available = coalesce(
      (p_account ->> 'media_url_available')::boolean,
      media_url_available
    ),
    carousel_children_available = coalesce(
      (p_account ->> 'carousel_children_available')::boolean,
      carousel_children_available
    ),
    last_probe_at = p_collected_at,
    probe_error = null
  where id = v_source_account_id;

  for v_post in
    select post_item.value
    from pg_catalog.jsonb_array_elements(p_posts) as post_item(value)
  loop
    if pg_catalog.jsonb_typeof(v_post) <> 'object' then
      raise exception using
        errcode = '22023',
        message = 'each post payload must be an object';
    end if;

    v_external_post_id := pg_catalog.btrim(v_post ->> 'external_post_id');
    if v_external_post_id is null or v_external_post_id = '' then
      raise exception using
        errcode = '22023',
        message = 'post external_post_id is required';
    end if;

    v_media_type := v_post ->> 'media_type';
    v_media_product_type := v_post ->> 'media_product_type';
    if not (
      (v_media_type in ('IMAGE', 'CAROUSEL_ALBUM') and v_media_product_type is null)
      or (v_media_type = 'VIDEO' and v_media_product_type = 'REELS')
    ) then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('post %s has unsupported media type', v_external_post_id);
    end if;

    begin
      v_published_at := (v_post ->> 'published_at')::timestamptz;
    exception when others then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('post %s has invalid published_at', v_external_post_id);
    end;

    if v_published_at is null or v_published_at > p_collected_at then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('post %s has invalid published_at', v_external_post_id);
    end if;

    if v_post ? 'like_count' and pg_catalog.jsonb_typeof(v_post -> 'like_count') <> 'null' then
      if pg_catalog.jsonb_typeof(v_post -> 'like_count') <> 'number' then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format('post %s has invalid like_count', v_external_post_id);
      end if;
      v_like_count := (v_post ->> 'like_count')::bigint;
      if v_like_count < 0 then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format('post %s has invalid like_count', v_external_post_id);
      end if;
    else
      v_like_count := null;
    end if;

    if v_post ? 'comments_count'
      and pg_catalog.jsonb_typeof(v_post -> 'comments_count') <> 'null'
    then
      if pg_catalog.jsonb_typeof(v_post -> 'comments_count') <> 'number' then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format('post %s has invalid comments_count', v_external_post_id);
      end if;
      v_comments_count := (v_post ->> 'comments_count')::bigint;
      if v_comments_count < 0 then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format('post %s has invalid comments_count', v_external_post_id);
      end if;
    else
      v_comments_count := null;
    end if;

    if v_post ? 'view_count' and pg_catalog.jsonb_typeof(v_post -> 'view_count') <> 'null' then
      if pg_catalog.jsonb_typeof(v_post -> 'view_count') <> 'number' then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format('post %s has invalid view_count', v_external_post_id);
      end if;
      v_view_count := (v_post ->> 'view_count')::bigint;
      if v_view_count < 0 then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format('post %s has invalid view_count', v_external_post_id);
      end if;
    else
      v_view_count := null;
    end if;

    if v_post ? 'followers_count_at_collection'
      and pg_catalog.jsonb_typeof(v_post -> 'followers_count_at_collection') <> 'null'
    then
      if pg_catalog.jsonb_typeof(v_post -> 'followers_count_at_collection') <> 'number' then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format(
            'post %s has invalid followers_count_at_collection',
            v_external_post_id
          );
      end if;
      v_post_followers_count := (v_post ->> 'followers_count_at_collection')::bigint;
      if v_post_followers_count < 0 then
        raise exception using
          errcode = '22023',
          message = pg_catalog.format(
            'post %s has invalid followers_count_at_collection',
            v_external_post_id
          );
      end if;
    else
      v_post_followers_count := v_followers_count;
    end if;

    if not (v_post ? 'raw_payload')
      or pg_catalog.jsonb_typeof(v_post -> 'raw_payload') <> 'object'
    then
      raise exception using
        errcode = '22023',
        message = pg_catalog.format('post %s has invalid raw_payload', v_external_post_id);
    end if;

    v_post_age_minutes := pg_catalog.floor(
      extract(epoch from (p_collected_at - v_published_at)) / 60
    )::integer;

    select rp.id
    into v_raw_post_id
    from public.raw_posts as rp
    where rp.source_account_id = v_source_account_id
      and rp.external_post_id = v_external_post_id;

    if v_raw_post_id is null then
      insert into public.raw_posts (
        source_account_id,
        external_post_id,
        caption,
        permalink,
        media_type,
        media_product_type,
        published_at,
        collected_at,
        like_count,
        comments_count,
        view_count,
        followers_count_at_collection,
        raw_payload
      )
      values (
        v_source_account_id,
        v_external_post_id,
        v_post ->> 'caption',
        v_post ->> 'permalink',
        v_media_type,
        v_media_product_type,
        v_published_at,
        p_collected_at,
        v_like_count,
        v_comments_count,
        v_view_count,
        v_post_followers_count,
        v_post -> 'raw_payload'
      )
      returning id into v_raw_post_id;

      v_inserted_posts := v_inserted_posts + 1;
    else
      update public.raw_posts
      set
        caption = v_post ->> 'caption',
        permalink = v_post ->> 'permalink',
        media_type = v_media_type,
        media_product_type = v_media_product_type,
        published_at = v_published_at,
        collected_at = p_collected_at,
        like_count = v_like_count,
        comments_count = v_comments_count,
        view_count = v_view_count,
        followers_count_at_collection = v_post_followers_count,
        raw_payload = v_post -> 'raw_payload'
      where id = v_raw_post_id;

      v_updated_posts := v_updated_posts + 1;
    end if;

    if not exists (
      select 1
      from public.post_metric_snapshots as pms
      where pms.raw_post_id = v_raw_post_id
    ) then
      insert into public.post_metric_snapshots (
        raw_post_id,
        captured_at,
        followers_count,
        like_count,
        comments_count,
        view_count,
        post_age_minutes
      )
      values (
        v_raw_post_id,
        p_collected_at,
        v_post_followers_count,
        v_like_count,
        v_comments_count,
        v_view_count,
        v_post_age_minutes
      );

      v_inserted_snapshots := v_inserted_snapshots + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'account_id', v_instagram_account_id,
    'inserted_posts', v_inserted_posts,
    'updated_posts', v_updated_posts,
    'inserted_snapshots', v_inserted_snapshots
  );
end;
$$;

revoke all on function public.ingest_instagram_batch(text, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ingest_instagram_batch(text, jsonb, jsonb, timestamptz)
  to service_role;
