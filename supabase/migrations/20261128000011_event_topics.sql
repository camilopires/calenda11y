-- Topics: what an event is about (an event can have several). Optional,
-- unlike types; imports guess them once, and admins own them after that.

create type public.event_topic as enum (
  'inclusive_design', 'neurodiversity', 'design_systems', 'web_development', 'mobile',
  'content', 'testing', 'law', 'assistive_tech', 'careers'
);

alter table public.events
  add column topics public.event_topic[] not null default '{}'
    constraint events_topics_unique check (public.has_no_duplicates(topics));

create index events_topics on public.events using gin (topics);

alter table public.digest_subscribers
  add column topics public.event_topic[] not null default '{}'
    constraint digest_subscribers_topics_unique check (public.has_no_duplicates(topics));

create or replace function public.events_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_valid_timezone(new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone using errcode = 'check_violation';
  end if;

  if new.all_day then
    new.local_start_date := new.start_date;
    new.local_end_date := new.end_date - 1;
    new.start_instant := new.start_date::timestamp at time zone new.timezone;
    new.end_instant := new.end_date::timestamp at time zone new.timezone;
  else
    new.local_start_date := (new.starts_at at time zone new.timezone)::date;
    -- The last day the event touches: an event ending at exactly midnight
    -- doesn't spill into the next day.
    new.local_end_date := ((new.ends_at - interval '1 microsecond') at time zone new.timezone)::date;
    new.start_instant := new.starts_at;
    new.end_instant := new.ends_at;
  end if;

  -- Call for speakers: one real deadline. It closes at the end of the chosen
  -- day in the event's time zone, or when the event starts if that's sooner
  -- (or if there's no date). Badges, feeds and the digest all use these.
  if new.cfp_url is null then
    new.cfp_closes_at := null;
    new.cfp_last_day := null;
    new.cfp_capped := null;
  else
    new.cfp_closes_at := case
      when new.cfp_closes_on is null then new.start_instant
      else least((new.cfp_closes_on + 1)::timestamp at time zone new.timezone, new.start_instant)
    end;
    -- Capped only when the start really cuts the call short (or there's no date).
    new.cfp_capped := new.cfp_closes_on is null
      or (new.cfp_closes_on + 1)::timestamp at time zone new.timezone > new.start_instant;
    new.cfp_last_day := ((new.cfp_closes_at - interval '1 microsecond') at time zone new.timezone)::date;
  end if;

  -- Once an event has a type, it no longer needs one, however it was saved.
  if pg_catalog.cardinality(new.types) > 0 then
    new.flags := pg_catalog.array_remove(new.flags, 'needs_type');
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
    new.version := old.version + 1;

    if new.status = 'cancelled' and old.status <> 'cancelled' then
      new.cancelled_at := now();
    elsif new.status <> 'cancelled' then
      new.cancelled_at := null;
    end if;

    if new.status = 'approved' and old.status <> 'approved' and new.approved_at is null then
      new.approved_at := now();
    end if;

    -- Calendar clients need SEQUENCE to go up whenever a published event changes.
    if old.status in ('approved', 'cancelled') and (
      new.status is distinct from old.status
      or new.title is distinct from old.title
      or new.summary is distinct from old.summary
      or new.description is distinct from old.description
      or new.all_day is distinct from old.all_day
      or new.starts_at is distinct from old.starts_at
      or new.ends_at is distinct from old.ends_at
      or new.start_date is distinct from old.start_date
      or new.end_date is distinct from old.end_date
      or new.timezone is distinct from old.timezone
      or new.format is distinct from old.format
      or new.types is distinct from old.types
      or new.cfp_url is distinct from old.cfp_url
      or new.cfp_closes_on is distinct from old.cfp_closes_on
      or new.topics is distinct from old.topics
      or new.country_code is distinct from old.country_code
      or new.city is distinct from old.city
      or new.venue is distinct from old.venue
      or new.url is distinct from old.url
      or new.organiser is distinct from old.organiser
    ) then
      new.sequence := old.sequence + 1;
    end if;

    -- Slugs never change once an event has been published.
    if old.approved_at is not null and new.slug is distinct from old.slug then
      raise exception 'The slug of a published event cannot change' using errcode = 'check_violation';
    end if;
  else
    if new.status = 'approved' and new.approved_at is null then
      new.approved_at := now();
    end if;
    if new.status = 'cancelled' then
      new.cancelled_at := coalesce(new.cancelled_at, now());
    end if;
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
  topics
from public.events
where status in ('approved', 'cancelled');

create or replace function public.create_submission(p_event jsonb, p_private jsonb, p_nonce text, p_emails jsonb)
returns table (id uuid, slug text, duplicates integer)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_slug text;
  v_dupes integer;
begin
  begin
    insert into public.submission_nonces (nonce, purpose) values (p_nonce, 'event');
  exception when unique_violation then
    raise exception 'already_submitted' using errcode = 'P0001';
  end;

  insert into public.events (
    id, slug, title, summary, description, lang, all_day, starts_at, ends_at, start_date, end_date, timezone,
    format, country_code, city, venue, url, organiser, price,
    captions, sign_language, step_free, quiet_room, hearing_loop, remote_attendance, access_notes,
    status, flags, source, types, cfp_url, cfp_closes_on, topics
  )
  select
    coalesce(r.id, gen_random_uuid()), r.slug, r.title, r.summary, r.description, r.lang, r.all_day, r.starts_at, r.ends_at, r.start_date, r.end_date,
    r.timezone, r.format, r.country_code, r.city, r.venue, r.url, r.organiser, r.price,
    r.captions, r.sign_language, r.step_free, r.quiet_room, r.hearing_loop, r.remote_attendance, r.access_notes,
    -- No coalesce on types: a payload without them fails NOT NULL instead of storing none.
    'pending', coalesce(r.flags, '{}'), 'form', r.types, r.cfp_url, r.cfp_closes_on,
    -- Topics are optional: none sent means none.
    coalesce(r.topics, '{}')
  from jsonb_to_record(p_event) as r(
    id uuid, slug text, title text, summary text, description text, lang text, all_day boolean,
    starts_at timestamptz, ends_at timestamptz, start_date date, end_date date, timezone text,
    format public.event_format, country_code char(2), city text, venue text, url text, organiser text,
    price public.event_price, captions boolean, sign_language boolean, step_free boolean, quiet_room boolean,
    hearing_loop boolean, remote_attendance boolean, access_notes text, flags text[],
    types public.event_type[], cfp_url text, cfp_closes_on date,
    topics public.event_topic[]
  )
  returning events.id, events.slug into v_id, v_slug;

  insert into public.events_private (event_id, submitter_email, submitter_name)
  values (v_id, p_private ->> 'submitter_email', nullif(p_private ->> 'submitter_name', ''));

  v_dupes := public.find_duplicates(v_id);
  perform public.enqueue_emails(p_emails);

  return query select v_id, v_slug, v_dupes;
end;
$$;

-- Upcoming events per topic, for /topics. Cancelled events are counted
-- because topic pages list them too, so the two always agree.
create view public.public_topic_counts
with (security_invoker = false)
as
select t as topic, count(*)::integer as upcoming
from public.events, unnest(topics) as t
where status in ('approved', 'cancelled') and end_instant > now()
group by t;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
