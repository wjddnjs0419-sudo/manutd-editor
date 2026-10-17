create table app_private.gdelt_request_gate (
  singleton boolean primary key default true check (singleton),
  lease_id uuid,
  lease_until timestamptz,
  next_request_at timestamptz not null default '-infinity'::timestamptz,
  blocked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

alter table app_private.gdelt_request_gate enable row level security;
revoke all on table app_private.gdelt_request_gate from public, anon, authenticated;
grant select, insert, update, delete on table app_private.gdelt_request_gate to service_role;

create function app_private.claim_gdelt_request(p_lease_id uuid)
returns table (claimed boolean, retry_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lease_id uuid;
  v_lease_until timestamptz;
  v_next_request_at timestamptz;
  v_blocked_until timestamptz;
  v_now timestamptz := clock_timestamp();
  v_retry_at timestamptz;
begin
  insert into app_private.gdelt_request_gate (singleton)
  values (true)
  on conflict (singleton) do nothing;

  select gate.lease_id, gate.lease_until, gate.next_request_at, gate.blocked_until
    into v_lease_id, v_lease_until, v_next_request_at, v_blocked_until
    from app_private.gdelt_request_gate as gate
   where gate.singleton = true
   for update;

  v_now := clock_timestamp();
  if v_lease_id is not null and v_lease_until > v_now then
    return query select false, least(v_lease_until, v_now + interval '2 seconds');
    return;
  end if;

  v_retry_at := greatest(
    coalesce(v_next_request_at, '-infinity'::timestamptz),
    coalesce(v_blocked_until, '-infinity'::timestamptz)
  );
  if v_retry_at > v_now then
    return query select false, v_retry_at;
    return;
  end if;

  update app_private.gdelt_request_gate as gate
     set lease_id = p_lease_id,
         lease_until = v_now + interval '30 seconds',
         updated_at = v_now
   where gate.singleton = true;

  return query select true, v_now;
end;
$$;

create function app_private.release_gdelt_request(
  p_lease_id uuid,
  p_retry_after_seconds integer default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_blocked_until timestamptz;
begin
  if p_retry_after_seconds is not null then
    v_blocked_until := v_now + make_interval(
      secs => least(3600, greatest(60, p_retry_after_seconds))
    );
  end if;

  update app_private.gdelt_request_gate as gate
     set lease_id = null,
         lease_until = null,
         next_request_at = greatest(
           gate.next_request_at,
           v_now + interval '5.5 seconds',
           coalesce(v_blocked_until, '-infinity'::timestamptz)
         ),
         blocked_until = case
           when v_blocked_until is null then gate.blocked_until
           else greatest(
             coalesce(gate.blocked_until, '-infinity'::timestamptz),
             v_blocked_until
           )
         end,
         updated_at = v_now
   where gate.singleton = true
     and gate.lease_id = p_lease_id;

  return found;
end;
$$;

revoke all on function app_private.claim_gdelt_request(uuid) from public, anon, authenticated;
grant execute on function app_private.claim_gdelt_request(uuid) to service_role;
revoke all on function app_private.release_gdelt_request(uuid, integer) from public, anon, authenticated;
grant execute on function app_private.release_gdelt_request(uuid, integer) to service_role;
