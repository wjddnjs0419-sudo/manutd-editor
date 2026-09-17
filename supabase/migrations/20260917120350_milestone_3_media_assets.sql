create function public.prepare_instagram_media_assets(
  p_source_account_id uuid,
  p_assets jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_asset jsonb;
  v_raw_post_id uuid;
  v_external_media_id text;
  v_asset_type text;
  v_carousel_index integer;
  v_original_media_url text;
  v_media_asset_id uuid;
  v_prepared_ids uuid[] := '{}'::uuid[];
  v_pending jsonb;
begin
  if p_source_account_id is null then
    raise exception using errcode = '22023', message = 'source_account_id is required';
  end if;
  if p_assets is null or pg_catalog.jsonb_typeof(p_assets) <> 'array' then
    raise exception using errcode = '22023', message = 'media assets payload must be an array';
  end if;

  perform 1
  from public.source_accounts as sa
  where sa.id = p_source_account_id and sa.active;
  if not found then
    raise exception using errcode = 'P0002', message = 'active source account was not found';
  end if;

  for v_asset in
    select item.value
    from pg_catalog.jsonb_array_elements(p_assets) as item(value)
  loop
    if pg_catalog.jsonb_typeof(v_asset) <> 'object' then
      raise exception using errcode = '22023', message = 'each media asset must be an object';
    end if;

    begin
      v_raw_post_id := (v_asset ->> 'raw_post_id')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'media asset has invalid raw_post_id';
    end;
    if v_raw_post_id is null or not exists (
      select 1
      from public.raw_posts as rp
      where rp.id = v_raw_post_id
        and rp.source_account_id = p_source_account_id
    ) then
      raise exception using
        errcode = '22023',
        message = 'media asset raw post is not owned by source account';
    end if;

    v_external_media_id := pg_catalog.btrim(v_asset ->> 'external_media_id');
    if v_external_media_id is null or v_external_media_id = '' then
      raise exception using
        errcode = '22023',
        message = 'media asset external_media_id is required';
    end if;

    v_asset_type := v_asset ->> 'asset_type';
    if v_asset_type is null or v_asset_type not in ('IMAGE', 'CAROUSEL_CHILD', 'THUMBNAIL') then
      raise exception using
        errcode = '22023',
        message = 'media asset has unsupported asset_type';
    end if;

    if v_asset ? 'carousel_index'
      and pg_catalog.jsonb_typeof(v_asset -> 'carousel_index') <> 'null'
    then
      begin
        if pg_catalog.jsonb_typeof(v_asset -> 'carousel_index') <> 'number' then
          raise exception using errcode = '22023';
        end if;
        v_carousel_index := (v_asset ->> 'carousel_index')::integer;
      exception when others then
        raise exception using
          errcode = '22023',
          message = 'media asset has invalid carousel_index';
      end;
    else
      v_carousel_index := null;
    end if;
    if v_carousel_index < 0
      or (v_asset_type = 'CAROUSEL_CHILD' and v_carousel_index is null)
      or (v_asset_type <> 'CAROUSEL_CHILD' and v_carousel_index is not null)
    then
      raise exception using
        errcode = '22023',
        message = 'media asset has invalid carousel_index';
    end if;

    v_original_media_url := v_asset ->> 'original_media_url';
    if v_original_media_url is null
      or v_original_media_url !~ '^https://[^[:space:]]+$'
    then
      raise exception using
        errcode = '22023',
        message = 'media asset original_media_url must use HTTPS';
    end if;

    insert into public.media_assets (
      raw_post_id,
      external_media_id,
      asset_type,
      carousel_index,
      original_media_url
    )
    values (
      v_raw_post_id,
      v_external_media_id,
      v_asset_type::public.media_asset_type,
      v_carousel_index,
      v_original_media_url
    )
    on conflict on constraint media_assets_raw_external_key do update
    set
      asset_type = excluded.asset_type,
      carousel_index = excluded.carousel_index,
      original_media_url = excluded.original_media_url
    returning id into v_media_asset_id;

    v_prepared_ids := pg_catalog.array_append(v_prepared_ids, v_media_asset_id);
  end loop;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'media_asset_id', ma.id,
        'raw_post_id', ma.raw_post_id,
        'external_media_id', ma.external_media_id,
        'asset_type', ma.asset_type,
        'carousel_index', ma.carousel_index,
        'original_media_url', ma.original_media_url
      ) order by ma.created_at, ma.id
    ),
    '[]'::jsonb
  )
  into v_pending
  from public.media_assets as ma
  where ma.id = any(v_prepared_ids)
    and ma.storage_path is null;

  return pg_catalog.jsonb_build_object('pending', v_pending);
end;
$$;

revoke all on function public.prepare_instagram_media_assets(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.prepare_instagram_media_assets(uuid, jsonb)
  to service_role;

create function public.finalize_instagram_media_assets(
  p_source_account_id uuid,
  p_assets jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_asset jsonb;
  v_media_asset_id uuid;
  v_storage_path text;
  v_mime_type text;
  v_fetched_at timestamptz;
  v_finalized integer := 0;
begin
  if p_source_account_id is null then
    raise exception using errcode = '22023', message = 'source_account_id is required';
  end if;
  if p_assets is null or pg_catalog.jsonb_typeof(p_assets) <> 'array' then
    raise exception using errcode = '22023', message = 'finalized assets payload must be an array';
  end if;

  perform 1
  from public.source_accounts as sa
  where sa.id = p_source_account_id and sa.active;
  if not found then
    raise exception using errcode = 'P0002', message = 'active source account was not found';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_assets) as item(value)
    group by item.value ->> 'media_asset_id'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'finalized assets contain duplicate IDs';
  end if;

  for v_asset in
    select item.value
    from pg_catalog.jsonb_array_elements(p_assets) as item(value)
  loop
    if pg_catalog.jsonb_typeof(v_asset) <> 'object' then
      raise exception using errcode = '22023', message = 'each finalized asset must be an object';
    end if;

    begin
      v_media_asset_id := (v_asset ->> 'media_asset_id')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'finalized asset has invalid ID';
    end;
    if v_media_asset_id is null or not exists (
      select 1
      from public.media_assets as ma
      join public.raw_posts as rp on rp.id = ma.raw_post_id
      where ma.id = v_media_asset_id
        and rp.source_account_id = p_source_account_id
    ) then
      raise exception using
        errcode = '22023',
        message = 'media asset is not owned by source account';
    end if;

    v_storage_path := pg_catalog.btrim(v_asset ->> 'storage_path');
    if v_storage_path is null or v_storage_path = '' then
      raise exception using errcode = '22023', message = 'storage_path is required';
    end if;

    v_mime_type := v_asset ->> 'mime_type';
    if v_mime_type is null or v_mime_type not in (
      'image/jpeg', 'image/png', 'image/webp', 'image/gif'
    ) then
      raise exception using errcode = '22023', message = 'mime_type is unsupported';
    end if;

    begin
      v_fetched_at := (v_asset ->> 'fetched_at')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'fetched_at is invalid';
    end;
    if v_fetched_at is null then
      raise exception using errcode = '22023', message = 'fetched_at is invalid';
    end if;

    update public.media_assets
    set
      storage_path = v_storage_path,
      mime_type = v_mime_type,
      fetched_at = v_fetched_at,
      retention_until = v_fetched_at + interval '30 days'
    where id = v_media_asset_id;

    v_finalized := v_finalized + 1;
  end loop;

  return pg_catalog.jsonb_build_object('finalized', v_finalized);
end;
$$;

revoke all on function public.finalize_instagram_media_assets(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_instagram_media_assets(uuid, jsonb)
  to service_role;
