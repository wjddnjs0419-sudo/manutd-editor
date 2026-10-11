alter table app_private.discovery_observations
  add column google_news_original_url text,
  add column google_news_rss_excerpt text,
  add column google_news_article_id text,
  add column url_resolution_status text not null default 'NOT_APPLICABLE',
  add column resolved_publisher_url text,
  add column resolution_attempt_at timestamptz,
  add column resolved_at timestamptz,
  add column article_fetch_status text not null default 'NOT_ATTEMPTED',
  add column article_extraction_status text not null default 'NOT_ATTEMPTED',
  add column article_final_url text,
  add column article_content_excerpt text,
  add column safe_error_category text,
  add column resolver_lease_id uuid,
  add column resolver_lease_expires_at timestamptz,
  add column resolver_attempt_count integer not null default 0,
  add column resolver_next_attempt_at timestamptz not null default now();

create or replace function app_private.is_safe_gnews_publisher_url(p_url text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  authority text;
  hostname text;
begin
  if p_url is null or length(p_url) > 2000 then return false; end if;
  if p_url !~ '^https://[^/?#]+([/?#]|$)' then return false; end if;
  authority := substring(p_url from '^https://([^/?#]+)');
  if authority is null or authority = '' or authority like '%@%' then return false; end if;
  if authority like '%:%' and authority !~ ':[4][4][3]$' then return false; end if;
  hostname := lower(regexp_replace(authority, ':443$', ''));
  if hostname !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then return false; end if;
  if hostname ~ '^[0-9.]+$' or hostname = 'localhost' then return false; end if;
  if hostname ~ '\.(localhost|local|internal|invalid|test)$' then return false; end if;
  if hostname = 'google.com' or hostname ~ '\.google\.com$' or hostname ~ '^google\.'
    or hostname = 'googleusercontent.com' or hostname ~ '\.googleusercontent\.com$' then return false; end if;
  if hostname = 'youtu.be' or hostname = 'youtube.com' or hostname ~ '\.youtube\.com$' or hostname ~ '(^|\.)youtube-nocookie\.com$' then return false; end if;
  return true;
end
$function$;

create table app_private.gnews_article_url_cache (
  google_article_id text primary key,
  original_google_news_url text not null,
  resolved_publisher_url text not null,
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint gnews_article_url_cache_article_id_check check (google_article_id ~ '^[A-Za-z0-9_-]{1,2000}$'),
  constraint gnews_article_url_cache_publisher_url_check check (app_private.is_safe_gnews_publisher_url(resolved_publisher_url))
);

create table app_private.gnews_resolver_control (
  singleton boolean primary key default true check (singleton),
  global_cooldown_until timestamptz,
  updated_at timestamptz not null default now()
);
insert into app_private.gnews_resolver_control(singleton) values (true);

create table app_private.gnews_resolver_api_requests (
  idempotency_key text primary key,
  request_kind text not null check (request_kind in ('CLAIM', 'COMPLETE')),
  request_fingerprint text not null,
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  constraint gnews_resolver_api_requests_key_check check (length(idempotency_key) between 8 and 128)
);

create table app_private.gnews_resolver_api_rate_limits (
  worker_id text primary key,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now()
);

alter table app_private.gnews_article_url_cache enable row level security;
alter table app_private.gnews_resolver_control enable row level security;
alter table app_private.gnews_resolver_api_requests enable row level security;
alter table app_private.gnews_resolver_api_rate_limits enable row level security;
revoke all on table app_private.gnews_article_url_cache, app_private.gnews_resolver_control,
  app_private.gnews_resolver_api_requests, app_private.gnews_resolver_api_rate_limits
  from public, anon, authenticated;
grant select, insert, update, delete on table app_private.gnews_article_url_cache,
  app_private.gnews_resolver_control, app_private.gnews_resolver_api_requests,
  app_private.gnews_resolver_api_rate_limits to service_role;

-- Some earlier enrichers replaced canonical_url after a successful inline
-- resolution. Recover their Google URL from metadata and seed the durable cache.
insert into app_private.gnews_article_url_cache (
  google_article_id, original_google_news_url, resolved_publisher_url, resolved_at
)
select distinct on (substring(original_url from '^https://news[.]google[.]com/rss/articles/([A-Za-z0-9_-]{1,2000})'))
  substring(original_url from '^https://news[.]google[.]com/rss/articles/([A-Za-z0-9_-]{1,2000})'),
  original_url,
  canonical_url,
  coalesce(updated_at, now())
from (
  select id, provider_id, canonical_url, updated_at,
    coalesce(metadata->>'google_news_url', canonical_url) as original_url
  from app_private.discovery_observations
  where provider_id = 'google-news'
) existing
where original_url ~ '^https://news[.]google[.]com/rss/articles/[A-Za-z0-9_-]{1,2000}([/?#].*)?$'
  and canonical_url <> original_url
  and app_private.is_safe_gnews_publisher_url(canonical_url)
on conflict (google_article_id) do nothing;

update app_private.discovery_observations as observation
set google_news_original_url = coalesce(observation.metadata->>'google_news_url', observation.canonical_url),
    google_news_rss_excerpt = observation.excerpt,
    google_news_article_id = substring(
      coalesce(observation.metadata->>'google_news_url', observation.canonical_url)
      from '^https://news[.]google[.]com/rss/articles/([A-Za-z0-9_-]{1,2000})'
    ),
    resolved_publisher_url = coalesce((
      select cache.resolved_publisher_url
      from app_private.gnews_article_url_cache as cache
      where cache.google_article_id = substring(
        coalesce(observation.metadata->>'google_news_url', observation.canonical_url)
        from '^https://news[.]google[.]com/rss/articles/([A-Za-z0-9_-]{1,2000})'
      )
    ), observation.resolved_publisher_url),
    url_resolution_status = case
      when exists (
        select 1 from app_private.gnews_article_url_cache as cache
        where cache.google_article_id = substring(
          coalesce(observation.metadata->>'google_news_url', observation.canonical_url)
          from '^https://news[.]google[.]com/rss/articles/([A-Za-z0-9_-]{1,2000})'
        )
      ) then 'RESOLVED'
      when coalesce(observation.metadata->>'google_news_url', observation.canonical_url)
        ~ '^https://news[.]google[.]com/rss/articles/[A-Za-z0-9_-]{1,2000}([/?#].*)?$' then 'PENDING'
      else 'EXCLUDED'
    end,
    resolved_at = coalesce(observation.resolved_at, (
      select cache.resolved_at
      from app_private.gnews_article_url_cache as cache
      where cache.google_article_id = substring(
        coalesce(observation.metadata->>'google_news_url', observation.canonical_url)
        from '^https://news[.]google[.]com/rss/articles/([A-Za-z0-9_-]{1,2000})'
      )
    )),
    safe_error_category = case
      when exists (
        select 1 from app_private.gnews_article_url_cache as cache
        where cache.google_article_id = substring(
          coalesce(observation.metadata->>'google_news_url', observation.canonical_url)
          from '^https://news[.]google[.]com/rss/articles/([A-Za-z0-9_-]{1,2000})'
        )
      ) then null
      when coalesce(observation.metadata->>'google_news_url', observation.canonical_url)
        ~ '^https://news[.]google[.]com/rss/articles/[A-Za-z0-9_-]{1,2000}([/?#].*)?$' then null
      else 'INVALID_GOOGLE_NEWS_URL'
    end
where observation.provider_id = 'google-news';

create or replace function app_private.capture_gnews_source_identity()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  original_url text;
  article_id text;
begin
  if new.provider_id <> 'google-news' then
    new.url_resolution_status := 'NOT_APPLICABLE';
    new.google_news_original_url := null;
    new.google_news_article_id := null;
    new.google_news_rss_excerpt := null;
    return new;
  end if;
  original_url := coalesce(new.google_news_original_url, new.metadata->>'google_news_url', new.canonical_url);
  article_id := substring(original_url from '^https://news[.]google[.]com/rss/articles/([A-Za-z0-9_-]{1,2000})');
  new.google_news_original_url := original_url;
  new.google_news_article_id := coalesce(new.google_news_article_id, article_id);
  new.google_news_rss_excerpt := coalesce(new.google_news_rss_excerpt, new.excerpt);
  if new.url_resolution_status = 'NOT_APPLICABLE' then
    new.url_resolution_status := case when article_id is null then 'EXCLUDED' else 'PENDING' end;
  end if;
  if article_id is null and new.safe_error_category is null then
    new.safe_error_category := 'INVALID_GOOGLE_NEWS_URL';
  end if;
  return new;
end
$function$;

create trigger discovery_observations_capture_gnews_source
before insert or update of provider_id, canonical_url, excerpt, metadata, google_news_original_url
on app_private.discovery_observations
for each row execute function app_private.capture_gnews_source_identity();

alter table app_private.discovery_observations
  add constraint discovery_observations_gnews_status_check
    check (url_resolution_status in ('NOT_APPLICABLE', 'PENDING', 'CLAIMED', 'RESOLVED', 'FAILED', 'RATE_LIMITED', 'EXCLUDED')),
  add constraint discovery_observations_gnews_fetch_status_check
    check (article_fetch_status in ('NOT_ATTEMPTED', 'FETCHED', 'FAILED', 'ACCESS_RESTRICTED', 'BODY_TOO_LARGE', 'RATE_LIMITED', 'UNSUPPORTED_CONTENT', 'REDIRECT_REJECTED')),
  add constraint discovery_observations_gnews_extraction_status_check
    check (article_extraction_status in ('NOT_ATTEMPTED', 'EXTRACTED', 'EMPTY_BODY', 'TITLE_NOT_RELEVANT')),
  add constraint discovery_observations_gnews_id_check
    check (google_news_article_id is null or google_news_article_id ~ '^[A-Za-z0-9_-]{1,2000}$'),
  add constraint discovery_observations_gnews_publisher_url_check
    check (resolved_publisher_url is null or app_private.is_safe_gnews_publisher_url(resolved_publisher_url)),
  add constraint discovery_observations_gnews_final_url_check
    check (article_final_url is null or app_private.is_safe_gnews_publisher_url(article_final_url)),
  add constraint discovery_observations_gnews_excerpt_check
    check (article_content_excerpt is null or length(article_content_excerpt) <= 2000),
  add constraint discovery_observations_gnews_extracted_body_check
    check ((article_extraction_status = 'EXTRACTED') = (article_content_excerpt is not null and length(btrim(article_content_excerpt)) > 0)),
  add constraint discovery_observations_gnews_error_check
    check (safe_error_category is null or safe_error_category in (
      'GOOGLE_HTTP_429', 'GOOGLE_DECODER_FAILURE', 'INVALID_GOOGLE_NEWS_URL',
      'INVALID_PUBLISHER_URL', 'NON_ARTICLE_VIDEO', 'PUBLISHER_HTTP_403',
      'PUBLISHER_HTTP_429', 'PUBLISHER_PAYWALL', 'PUBLISHER_BODY_TOO_LARGE',
      'TITLE_NOT_RELEVANT', 'NO_ARTICLE_BODY', 'UNSUPPORTED_CONTENT_TYPE',
      'PUBLISHER_REDIRECT_REJECTED', 'PUBLISHER_NETWORK_ERROR', 'PUBLISHER_HTTP_ERROR',
      'PUBLISHER_HTTP_401', 'PUBLISHER_HTTP_402', 'PUBLISHER_HTTP_407', 'PUBLISHER_HTTP_451',
      'WORKER_LEASE_EXPIRED', 'WORKER_ATTEMPT_LIMIT'
    )),
  add constraint discovery_observations_gnews_attempt_count_check
    check (resolver_attempt_count between 0 and 3),
  add constraint discovery_observations_gnews_lease_check
    check ((resolver_lease_id is null) = (resolver_lease_expires_at is null));

create index discovery_observations_gnews_pending_idx
  on app_private.discovery_observations (resolver_next_attempt_at, first_observed_at, id)
  where provider_id = 'google-news'
    and url_resolution_status in ('PENDING', 'FAILED', 'RATE_LIMITED');
create index discovery_observations_gnews_article_id_idx
  on app_private.discovery_observations (google_news_article_id, url_resolution_status)
  where google_news_article_id is not null;

create or replace function app_private.gnews_resolver_claim_batch(
  p_request_id text,
  p_batch_size integer,
  p_worker_id text
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  request_row app_private.gnews_resolver_api_requests%rowtype;
  request_payload jsonb;
  request_fingerprint text;
  request_count integer;
  current_minute timestamptz := date_trunc('minute', now());
  cooldown_until timestamptz;
  lease_id uuid;
  lease_expires_at timestamptz;
  claimed_items jsonb;
  response_payload jsonb;
begin
  if p_request_id is null or length(p_request_id) not between 8 and 128
    or p_request_id !~ '^[A-Za-z0-9:._-]+$'
    or p_batch_size is null or p_batch_size not between 1 and 30
    or p_worker_id is distinct from 'github-actions' then
    raise exception 'invalid resolver claim request' using errcode = '22023';
  end if;
  request_payload := jsonb_build_object('batch_size', p_batch_size, 'worker_id', p_worker_id);
  request_fingerprint := md5(request_payload::text);
  select * into request_row from app_private.gnews_resolver_api_requests
    where idempotency_key = p_request_id;
  if found then
    if request_row.request_kind <> 'CLAIM' or request_row.request_fingerprint <> request_fingerprint then
      return jsonb_build_object('status', 'IDEMPOTENCY_CONFLICT');
    end if;
    return request_row.response;
  end if;

  insert into app_private.gnews_resolver_api_rate_limits(worker_id, window_started_at, request_count)
  values (p_worker_id, current_minute, 1)
  on conflict (worker_id) do update set
    window_started_at = excluded.window_started_at,
    request_count = case when app_private.gnews_resolver_api_rate_limits.window_started_at = excluded.window_started_at
      then app_private.gnews_resolver_api_rate_limits.request_count + 1 else 1 end,
    updated_at = now()
  returning request_count into request_count;
  if request_count > 10 then
    return jsonb_build_object('rate_limited', true, 'retry_after_seconds', 60);
  end if;

  select global_cooldown_until into cooldown_until
  from app_private.gnews_resolver_control where singleton = true for update;
  if cooldown_until is not null and cooldown_until > now() then
    response_payload := jsonb_build_object('lease_id', null, 'lease_expires_at', null,
      'items', '[]'::jsonb, 'cooldown_until', cooldown_until);
  else
    update app_private.discovery_observations as observation
    set resolved_publisher_url = cache.resolved_publisher_url,
        url_resolution_status = 'RESOLVED',
        resolved_at = cache.resolved_at,
        resolver_lease_id = null,
        resolver_lease_expires_at = null,
        safe_error_category = null
    from app_private.gnews_article_url_cache as cache
    where observation.provider_id = 'google-news'
      and observation.google_news_article_id = cache.google_article_id
      and observation.url_resolution_status in ('PENDING', 'FAILED', 'RATE_LIMITED');

    update app_private.discovery_observations
    set url_resolution_status = case when resolver_attempt_count >= 3 then 'FAILED' else 'PENDING' end,
        resolver_lease_id = null,
        resolver_lease_expires_at = null,
        resolver_next_attempt_at = case when resolver_attempt_count >= 3 then 'infinity'::timestamptz else now() end,
        safe_error_category = 'WORKER_LEASE_EXPIRED'
    where provider_id = 'google-news'
      and url_resolution_status = 'CLAIMED'
      and resolver_lease_expires_at <= now();

    lease_id := gen_random_uuid();
    lease_expires_at := now() + interval '20 minutes';
    with eligible as (
      select distinct on (observation.google_news_article_id)
        observation.id, observation.google_news_article_id, observation.first_observed_at
      from app_private.discovery_observations as observation
      where observation.provider_id = 'google-news'
        and observation.platform = 'RSS'
        and observation.url_resolution_status in ('PENDING', 'FAILED', 'RATE_LIMITED')
        and observation.google_news_article_id is not null
        and observation.google_news_original_url ~ '^https://news[.]google[.]com/rss/articles/[A-Za-z0-9_-]{1,2000}([/?#].*)?$'
        and observation.resolver_attempt_count < 3
        and observation.resolver_next_attempt_at <= now()
        and (observation.resolver_lease_expires_at is null or observation.resolver_lease_expires_at <= now())
        and not exists (select 1 from app_private.gnews_article_url_cache as cache
          where cache.google_article_id = observation.google_news_article_id)
      order by observation.google_news_article_id, observation.first_observed_at, observation.id
    ), locked as (
      select observation.id
      from app_private.discovery_observations as observation
      join eligible on eligible.id = observation.id
      order by observation.first_observed_at, observation.id
      for update of observation skip locked
      limit p_batch_size
    ), claimed as (
      update app_private.discovery_observations as observation
      set url_resolution_status = 'CLAIMED',
          resolver_lease_id = lease_id,
          resolver_lease_expires_at = lease_expires_at,
          resolver_attempt_count = resolver_attempt_count + 1,
          resolution_attempt_at = now(),
          safe_error_category = null
      from locked
      where observation.id = locked.id
      returning observation.id, observation.google_news_article_id,
        observation.google_news_original_url, left(observation.title, 500) as title,
        left(observation.source_canonical_name, 160) as source_canonical_name,
        observation.published_at
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'google_article_id', google_news_article_id,
      'original_google_news_url', google_news_original_url,
      'title', title,
      'source_canonical_name', source_canonical_name,
      'published_at', published_at
    ) order by id), '[]'::jsonb) into claimed_items from claimed;
    response_payload := jsonb_build_object('lease_id', case when jsonb_array_length(claimed_items) = 0 then null else lease_id end,
      'lease_expires_at', case when jsonb_array_length(claimed_items) = 0 then null else lease_expires_at end,
      'items', claimed_items, 'cooldown_until', null);
  end if;

  insert into app_private.gnews_resolver_api_requests(idempotency_key, request_kind, request_fingerprint, response)
  values (p_request_id, 'CLAIM', request_fingerprint, response_payload);
  return response_payload;
