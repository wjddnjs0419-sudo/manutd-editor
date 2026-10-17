-- Expose the private preview delivery manifest only through the service-role RPC.
-- Required by the owner-only Telegram sender to deliver every ordered slide,
-- including the fixed CTA, without relying on local files or hard-coded paths.
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
    'id',j.id,
    'job_key',j.job_key,
    'creative_brief_id',j.creative_brief_id,
    'status',j.status,
    'media_manifest',j.media_manifest,
    'rendered_manifest',j.rendered_manifest,
    'telegram_message_ids',j.telegram_message_ids
  ) into answer
  from app_private.m9_preview_jobs j
  where j.job_key=p_job_key
  limit 1;
  return answer;
end;
$$;

revoke all on function public.m9_get_preview(text) from public,anon,authenticated;
grant execute on function public.m9_get_preview(text) to service_role;
