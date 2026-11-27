-- A lookup slot is only taken if it starts in time. Before, a search that
-- would have waited too long still moved the queue on, so a burst of
-- refused searches pushed everyone else (and the job) further back.

drop function public.reserve_geocode_slot(text, integer);

-- The start time of the reserved slot, or null (nothing reserved) if the
-- next free slot is after p_not_after.
create function public.reserve_geocode_slot(p_key text, p_spacing_ms integer, p_not_after timestamptz)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v_start timestamptz;
begin
  insert into public.geocode_slots (key, next_at) values (p_key, pg_catalog.clock_timestamp())
  on conflict (key) do nothing;
  select greatest(next_at, pg_catalog.clock_timestamp()) into v_start
  from public.geocode_slots where key = p_key for update;
  if v_start > p_not_after then
    return null;
  end if;
  update public.geocode_slots
  set next_at = v_start + pg_catalog.make_interval(secs => p_spacing_ms / 1000.0)
  where key = p_key;
  return v_start;
end;
$$;

revoke execute on function public.reserve_geocode_slot(text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_geocode_slot(text, integer, timestamptz) to service_role;