end
$function$;

create or replace function app_private.gnews_resolver_complete_batch(
  p_request_id text,
  p_worker_id text,
  p_lease_id uuid,
  p_results jsonb,
  p_unprocessed_ids jsonb,
  p_global_cooldown_seconds integer
)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  request_row app_private.gnews_resolver_api_requests%rowtype;
  request_payload jsonb;
  request_fingerprint text;
  request_count integer;
  current_minute timestamptz := date_trunc('minute', now());
  cooldown_until timestamptz;
  result_row jsonb;
  observation_row app_private.discovery_observations%rowtype;
  publisher_url text;
  next_attempt timestamptz;
  result_count integer;
  unprocessed_count integer;
  response_payload jsonb;
  rate_limited boolean;
begin
  if p_request_id is null or length(p_request_id) not between 8 and 128
    or p_request_id !~ '^[A-Za-z0-9:._-]+$'
    or p_worker_id is distinct from 'github-actions'
    or p_lease_id is null
    or p_results is null or jsonb_typeof(p_results) is distinct from 'array' or jsonb_array_length(p_results) > 30
    or p_unprocessed_ids is null or jsonb_typeof(p_unprocessed_ids) is distinct from 'array' or jsonb_array_length(p_unprocessed_ids) > 30
    or p_global_cooldown_seconds is null or p_global_cooldown_seconds not between 0 and 21600 then
    raise exception 'invalid resolver completion request' using errcode = '22023';
  end if;
  result_count := jsonb_array_length(p_results);
  unprocessed_count := jsonb_array_length(p_unprocessed_ids);
  if exists (select 1 from jsonb_array_elements(p_results) as items(item)
      where jsonb_typeof(item) is distinct from 'object'
        or item->>'id' is null or item->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or exists (select 1 from jsonb_array_elements(p_unprocessed_ids) as items(item)
      where jsonb_typeof(item) is distinct from 'string'
        or item #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (select count(distinct item->>'id') from jsonb_array_elements(p_results) as items(item)) <> result_count
    or (select count(distinct item #>> '{}') from jsonb_array_elements(p_unprocessed_ids) as items(item)) <> unprocessed_count
    or exists (select 1 from jsonb_array_elements(p_results) as results(item)
      join jsonb_array_elements_text(p_unprocessed_ids) as pending(id) on pending.id = results.item->>'id') then
    raise exception 'duplicate resolver result identity' using errcode = '22023';
  end if;
  rate_limited := exists (select 1 from jsonb_array_elements(p_results) as items(item)
    where (item->>'url_resolution_status' = 'RATE_LIMITED' and item->>'safe_error_category' = 'GOOGLE_HTTP_429')
      or (item->>'article_fetch_status' = 'RATE_LIMITED' and item->>'safe_error_category' = 'PUBLISHER_HTTP_429'));
  if rate_limited <> (p_global_cooldown_seconds >= 60) then
    raise exception 'invalid resolver cooldown state' using errcode = '22023';
  end if;

  request_payload := jsonb_build_object('lease_id', p_lease_id, 'results', p_results,
    'unprocessed_ids', p_unprocessed_ids, 'global_cooldown_seconds', p_global_cooldown_seconds,
    'worker_id', p_worker_id);
  request_fingerprint := md5(request_payload::text);
  select * into request_row from app_private.gnews_resolver_api_requests
    where idempotency_key = p_request_id;
  if found then
    if request_row.request_kind <> 'COMPLETE' or request_row.request_fingerprint <> request_fingerprint then
      return jsonb_build_object('status', 'IDEMPOTENCY_CONFLICT');
    end if;
    return request_row.response;
  end if;

  insert into app_private.gnews_resolver_api_rate_limits(worker_id, window_started_at, request_count)
  values (p_worker_id, current_minute, 1)
  on conflict (worker_id) do update set
    window_started_at = excluded.window_started_at,
    request_count = case when app_private.gnews_resolver_api_rate_limits.window_started_at = excluded.window_started_at
      then app_private.gnews_resolver_api_rate_limits.request_count + 1 else 1 end,
    updated_at = now()
  returning request_count into request_count;
  if request_count > 10 then
    return jsonb_build_object('rate_limited', true, 'retry_after_seconds', 60);
  end if;

  if exists (
    select 1 from (
      select (item->>'id')::uuid as id from jsonb_array_elements(p_results) as items(item)
      union all
      select value::uuid from jsonb_array_elements_text(p_unprocessed_ids) as items(value)
    ) as submitted
    left join app_private.discovery_observations as observation
      on observation.id = submitted.id
      and observation.resolver_lease_id = p_lease_id
      and observation.resolver_lease_expires_at > now()
    where observation.id is null
  ) then
    return jsonb_build_object('status', 'LEASE_EXPIRED');
  end if;

  for result_row in select item from jsonb_array_elements(p_results) as items(item) loop
    if result_row->>'url_resolution_status' is null
      or result_row->>'url_resolution_status' not in ('RESOLVED', 'FAILED', 'RATE_LIMITED', 'EXCLUDED')
      or result_row->>'article_fetch_status' is null
      or result_row->>'article_fetch_status' not in ('NOT_ATTEMPTED', 'FETCHED', 'FAILED', 'ACCESS_RESTRICTED', 'BODY_TOO_LARGE', 'RATE_LIMITED', 'UNSUPPORTED_CONTENT', 'REDIRECT_REJECTED')
      or result_row->>'article_extraction_status' is null
      or result_row->>'article_extraction_status' not in ('NOT_ATTEMPTED', 'EXTRACTED', 'EMPTY_BODY', 'TITLE_NOT_RELEVANT')
      or (result_row->>'safe_error_category' is not null and result_row->>'safe_error_category' not in (
        'GOOGLE_HTTP_429', 'GOOGLE_DECODER_FAILURE', 'INVALID_GOOGLE_NEWS_URL', 'INVALID_PUBLISHER_URL',
        'NON_ARTICLE_VIDEO', 'PUBLISHER_HTTP_403', 'PUBLISHER_HTTP_429', 'PUBLISHER_PAYWALL',
        'PUBLISHER_BODY_TOO_LARGE', 'TITLE_NOT_RELEVANT', 'NO_ARTICLE_BODY', 'UNSUPPORTED_CONTENT_TYPE',
        'PUBLISHER_REDIRECT_REJECTED', 'PUBLISHER_NETWORK_ERROR', 'PUBLISHER_HTTP_ERROR',
        'PUBLISHER_HTTP_401', 'PUBLISHER_HTTP_402', 'PUBLISHER_HTTP_407', 'PUBLISHER_HTTP_451',
        'WORKER_LEASE_EXPIRED', 'WORKER_ATTEMPT_LIMIT'
      )) then
      raise exception 'invalid resolver result status' using errcode = '22023';
    end if;
    publisher_url := result_row->>'resolved_publisher_url';
    if result_row->>'url_resolution_status' = 'RESOLVED' then
      if not app_private.is_safe_gnews_publisher_url(publisher_url) then
        raise exception 'unsafe publisher URL' using errcode = '22023';
      end if;
    elsif publisher_url is not null then
      raise exception 'publisher URL without successful resolution' using errcode = '22023';
    end if;
    if result_row->>'article_final_url' is not null and not app_private.is_safe_gnews_publisher_url(result_row->>'article_final_url') then
      raise exception 'unsafe article final URL' using errcode = '22023';
    end if;
    if result_row->>'article_extraction_status' = 'EXTRACTED'
      and (coalesce(result_row->>'article_content_excerpt', '') = '' or length(result_row->>'article_content_excerpt') > 2000) then
      raise exception 'invalid extracted article excerpt' using errcode = '22023';
    end if;
    if result_row->>'article_extraction_status' <> 'EXTRACTED' and result_row->>'article_content_excerpt' is not null then
      raise exception 'excerpt requires successful extraction' using errcode = '22023';
    end if;
    if result_row->>'url_resolution_status' <> 'RESOLVED'
      and (result_row->>'article_fetch_status' <> 'NOT_ATTEMPTED'
        or result_row->>'article_extraction_status' <> 'NOT_ATTEMPTED'
        or result_row->>'article_content_excerpt' is not null
        or result_row->>'article_final_url' is not null) then
      raise exception 'article fetch requires resolved URL' using errcode = '22023';
    end if;

    select * into observation_row from app_private.discovery_observations
      where id = (result_row->>'id')::uuid for update;
    if result_row->>'url_resolution_status' = 'RESOLVED' then
      insert into app_private.gnews_article_url_cache(
        google_article_id, original_google_news_url, resolved_publisher_url, resolved_at
      ) values (
        observation_row.google_news_article_id,
        observation_row.google_news_original_url,
        publisher_url,
        now()
      ) on conflict (google_article_id) do nothing;
      select resolved_publisher_url into publisher_url from app_private.gnews_article_url_cache
        where google_article_id = observation_row.google_news_article_id;
      if publisher_url is distinct from result_row->>'resolved_publisher_url' then
        raise exception 'resolver cache conflict' using errcode = '23505';
      end if;
    end if;
    next_attempt := case
      when observation_row.resolver_attempt_count >= 3 then 'infinity'::timestamptz
      when result_row->>'url_resolution_status' = 'FAILED' and observation_row.resolver_attempt_count = 1 then now() + interval '30 minutes'
      when result_row->>'url_resolution_status' = 'FAILED' and observation_row.resolver_attempt_count = 2 then now() + interval '2 hours'
      when result_row->>'url_resolution_status' in ('FAILED', 'EXCLUDED') then 'infinity'::timestamptz
      when result_row->>'url_resolution_status' = 'RATE_LIMITED' then now() + make_interval(secs => greatest(60, p_global_cooldown_seconds))
      else now()
    end;
    update app_private.discovery_observations set
      url_resolution_status = case
        when observation_row.resolver_attempt_count >= 3 and result_row->>'url_resolution_status' = 'RATE_LIMITED' then 'FAILED'
        else result_row->>'url_resolution_status'
      end,
      resolved_publisher_url = case when result_row->>'url_resolution_status' = 'RESOLVED' then result_row->>'resolved_publisher_url' else null end,
      resolved_at = case when result_row->>'url_resolution_status' = 'RESOLVED' then coalesce(resolved_at, now()) else resolved_at end,
      article_fetch_status = result_row->>'article_fetch_status',
      article_extraction_status = result_row->>'article_extraction_status',
      article_final_url = result_row->>'article_final_url',
      article_content_excerpt = result_row->>'article_content_excerpt',
      safe_error_category = result_row->>'safe_error_category',
      resolver_lease_id = null,
      resolver_lease_expires_at = null,
      resolver_next_attempt_at = next_attempt
    where id = observation_row.id;
  end loop;

  update app_private.discovery_observations as observation
  set url_resolution_status = case when observation.resolver_attempt_count >= 3 then 'FAILED' else 'PENDING' end,
      resolver_lease_id = null,
      resolver_lease_expires_at = null,
      resolver_next_attempt_at = case when observation.resolver_attempt_count >= 3 then 'infinity'::timestamptz
        when p_global_cooldown_seconds >= 60 then now() + make_interval(secs => p_global_cooldown_seconds) else now() end,
      safe_error_category = case when observation.resolver_attempt_count >= 3 then 'WORKER_ATTEMPT_LIMIT' else null end
  where observation.id in (select value::uuid from jsonb_array_elements_text(p_unprocessed_ids) as items(value))
    and observation.resolver_lease_id = p_lease_id;

  if p_global_cooldown_seconds >= 60 then
    update app_private.gnews_resolver_control set
      global_cooldown_until = greatest(coalesce(global_cooldown_until, now()), now() + make_interval(secs => p_global_cooldown_seconds)),
      updated_at = now()
    where singleton = true;
  end if;
  select global_cooldown_until into cooldown_until from app_private.gnews_resolver_control where singleton = true;
  response_payload := jsonb_build_object('status', 'COMPLETED', 'accepted_results', result_count,
    'unprocessed_count', unprocessed_count, 'cooldown_until', cooldown_until);
  insert into app_private.gnews_resolver_api_requests(idempotency_key, request_kind, request_fingerprint, response)
  values (p_request_id, 'COMPLETE', request_fingerprint, response_payload);
  return response_payload;
end
$function$;

revoke all on function app_private.is_safe_gnews_publisher_url(text) from public, anon, authenticated;
revoke all on function app_private.capture_gnews_source_identity() from public, anon, authenticated;
revoke all on function app_private.gnews_resolver_claim_batch(text, integer, text) from public, anon, authenticated;
revoke all on function app_private.gnews_resolver_complete_batch(text, text, uuid, jsonb, jsonb, integer) from public, anon, authenticated;
grant execute on function app_private.gnews_resolver_claim_batch(text, integer, text) to service_role;
grant execute on function app_private.gnews_resolver_complete_batch(text, text, uuid, jsonb, jsonb, integer) to service_role;
