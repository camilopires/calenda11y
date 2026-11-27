-- Alert log fixes:
--  - An event first made public as cancelled (pending straight to
--    cancelled) is logged as "new" too; it used to be missed.
--  - Snapshots include when the event starts and ends, so alerts can judge
--    "has it ended?" as of the change.

create or replace function public.events_log_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_what text[] := '{}';
  v_after jsonb;
begin
  v_after := jsonb_build_object(
    'status', new.status, 'all_day', new.all_day, 'starts_at', new.starts_at, 'ends_at', new.ends_at,
    'start_date', new.start_date, 'end_date', new.end_date, 'timezone', new.timezone,
    'local_start_date', new.local_start_date, 'local_end_date', new.local_end_date,
    'start_instant', new.start_instant, 'end_instant', new.end_instant,
    'format', new.format, 'venue', new.venue, 'city', new.city, 'country_code', new.country_code,
    'cfp_url', new.cfp_url, 'cfp_closes_on', new.cfp_closes_on, 'cfp_last_day', new.cfp_last_day,
    'cfp_capped', new.cfp_capped,
    'captions', new.captions, 'sign_language', new.sign_language, 'step_free', new.step_free,
    'quiet_room', new.quiet_room, 'hearing_loop', new.hearing_loop, 'remote_attendance', new.remote_attendance
  );

  -- First made public: published, or shown as cancelled straight away.
  -- Republishing an event that was public before logs nothing.
  if new.status in ('approved', 'cancelled')
     and (tg_op = 'INSERT' or (old.status not in ('approved', 'cancelled') and old.approved_at is null))
     and not exists (select 1 from public.event_changes c where c.event_id = new.id and c.kind = 'new') then
    insert into public.event_changes (event_id, kind, before_status, after)
    values (new.id, 'new', case when tg_op = 'UPDATE' then old.status end, v_after);
    return null;
  end if;

  -- Material changes to an event that was and still is public. Unpublishing
  -- and republishing log nothing.
  if tg_op = 'UPDATE' and old.status in ('approved', 'cancelled') and new.status in ('approved', 'cancelled') then
    if old.status = 'approved' and new.status = 'cancelled' then v_what := pg_catalog.array_append(v_what, 'cancelled'); end if;
    if old.status = 'cancelled' and new.status = 'approved' then v_what := pg_catalog.array_append(v_what, 'restored'); end if;
    if (new.all_day, new.starts_at, new.ends_at, new.start_date, new.end_date, new.timezone)
       is distinct from (old.all_day, old.starts_at, old.ends_at, old.start_date, old.end_date, old.timezone) then
      v_what := pg_catalog.array_append(v_what, 'time');
    end if;
    if (new.format, new.country_code, new.city, new.venue) is distinct from (old.format, old.country_code, old.city, old.venue) then
      v_what := pg_catalog.array_append(v_what, 'place');
    end if;
    if (new.cfp_url, new.cfp_closes_on) is distinct from (old.cfp_url, old.cfp_closes_on) then
      v_what := pg_catalog.array_append(v_what, 'cfp');
    end if;
    if (new.captions, new.sign_language, new.step_free, new.quiet_room, new.hearing_loop, new.remote_attendance)
       is distinct from (old.captions, old.sign_language, old.step_free, old.quiet_room, old.hearing_loop, old.remote_attendance) then
      v_what := pg_catalog.array_append(v_what, 'access');
    end if;
    if cardinality(v_what) > 0 then
      insert into public.event_changes (event_id, kind, what, before_status, after)
      values (new.id, 'updated', v_what, old.status, v_after);
    end if;
  end if;
  return null;
end;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
