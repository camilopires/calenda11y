-- An alert subscription's starting point numbers every change that is
-- already committed first. Otherwise a change committed just before someone
-- subscribed, but not yet numbered, would be sent to them as new.

create or replace function public.digest_subscribers_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_alerts boolean := new.cadence in ('daily', 'instant');
  v_starting boolean;
begin
  if tg_op = 'UPDATE' and (new.cadence, new.countries, new.formats, new.types, new.topics, new.include_cfp)
     is distinct from (old.cadence, old.countries, old.formats, old.types, old.topics, old.include_cfp) then
    new.prefs_revision := old.prefs_revision + 1;
  end if;
  if not v_alerts then
    new.alert_cursor := null;
    return new;
  end if;
  v_starting := new.confirmed_at is not null and (
    tg_op = 'INSERT'
    or old.confirmed_at is null
    or old.cadence is distinct from new.cadence
  );
  if v_starting then
    -- Number everything already committed first, so "now" really is now.
    new.alert_cursor := public.sequence_changes();
  end if;
  return new;
end;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
