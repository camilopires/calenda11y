-- Alerts for people with a place wait while an event's position is still
-- being looked up, so the public view says how that lookup is going.

create or replace view public.public_events
with (security_invoker = false)
as
select
  id, slug, title, summary, description, lang,
  all_day, starts_at, ends_at, start_date, end_date, timezone,
  local_start_date, local_end_date, start_instant, end_instant,
  format, country_code, city, venue, url, organiser, price,
  captions, sign_language, step_free, quiet_room, hearing_loop, remote_attendance, access_notes,
  status, sequence, approved_at, cancelled_at, updated_at, search,
  -- New columns go last: create or replace view can only add at the end.
  types,
  cfp_url, cfp_closes_on, cfp_closes_at, cfp_last_day, cfp_capped,
  topics,
  lat, lng,
  -- Whether a position is still being looked up (alerts for near-me subscribers wait for it).
  geo_status
from public.events
where status in ('approved', 'cancelled');

revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
