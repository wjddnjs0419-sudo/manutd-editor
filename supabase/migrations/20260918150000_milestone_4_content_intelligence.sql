alter table public.story_clusters
  add column signature_json jsonb not null default '{}'::jsonb,
  add column signature_version text not null default 'entity-v1',
  add constraint story_clusters_signature_object check (jsonb_typeof(signature_json) = 'object'),
  add constraint story_clusters_signature_version_not_blank check (btrim(signature_version) <> '');

alter table public.content_candidates
  add column score_version text not null default 'v1',
  add column korea_coverage_status text not null default 'UNCERTAIN',
  add constraint content_candidates_score_version_not_blank check (btrim(score_version) <> ''),
  add constraint content_candidates_korea_coverage_status check (korea_coverage_status in ('KNOWN', 'UNCERTAIN'));

create table app_private.story_cluster_evaluations (
  id uuid primary key default extensions.uuid_generate_v4(),
  raw_post_id uuid not null references public.raw_posts(id) on delete cascade,
  candidate_cluster_id uuid not null references public.story_clusters(id) on delete cascade,
  deterministic_score numeric(5,4),
  decision text not null check (decision in ('SAME_STORY', 'DIFFERENT_STORY', 'MANUAL_REVIEW', 'ERROR')),
  same_story boolean,
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  reason text,
  model text,
  prompt_version text,
  dictionary_version text,
  classifier_version text not null,
  input_hash text not null,
  input_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(input_snapshot) = 'object'),
  result jsonb,
  evaluated_at timestamptz not null default now(),
  review_status text not null default 'PENDING' check (review_status in ('PENDING', 'RESOLVED', 'DISMISSED')),
  resolved_cluster_id uuid references public.story_clusters(id) on delete set null,
  resolved_at timestamptz,
  unique (raw_post_id, candidate_cluster_id, classifier_version, input_hash)
);

create table app_private.intelligence_run_lock (
  lock_name text primary key check (lock_name = 'story-intelligence'),
  run_id uuid,
  acquired_at timestamptz,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  check ((run_id is null) = (acquired_at is null)),
  check ((run_id is null) = (lease_until is null))
);

alter table app_private.story_cluster_evaluations enable row level security;
alter table app_private.intelligence_run_lock enable row level security;
revoke all on table app_private.story_cluster_evaluations, app_private.intelligence_run_lock from public, anon, authenticated;
grant select, insert, update, delete on table app_private.story_cluster_evaluations, app_private.intelligence_run_lock to service_role;

create or replace function app_private.m4_age_bucket(p_published_at timestamptz, p_run_at timestamptz)
returns text language sql stable security invoker set search_path = '' as $$
  select case
    when p_published_at > p_run_at or p_published_at <= p_run_at - interval '24 hours' then null
    when p_published_at > p_run_at - interval '60 minutes' then '0-60'
    when p_published_at > p_run_at - interval '180 minutes' then '60-180'
    when p_published_at > p_run_at - interval '360 minutes' then '180-360'
    when p_published_at > p_run_at - interval '720 minutes' then '360-720'
    else '720-1440'
  end
$$;

create or replace function app_private.m4_score_snapshots(p_raw_post_id uuid, p_run_at timestamptz, p_scoring_config_id uuid)
returns table(slot text, captured_at timestamptz, followers_count bigint, like_count bigint, comments_count bigint, engagement_rate numeric)
language sql stable security invoker set search_path = '' as $$
  with config as (select (config ->> 'comment_multiplier')::numeric multiplier from public.scoring_configs where id = p_scoring_config_id),
  s0 as (select * from public.post_metric_snapshots where raw_post_id = p_raw_post_id and captured_at <= p_run_at order by captured_at desc limit 1),
  s1 as (select p.* from public.post_metric_snapshots p, s0 where p.raw_post_id = p_raw_post_id and p.captured_at <= s0.captured_at - interval '30 minutes' order by p.captured_at desc limit 1),
  s2 as (select p.* from public.post_metric_snapshots p, s1 where p.raw_post_id = p_raw_post_id and p.captured_at <= s1.captured_at - interval '30 minutes' order by p.captured_at desc limit 1),
  picked as (select 's0'::text slot, * from s0 union all select 's1', * from s1 union all select 's2', * from s2),
  complete as (select count(*) n from picked)
  select p.slot, p.captured_at, p.followers_count, p.like_count, p.comments_count,
    case when p.followers_count > 0 and p.like_count is not null and p.comments_count is not null then (p.like_count + c.multiplier * p.comments_count) / p.followers_count else null end
  from picked p cross join config c cross join complete
  where complete.n = 3
  order by case p.slot when 's0' then 0 when 's1' then 1 else 2 end
$$;

