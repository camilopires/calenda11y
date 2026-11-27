-- Near me: event positions, looked up from OpenStreetMap's Nominatim.
--
-- Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
-- allows at most 1 request a second in total, 4 a minute for scheduled jobs,
-- and requires caching. geocode_slots spaces requests exactly (not by time
-- windows, which can let two through close together), and place_lookups
-- caches every answer for 30 days.

alter table public.events
  add column lat double precision check (lat is null or lat between -90 and 90),
  add column lng double precision check (lng is null or lng between -180 and 180),
  add column geo_status text not null default 'pending'
    check (geo_status in ('pending', 'found', 'not_found', 'failed', 'none')),
  add column geo_query text,
  add column geo_checked_at timestamptz,
  add constraint events_found_has_position check ((geo_status = 'found') = (lat is not null and lng is not null));

create index events_position on public.events (lat, lng) where lat is not null;
create index events_geo_pending on public.events (geo_checked_at) where geo_status in ('pending', 'failed');

-- Online events need no position. (Only those rows change here.)
update public.events set geo_status = 'none' where format = 'online';

-- A change of place means the position must be looked up again, unless the
-- same update sets the position itself (the lookup job, or seed data).
create function public.events_geo_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.format = 'online' then
    new.geo_status := 'none';
    new.lat := null;
    new.lng := null;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.lat is null then
      new.geo_status := 'pending';
    end if;
    return new;
  end if;
  if (new.format, new.venue, new.city, new.country_code) is distinct from (old.format, old.venue, old.city, old.country_code)
     and (new.lat, new.lng) is not distinct from (old.lat, old.lng) then
    new.geo_status := 'pending';
    new.lat := null;
    new.lng := null;
    new.geo_query := null;
  end if;
  return new;
end;
$$;

create trigger events_geo_before_write
before insert or update on public.events
for each row execute function public.events_geo_before_write();

create table public.place_lookups (
  -- The search, lower-cased with spaces squashed.
  query_key text primary key check (length(query_key) between 1 and 300),
  -- Up to 5 places: {label, lat, lng, country_code}.
  results jsonb not null,
  looked_up_at timestamptz not null default now()
);

create table public.geocode_slots (
  key text primary key,
  next_at timestamptz not null default now()
);

-- Reserves the next time a lookup may start under this key, spaced by
-- p_spacing_ms from the previous one. Callers wait until the returned time.
-- The row lock makes concurrent callers queue up exactly.
create function public.reserve_geocode_slot(p_key text, p_spacing_ms integer)
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
  update public.geocode_slots
  set next_at = v_start + pg_catalog.make_interval(secs => p_spacing_ms / 1000.0)
  where key = p_key;
  return v_start;
end;
$$;

alter table public.digest_subscribers
  add column near_lat double precision check (near_lat is null or near_lat between -90 and 90),
  add column near_lng double precision check (near_lng is null or near_lng between -180 and 180),
  add column near_label text check (near_label is null or length(near_label) between 1 and 200),
  add column near_km numeric check (near_km is null or near_km between 1 and 200),
  add column near_unit text check (near_unit is null or near_unit in ('mi', 'km')),
  add column near_online boolean not null default true,
  add constraint digest_subscribers_near_all_or_none check (
    (near_lat is null) = (near_lng is null) and (near_lat is null) = (near_label is null)
    and (near_lat is null) = (near_km is null) and (near_lat is null) = (near_unit is null)
  );

create or replace function public.digest_subscribers_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_alerts boolean := new.cadence in ('daily', 'instant');
  v_starting boolean;
begin
  if tg_op = 'UPDATE' and (new.cadence, new.countries, new.formats, new.types, new.topics, new.include_cfp,
      new.near_lat, new.near_lng, new.near_km, new.near_unit, new.near_online)
     is distinct from (old.cadence, old.countries, old.formats, old.types, old.topics, old.include_cfp,
      old.near_lat, old.near_lng, old.near_km, old.near_unit, old.near_online) then
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
  lat, lng
from public.events
where status in ('approved', 'cancelled');

create or replace function public.run_cleanup()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := '{}'::jsonb;
  n integer;
begin
  delete from public.rate_limits where window_start < pg_catalog.now() - interval '2 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('rate_limits', n);

  delete from public.admin_drafts where expires_at < pg_catalog.now();
  get diagnostics n = row_count; v := v || jsonb_build_object('admin_drafts', n);

  -- Submitters' email addresses are kept until 90 days after the event ends.
  update public.events_private p set submitter_email = null, submitter_name = null, updated_at = pg_catalog.now()
  from public.events e
  where e.id = p.event_id and p.submitter_email is not null and e.end_instant < pg_catalog.now() - interval '90 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('submitter_emails', n);

  delete from public.email_outbox where status = 'sent' and updated_at < pg_catalog.now() - interval '90 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('sent_emails', n);

  delete from public.import_runs where finished_at < pg_catalog.now() - interval '30 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('import_runs', n);

  delete from public.import_items i using public.import_runs r
  where r.id = i.run_id and r.finished_at < pg_catalog.now() - interval '7 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('import_items', n);

  -- Place searches are kept 30 days (OpenStreetMap asks for caching).
  delete from public.place_lookups where looked_up_at < pg_catalog.now() - interval '30 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('place_lookups', n);

  delete from public.job_runs where started_at < pg_catalog.now() - interval '30 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('job_runs', n);

  delete from public.submission_nonces where used_at < pg_catalog.now() - interval '1 year';
  get diagnostics n = row_count; v := v || jsonb_build_object('nonces', n);

  return v;
end;
$$;

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('import', 'outbox', 'cleanup', 'digest', 'sponsor_expiry', 'alerts', 'geocode'));

alter table public.place_lookups enable row level security;
alter table public.geocode_slots enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
