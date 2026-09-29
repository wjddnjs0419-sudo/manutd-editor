-- A durable, narrowly scoped handoff before PROMOTE_DISCOVERY enqueues grounding.
-- The caller must own the running job; this cannot patch arbitrary queue fields.
create or replace function public.update_editorial_job_payload(
  p_job_id uuid,
  p_worker_id text,
  p_patch jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_snapshot timestamptz;
  v_limit integer;
  v_updated integer;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
    or jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Invalid grounding handoff' using errcode = '22023';
  end if;
  if not (p_patch ?& array['grounding_story_cluster_ids', 'grounding_as_of', 'grounding_limit'])
    or exists (
      select 1 from jsonb_object_keys(p_patch) as keys(key)
      where key not in ('grounding_story_cluster_ids', 'grounding_as_of', 'grounding_limit')
    ) then
    raise exception 'Invalid grounding handoff fields' using errcode = '22023';
  end if;
  if jsonb_typeof(p_patch->'grounding_story_cluster_ids') is distinct from 'array'
    or jsonb_typeof(p_patch->'grounding_as_of') is distinct from 'string'
    or jsonb_typeof(p_patch->'grounding_limit') is distinct from 'number' then
    raise exception 'Invalid grounding handoff types' using errcode = '22023';
  end if;
  if jsonb_array_length(p_patch->'grounding_story_cluster_ids') not between 1 and 100
    or exists (
      select 1 from jsonb_array_elements(p_patch->'grounding_story_cluster_ids') as ids(id)
      where jsonb_typeof(id) <> 'string'
        or (id #>> '{}') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    )
    or (select count(distinct id) from jsonb_array_elements_text(p_patch->'grounding_story_cluster_ids') as ids(id))
      <> jsonb_array_length(p_patch->'grounding_story_cluster_ids') then
    raise exception 'Invalid grounding story scope' using errcode = '22023';
  end if;
  if (p_patch->>'grounding_as_of') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$'
    or (p_patch->>'grounding_limit') !~ '^[0-9]{1,3}$' then
    raise exception 'Invalid grounding snapshot or limit' using errcode = '22023';
  end if;
  v_snapshot := (p_patch->>'grounding_as_of')::timestamptz;
  v_limit := (p_patch->>'grounding_limit')::integer;
  if not isfinite(v_snapshot) or v_limit not between 1 and 100 then
    raise exception 'Invalid grounding snapshot or limit' using errcode = '22023';
  end if;

  update app_private.editorial_jobs
  set payload = payload || p_patch
  where id = p_job_id
    and job_type = 'PROMOTE_DISCOVERY'
    and status = 'RUNNING'
    and locked_by = p_worker_id
    -- An explicit root snapshot and an already recorded handoff are immutable.
    and (nullif(payload->>'as_of', '') is null or payload->>'as_of' = p_patch->>'grounding_as_of')
    and (not (payload ?| array['grounding_story_cluster_ids', 'grounding_as_of', 'grounding_limit'])
      or (payload->'grounding_story_cluster_ids' = p_patch->'grounding_story_cluster_ids'
        and payload->'grounding_as_of' = p_patch->'grounding_as_of'
        and payload->'grounding_limit' = p_patch->'grounding_limit'));
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

revoke all on function public.update_editorial_job_payload(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.update_editorial_job_payload(uuid, text, jsonb) to service_role;