create or replace function app_private.m4_baseline(p_evaluated_raw_post_id uuid, p_cluster_id uuid, p_cluster_member_ids uuid[], p_run_at timestamptz, p_scoring_config_id uuid)
returns table(baseline_er numeric, sample_count integer, fallback_level text, excluded_post_ids jsonb)
language plpgsql stable security invoker set search_path = '' as $$
declare v_account uuid; v_media text; v_bucket text; v_region public.account_region; v_ids uuid[] := array_remove(array_append(coalesce(p_cluster_member_ids, '{}'::uuid[]), p_evaluated_raw_post_id), null); v_n int; v_value numeric;
begin
  perform p_cluster_id;
  select rp.source_account_id, rp.media_type, app_private.m4_age_bucket(rp.published_at, p_run_at), sa.region into v_account, v_media, v_bucket, v_region from public.raw_posts rp join public.source_accounts sa on sa.id=rp.source_account_id where rp.id=p_evaluated_raw_post_id;
  if v_bucket is null then return; end if;
  select count(*), percentile_cont(0.5) within group (order by (rp.like_count + (sc.config->>'comment_multiplier')::numeric*rp.comments_count)/nullif(rp.followers_count_at_collection,0)) into v_n,v_value
  from public.raw_posts rp cross join public.scoring_configs sc where sc.id=p_scoring_config_id and rp.source_account_id=v_account and rp.media_type=v_media and app_private.m4_age_bucket(rp.published_at,p_run_at)=v_bucket and rp.id <> all(v_ids) and rp.collected_at<=p_run_at and rp.followers_count_at_collection>0 and rp.like_count is not null and rp.comments_count is not null;
  if v_n >= 5 then return query select v_value,v_n,'ACCOUNT_MEDIA_AGE',to_jsonb(v_ids); return; end if;
  select count(*), percentile_cont(0.5) within group (order by (rp.like_count + (sc.config->>'comment_multiplier')::numeric*rp.comments_count)/nullif(rp.followers_count_at_collection,0)) into v_n,v_value
  from public.raw_posts rp cross join public.scoring_configs sc where sc.id=p_scoring_config_id and rp.source_account_id=v_account and app_private.m4_age_bucket(rp.published_at,p_run_at)=v_bucket and rp.id <> all(v_ids) and rp.collected_at<=p_run_at and rp.followers_count_at_collection>0 and rp.like_count is not null and rp.comments_count is not null;
  if v_n >= 5 then return query select v_value,v_n,'ACCOUNT_AGE',to_jsonb(v_ids); return; end if;
  select count(*), percentile_cont(0.5) within group (order by (rp.like_count + (sc.config->>'comment_multiplier')::numeric*rp.comments_count)/nullif(rp.followers_count_at_collection,0)) into v_n,v_value
  from public.raw_posts rp join public.source_accounts sa on sa.id=rp.source_account_id cross join public.scoring_configs sc where sc.id=p_scoring_config_id and sa.region=v_region and rp.media_type=v_media and app_private.m4_age_bucket(rp.published_at,p_run_at)=v_bucket and rp.id <> all(v_ids) and rp.collected_at<=p_run_at and rp.followers_count_at_collection>0 and rp.like_count is not null and rp.comments_count is not null;
  if v_n >= 20 then return query select v_value,v_n,'REGION_MEDIA_AGE',to_jsonb(v_ids); else return query select null::numeric,coalesce(v_n,0),'UNAVAILABLE',to_jsonb(v_ids); end if;
end $$;

create or replace function public.try_acquire_intelligence_run(p_run_id uuid, p_now timestamptz, p_lease_until timestamptz) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  if p_run_id is null or p_now is null or p_lease_until is null or p_lease_until <= p_now then raise exception 'lease input is invalid' using errcode='22023'; end if;
  insert into app_private.intelligence_run_lock(lock_name,run_id,acquired_at,lease_until,heartbeat_at) values('story-intelligence',p_run_id,p_now,p_lease_until,p_now) on conflict(lock_name) do update set run_id=excluded.run_id, acquired_at=excluded.acquired_at, lease_until=excluded.lease_until, heartbeat_at=excluded.heartbeat_at where app_private.intelligence_run_lock.lease_until is null or app_private.intelligence_run_lock.lease_until <= p_now;
  return found;
end $$;
create or replace function public.renew_intelligence_run(p_run_id uuid, p_lease_until timestamptz) returns boolean language plpgsql security invoker set search_path = '' as $$ begin update app_private.intelligence_run_lock set lease_until=p_lease_until,heartbeat_at=clock_timestamp() where lock_name='story-intelligence' and run_id=p_run_id and lease_until > clock_timestamp() and p_lease_until > clock_timestamp(); return found; end $$;
create or replace function public.release_intelligence_run(p_run_id uuid) returns boolean language plpgsql security invoker set search_path = '' as $$ begin update app_private.intelligence_run_lock set run_id=null,acquired_at=null,lease_until=null,heartbeat_at=null where lock_name='story-intelligence' and run_id=p_run_id; return found; end $$;

