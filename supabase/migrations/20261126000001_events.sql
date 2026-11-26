-- calenda11y: events core.
--
-- Access model: the browser never talks to the database. All reads and writes
-- go through server code using the service role, which checks permissions
-- itself (requireAdmin for admin actions). The anon and authenticated roles get
-- no table or function access at all, and every table has row-level security
-- turned on with no policies, so even a leaked anon key can read nothing.

create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- Supabase grants anon/authenticated access to new objects by default. Undo
-- that for everything this project creates.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, public;
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create table public.countries (
  code char(2) primary key check (code ~ '^[A-Z]{2}$')
);

insert into public.countries (code)
select unnest(string_to_array(
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO '
  'JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR '
  'MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO '
  'RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV '
  'TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW', ' '));

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.event_status as enum ('pending', 'approved', 'rejected', 'cancelled');
create type public.event_format as enum ('in_person', 'online', 'hybrid');
create type public.event_price as enum ('free', 'paid');
create type public.event_source as enum ('form', 'ics', 'rss', 'luma', 'eventbrite', 'meetup');
create type public.import_source_type as enum ('ics', 'rss', 'luma', 'eventbrite', 'meetup');
create type public.credentials_status as enum ('ok', 'missing', 'expired', 'unavailable');

-- ---------------------------------------------------------------------------
-- Import sources (filled in by milestone 5; events reference them)
-- ---------------------------------------------------------------------------

create table public.import_sources (
  id uuid primary key default gen_random_uuid(),
  type public.import_source_type not null,
  name text not null check (length(name) between 1 and 200),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  enabled boolean not null default true,
  credentials_status public.credentials_status not null default 'ok',
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

create table public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 120),
  title text not null check (length(btrim(title)) between 1 and 200),
  summary text not null check (length(btrim(summary)) between 1 and 280),
  description text check (description is null or length(description) <= 20000),
  lang text not null default 'en' check (lang ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'),

  -- Timing: either a timed event (starts_at/ends_at) or an all-day event
  -- (start_date/end_date, end exclusive).
  all_day boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  start_date date,
  end_date date,
  timezone text not null,
  -- Derived by trigger: the event's dates in its own time zone (inclusive),
  -- and the instants it starts and ends, for filtering and ordering.
  local_start_date date not null,
  local_end_date date not null,
  start_instant timestamptz not null,
  end_instant timestamptz not null,

  format public.event_format not null,
  country_code char(2) references public.countries (code),
  city text check (city is null or length(city) <= 120),
  venue text check (venue is null or length(venue) <= 300),
  url text check (url is null or (url ~ '^https://' and length(url) <= 2000)),
  organiser text check (organiser is null or length(organiser) <= 200),
  price public.event_price not null default 'free',

  captions boolean not null default false,
  sign_language boolean not null default false,
  step_free boolean not null default false,
  quiet_room boolean not null default false,
  hearing_loop boolean not null default false,
  remote_attendance boolean not null default false,
  access_notes text check (access_notes is null or length(access_notes) <= 2000),

  status public.event_status not null default 'pending',
  flags text[] not null default '{}' check (
    flags <@ array['possible_duplicate', 'changed', 'missing_from_source', 'captcha_unverified', 'cancel_requested']
  ),
  source public.event_source not null default 'form',
  source_id uuid references public.import_sources (id) on delete set null,
  source_uid text check (source_uid is null or length(source_uid) <= 1000),
  source_snapshot jsonb,
  pending_changes jsonb,
  sequence integer not null default 0 check (sequence >= 0),
  version integer not null default 1 check (version >= 1),
  approved_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  search tsvector generated always as (
    to_tsvector(
      'simple'::regconfig,
      coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(description, '') || ' ' ||
      coalesce(organiser, '') || ' ' || coalesce(city, '') || ' ' || coalesce(venue, '')
    )
  ) stored,

  constraint events_timing check (
    (all_day = false and starts_at is not null and ends_at is not null and ends_at > starts_at
      and start_date is null and end_date is null)
    or
    (all_day = true and start_date is not null and end_date is not null and end_date > start_date
      and starts_at is null and ends_at is null)
  ),
  constraint events_country_matches_format check (
    (format = 'online' and country_code is null) or (format <> 'online' and country_code is not null)
  ),
  -- Imported events always have a source row and an id within it; form events have neither.
  constraint events_source_consistent check (
    (source = 'form' and source_uid is null) or (source <> 'form' and source_uid is not null)
  ),
  constraint events_source_unique unique (source_id, source_uid)
);

create index events_status_start on public.events (status, start_instant);
create index events_country_start on public.events (country_code, start_instant);
create index events_local_dates on public.events (local_start_date, local_end_date);
create index events_search on public.events using gin (search);
create index events_title_trgm on public.events using gin (lower(title) extensions.gin_trgm_ops);

-- Private data about an event, never exposed through any view.
create table public.events_private (
  event_id uuid primary key references public.events (id) on delete cascade,
  submitter_email extensions.citext check (submitter_email is null or length(submitter_email) <= 320),
  submitter_name text check (submitter_name is null or length(submitter_name) <= 200),
  rejection_reason text check (rejection_reason is null or length(rejection_reason) <= 2000),
  moderation_notes text check (moderation_notes is null or length(moderation_notes) <= 5000),
  updated_at timestamptz not null default now()
);

create table public.event_duplicates (
  event_id uuid not null references public.events (id) on delete cascade,
  duplicate_id uuid not null references public.events (id) on delete cascade,
  score real not null check (score between 0 and 1),
  created_at timestamptz not null default now(),
  primary key (event_id, duplicate_id),
  check (event_id <> duplicate_id)
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- A time zone is valid if it looks like an IANA name (Area/City, or UTC) and
-- Postgres can convert to it. (pg_timezone_names re-reads the zone files on
-- every call, which is far too slow to use in a row trigger.)
create function public.is_valid_timezone(tz text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if tz is null or tz !~ '^([A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}|UTC)$' then
    return false;
  end if;
  perform pg_catalog.now() at time zone tz;
  return true;
exception when invalid_parameter_value then
  return false;
end;
$$;

create function public.events_before_write()
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

create trigger events_before_write
before insert or update on public.events
for each row execute function public.events_before_write();

-- ---------------------------------------------------------------------------
-- Public views (read by server code; never granted to anon)
-- ---------------------------------------------------------------------------

create view public.public_events
with (security_invoker = false)
as
select
  id, slug, title, summary, description, lang,
  all_day, starts_at, ends_at, start_date, end_date, timezone,
  local_start_date, local_end_date, start_instant, end_instant,
  format, country_code, city, venue, url, organiser, price,
  captions, sign_language, step_free, quiet_room, hearing_loop, remote_attendance, access_notes,
  status, sequence, approved_at, cancelled_at, updated_at, search
from public.events
where status in ('approved', 'cancelled');

create view public.public_country_counts
with (security_invoker = false)
as
select country_code, count(*)::integer as upcoming
from public.events
where status = 'approved' and country_code is not null and end_instant > now()
group by country_code;

-- ---------------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------------

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Lock everything down
-- ---------------------------------------------------------------------------

alter table public.countries enable row level security;
alter table public.import_sources enable row level security;
alter table public.events enable row level security;
alter table public.events_private enable row level security;
alter table public.event_duplicates enable row level security;
alter table public.admins enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
