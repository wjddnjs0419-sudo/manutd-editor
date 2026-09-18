create or replace function public.try_acquire_creative_generation_job(
  p_job_id uuid,
  p_lease_owner text,
  p_now timestamptz,
  p_lease_until timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if p_job_id is null or p_lease_owner is null or btrim(p_lease_owner) = '' or p_now is null or p_lease_until is null or p_lease_until <= p_now then
    raise exception 'creative generation lease input is invalid' using errcode = '22023';
  end if;
  update app_private.creative_generation_jobs
  set lease_owner = p_lease_owner,
      lease_expires_at = p_lease_until,
      status = case when status = 'QUEUED' then 'GENERATING' else status end,
      updated_at = p_now
  where id = p_job_id
    and (lease_expires_at is null or lease_expires_at <= p_now or lease_owner = p_lease_owner);
  return found;
end
$function$;

revoke all on function public.try_acquire_creative_generation_job(uuid, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.try_acquire_creative_generation_job(uuid, text, timestamptz, timestamptz)
  to service_role;