create or replace function public.upsert_story_cluster_member(p_raw_post_id uuid,p_cluster_id uuid,p_match_method text,p_match_confidence numeric,p_signature jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare v_count int; v_id uuid;
begin
  perform 1 from public.story_clusters where id=p_cluster_id for update;
  select count(*) into v_count from public.story_cluster_posts where story_cluster_id=p_cluster_id;
  insert into public.story_cluster_posts(story_cluster_id,raw_post_id,match_method,match_confidence) values(p_cluster_id,p_raw_post_id,case when v_count=0 then 'SEED' else p_match_method end,case when v_count=0 then 1.0 else p_match_confidence end) on conflict(raw_post_id) do update set story_cluster_id=excluded.story_cluster_id,match_method=excluded.match_method,match_confidence=excluded.match_confidence returning story_cluster_id into v_id;
  update public.story_clusters set signature_json=coalesce(p_signature,'{}'::jsonb),signature_version=coalesce(p_signature->>'dictionary_version',signature_version),first_seen_at=least(first_seen_at,(select published_at from public.raw_posts where id=p_raw_post_id)),last_seen_at=greatest(last_seen_at,(select published_at from public.raw_posts where id=p_raw_post_id)) where id=p_cluster_id;
  return v_id;
end $$;

create or replace function public.reassign_story_cluster_post(p_raw_post_id uuid,p_target_cluster_id uuid,p_reason text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare v_old uuid; v_promote uuid;
begin
  perform p_reason;
  select story_cluster_id into v_old from public.story_cluster_posts where raw_post_id=p_raw_post_id for update;
  if v_old is null then raise exception 'membership not found' using errcode='P0002'; end if;
  update public.story_cluster_posts set story_cluster_id=p_target_cluster_id,match_method='MANUAL',match_confidence=1.0 where raw_post_id=p_raw_post_id;
  select scp.raw_post_id into v_promote from public.story_cluster_posts scp where scp.story_cluster_id=v_old order by scp.created_at,scp.raw_post_id limit 1;
  if v_promote is not null then update public.story_cluster_posts set match_method='SEED',match_confidence=1.0 where raw_post_id=v_promote; end if;
  return p_target_cluster_id;
end $$;

create or replace function app_private.m4_refresh_lifecycle(p_run_at timestamptz) returns void language sql security invoker set search_path = '' as $$
  update public.story_clusters sc set status=(case when status='ARCHIVED' then 'ARCHIVED' when last_seen_at < p_run_at-interval '7 days' then 'ARCHIVED' when last_seen_at < p_run_at-interval '6 hours' and last_seen_at >= p_run_at-interval '7 days' then 'STALE' when last_seen_at >= p_run_at-interval '6 hours' and last_seen_at <=p_run_at and (select count(*) from public.story_cluster_posts where story_cluster_id=sc.id)>=2 then 'ACTIVE' else 'OPEN' end)::public.story_cluster_status
  where sc.status <> 'ARCHIVED'
$$;

create or replace function public.calculate_priority_candidates(p_run_at timestamptz,p_ranking_date date) returns integer
language plpgsql security invoker set search_path = '' as $$
declare v_config record; v_count int:=0;
begin
  select id,version,config into v_config from public.scoring_configs where is_active and effective_from<=p_run_at and (effective_to is null or effective_to>p_run_at) order by effective_from desc limit 1;
  if v_config.id is null then raise exception 'active scoring configuration not found' using errcode='P0002'; end if;
  perform app_private.m4_refresh_lifecycle(p_run_at);
  insert into public.content_candidates(story_cluster_id,scoring_config_id,score_version,korea_coverage_status,global_spread_score,engagement_outperformance_score,engagement_velocity_score,velocity_acceleration_score,korea_gap_score,first_mover_score,korean_saturation_score,reliability_score,source_diversity_score,freshness_score,data_confidence,first_mover_flag,must_cover_flag,ranking_date,score_inputs,calculated_at)
  select sc.id,v_config.id,v_config.version::text,
    case when exists(select 1 from public.source_accounts sa where sa.region='KR' and sa.active and sa.api_supported and (sa.last_probe_at < p_run_at-interval '90 minutes' or sa.last_probe_at>p_run_at or sa.probe_error is not null)) or exists(select 1 from app_private.story_cluster_evaluations e join public.raw_posts rp on rp.id=e.raw_post_id join public.source_accounts sa on sa.id=rp.source_account_id where e.candidate_cluster_id=sc.id and e.decision in ('MANUAL_REVIEW','ERROR') and sa.region='KR') then 'UNCERTAIN' else 'KNOWN' end,
    round(sc.global_weight_coverage*12,3),0,0,0,0,0,0,coalesce(sc.highest_source_reliability,0),case when sc.independent_source_count>=3 then 5 when sc.independent_source_count=2 then 3 when sc.independent_source_count=1 then 1 else 0 end,case when extract(epoch from p_run_at-sc.first_seen_at)/60<120 then 10 when extract(epoch from p_run_at-sc.first_seen_at)/60<240 then 8 when extract(epoch from p_run_at-sc.first_seen_at)/60<480 then 6 when extract(epoch from p_run_at-sc.first_seen_at)/60<720 then 4 when extract(epoch from p_run_at-sc.first_seen_at)/60<1440 then 2 else 0 end,
    0,false,false,p_ranking_date,jsonb_build_object('scoring_config_id',v_config.id,'score_version',v_config.version,'comment_multiplier',(v_config.config->>'comment_multiplier')::numeric,'run_at',p_run_at,'cluster_signature',sc.signature_json,'pending_capability_account_ids',(select coalesce(jsonb_agg(id),'[]'::jsonb) from public.source_accounts where active and api_supported is null),'unsupported_account_ids',(select coalesce(jsonb_agg(id),'[]'::jsonb) from public.source_accounts where active and api_supported=false)),p_run_at
  from public.story_clusters sc where sc.status <> 'ARCHIVED' and sc.first_seen_at >= p_run_at-interval '24 hours' and sc.first_seen_at<=p_run_at
  on conflict(story_cluster_id,ranking_date,scoring_config_id) do update set score_version=excluded.score_version,korea_coverage_status=excluded.korea_coverage_status,global_spread_score=excluded.global_spread_score,engagement_outperformance_score=excluded.engagement_outperformance_score,engagement_velocity_score=excluded.engagement_velocity_score,velocity_acceleration_score=excluded.velocity_acceleration_score,korea_gap_score=excluded.korea_gap_score,first_mover_score=excluded.first_mover_score,korean_saturation_score=excluded.korean_saturation_score,reliability_score=excluded.reliability_score,source_diversity_score=excluded.source_diversity_score,freshness_score=excluded.freshness_score,data_confidence=excluded.data_confidence,first_mover_flag=excluded.first_mover_flag,must_cover_flag=excluded.must_cover_flag,score_inputs=excluded.score_inputs,calculated_at=excluded.calculated_at;
  get diagnostics v_count=row_count; return v_count;
end $$;

create or replace function public.get_todays_candidates(p_ranking_date date) returns table(rank integer,story_cluster_id uuid,priority_score numeric,data_confidence numeric,first_mover_flag boolean,must_cover_flag boolean,korea_coverage_status text,component_scores jsonb)
language sql stable security invoker set search_path = '' as $$
 select c.rank,c.story_cluster_id,c.priority_score,c.data_confidence,c.first_mover_flag,c.must_cover_flag,c.korea_coverage_status,jsonb_build_object('global_spread',c.global_spread_score,'engagement_outperformance',c.engagement_outperformance_score,'engagement_velocity',c.engagement_velocity_score,'velocity_acceleration',c.velocity_acceleration_score,'korea_gap',c.korea_gap_score,'first_mover',c.first_mover_score,'korean_saturation',c.korean_saturation_score,'reliability',c.reliability_score,'source_diversity',c.source_diversity_score,'freshness',c.freshness_score) from public.content_candidates c where c.ranking_date=p_ranking_date order by c.priority_score desc,c.data_confidence desc,c.story_cluster_id
$$;

revoke all on function app_private.m4_age_bucket(timestamptz,timestamptz),app_private.m4_score_snapshots(uuid,timestamptz,uuid),app_private.m4_baseline(uuid,uuid,uuid[],timestamptz,uuid),app_private.m4_refresh_lifecycle(timestamptz) from public,anon,authenticated;
grant execute on function app_private.m4_refresh_lifecycle(timestamptz) to service_role;
revoke all on function public.try_acquire_intelligence_run(uuid,timestamptz,timestamptz),public.renew_intelligence_run(uuid,timestamptz),public.release_intelligence_run(uuid),public.upsert_story_cluster_member(uuid,uuid,text,numeric,jsonb),public.reassign_story_cluster_post(uuid,uuid,text),public.calculate_priority_candidates(timestamptz,date),public.get_todays_candidates(date) from public,anon,authenticated;
grant execute on function public.try_acquire_intelligence_run(uuid,timestamptz,timestamptz),public.renew_intelligence_run(uuid,timestamptz),public.release_intelligence_run(uuid),public.upsert_story_cluster_member(uuid,uuid,text,numeric,jsonb),public.reassign_story_cluster_post(uuid,uuid,text),public.calculate_priority_candidates(timestamptz,date),public.get_todays_candidates(date) to service_role;
