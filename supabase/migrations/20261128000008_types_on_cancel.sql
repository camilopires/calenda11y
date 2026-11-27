-- Cancelling makes an event public too (public_events shows cancelled
-- events), so an event that has never been public can't be cancelled
-- without a type either.

create or replace function public.moderate_event(
  p_event_id uuid,
  p_expected_version integer,
  p_status public.event_status,
  p_reason text,
  p_emails jsonb
)
returns public.events
language plpgsql
set search_path = ''
as $$
declare
  v_row public.events;
begin
  -- An event is never made public for the first time without a type, as
  -- published or as cancelled (cancelled events are public too). Events
  -- published before types existed can still be republished or restored.
  if p_status in ('approved', 'cancelled') and exists (
    select 1 from public.events
    where id = p_event_id and version = p_expected_version
      and approved_at is null and cardinality(types) = 0
  ) then
    raise exception 'needs_type' using errcode = 'P0001';
  end if;

  update public.events
  set status = p_status,
      flags = case when p_status = 'approved'
        then array_remove(array_remove(array_remove(flags, 'captcha_unverified'), 'possible_duplicate'), 'needs_type')
        else flags end
  where id = p_event_id and version = p_expected_version
  returning * into v_row;

  if not found then
    if exists (select 1 from public.events where id = p_event_id) then
      raise exception 'version_conflict' using errcode = 'P0001';
    end if;
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if p_status = 'rejected' then
    update public.events_private set rejection_reason = p_reason, updated_at = pg_catalog.now()
    where event_id = p_event_id;
  end if;

  perform public.enqueue_emails(p_emails);
  return v_row;
end;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
