-- M9 service-role-only RPCs for remote Supabase PostgREST deployments
-- where app_private is NOT an exposed Data API schema.
-- The underlying table remains in app_private with RLS enabled.
--
-- Usage is restricted to a secret service_role JWT in a protected worker.
-- DO NOT enable on public browser/client code.

create or replace function public.m9_claim_preview(
 p_job_key text, p_brief_id uuid, p_media jsonb
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'M9_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_job_key is null or length(p_job_key) > 160
     or p_job_key !~ '^m9:[0-9a-f-]{36}:v[0-9]+$'
     or jsonb_typeof(p_media) is distinct from 'object' then
    raise exception 'M9_CLAIM_INPUT_INVALID' using errcode = '22023';
  end if;
  insert into app_private.m9_preview_jobs(job_key, creative_brief_id, status, media_manifest)
    values(p_job_key, p_brief_id, 'CLAIMED', p_media);
  return true;
end;
$$;

create or replace function public.m9_get_preview(p_job_key text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare answer jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'M9_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'job_key',j.job_key,
    'creative_brief_id',j.creative_brief_id,
    'status',j.status,
    'telegram_message_ids',j.telegram_message_ids
  ) into answer
  from app_private.m9_preview_jobs j
  where j.job_key=p_job_key
  limit 1;
  return answer;
end;
$$;

create or replace function public.m9_transition_preview(
  p_job_key text, p_previous text, p_next text,
  p_patch jsonb default '{}'::jsonb
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare count_rows bigint;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'M9_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or exists(select 1 from jsonb_object_keys(p_patch) k
       where k not in ('rendered_manifest','telegram_message_ids','error_category')) then
    raise exception 'M9_PATCH_INVALID' using errcode = '22023';
  end if;
  if not (
   (p_previous='CLAIMED' and p_next in ('RENDERED','FAILED'))
   or (p_previous='RENDERED' and p_next in ('UPLOADED','FAILED'))
   or (p_previous='UPLOADED' and p_next in ('SENDING','FAILED'))
   or (p_previous='SENDING' and p_next in ('SENT','SEND_UNCERTAIN'))
  ) then
    raise exception 'M9_TRANSITION_INVALID' using errcode = '22023';
  end if;
  update app_private.m9_preview_jobs j
     set status=p_next,
       rendered_manifest=case when p_patch ? 'rendered_manifest'
         then p_patch->'rendered_manifest' else j.rendered_manifest end,
       telegram_message_ids=case when p_patch ? 'telegram_message_ids'
         then p_patch->'telegram_message_ids' else j.telegram_message_ids end,
       error_category=case when p_patch ? 'error_category'
         then p_patch->>'error_category' else j.error_category end,
       updated_at=now()
   where j.job_key=p_job_key and j.status=p_previous;
  get diagnostics count_rows=row_count;
  if count_rows <> 1 then
    raise exception 'M9_STATE_TRANSITION_CONFLICT' using errcode = 'P0001';
  end if;
  return true;
end;
$$;

revoke all on function public.m9_claim_preview(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.m9_get_preview(text) from public,anon,authenticated;
revoke all on function public.m9_transition_preview(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.m9_claim_preview(text,uuid,jsonb) to service_role;
grant execute on function public.m9_get_preview(text) to service_role;
grant execute on function public.m9_transition_preview(text,text,text,jsonb) to service_role;
