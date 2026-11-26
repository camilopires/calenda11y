-- calenda11y: submissions, reports, moderation, rate limits and the email outbox.
-- Every multi-step change runs in one SQL function, so it either all happens
-- or none of it does.

-- ---------------------------------------------------------------------------
-- Rate limits and one-time nonces
-- ---------------------------------------------------------------------------

create table public.rate_limits (
  bucket text not null check (length(bucket) <= 200),
  window_start timestamptz not null,
  hits integer not null default 1 check (hits >= 1),
  primary key (bucket, window_start)
);

-- Counts a hit and says whether it's within the limit. The insert-or-increment
-- is a single statement, so concurrent requests can't both slip under it.
create function public.hit_rate_limit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_window timestamptz := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from pg_catalog.now()) / p_window_seconds) * p_window_seconds
  );
  v_hits integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'Invalid rate limit' using errcode = 'check_violation';
  end if;
  insert into public.rate_limits as r (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
end;
$$;

create table public.submission_nonces (
  nonce text primary key check (length(nonce) between 16 and 100),
  purpose text not null check (purpose in ('event', 'report', 'subscribe', 'sponsor_profile')),
  used_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Email outbox
-- ---------------------------------------------------------------------------

create type public.outbox_status as enum ('queued', 'sending', 'sent', 'failed', 'unknown');

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (length(kind) <= 60),
  dedupe_key text not null unique check (length(dedupe_key) <= 300),
  to_email extensions.citext not null check (length(to_email) <= 320),
  subject text not null check (length(subject) <= 300),
  html text not null,
  text_body text not null,
  headers jsonb not null default '{}'::jsonb check (jsonb_typeof(headers) = 'object'),
  status public.outbox_status not null default 'queued',
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  first_sent_attempt_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index email_outbox_due on public.email_outbox (status, next_attempt_at);

-- Queues emails given as a JSON array of
-- {kind, dedupe_key, to_email, subject, html, text_body, headers}.
-- An email whose dedupe_key already exists is skipped, never sent twice.
create function public.enqueue_emails(p_emails jsonb)
returns setof uuid
language sql
set search_path = ''
as $$
  insert into public.email_outbox (kind, dedupe_key, to_email, subject, html, text_body, headers)
  select e.kind, e.dedupe_key, e.to_email, e.subject, e.html, e.text_body, coalesce(e.headers, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_emails, '[]'::jsonb))
    as e(kind text, dedupe_key text, to_email text, subject text, html text, text_body text, headers jsonb)
  on conflict (dedupe_key) do nothing
  returning id;
$$;

-- Claims up to p_limit due emails for sending, under a lease. Rows stuck in
-- 'sending' past their lease are reclaimed, unless their first attempt was
-- more than 24 hours ago: Resend only de-duplicates for 24 hours, so those
-- become 'unknown' for a person to check instead of risking a second send.
create function public.claim_outbox(p_limit integer, p_lease_seconds integer, p_ids uuid[] default null)
returns setof public.email_outbox
language plpgsql
set search_path = ''
as $$
begin
  update public.email_outbox
  set status = 'unknown', lease_until = null, updated_at = pg_catalog.now(),
      last_error = coalesce(last_error, 'Sending was interrupted more than 24 hours ago; check whether it arrived')
  where status = 'sending' and lease_until < pg_catalog.now()
    and first_sent_attempt_at < pg_catalog.now() - interval '24 hours';

  return query
  update public.email_outbox o
  set status = 'sending',
      attempts = o.attempts + 1,
      lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
      first_sent_attempt_at = coalesce(o.first_sent_attempt_at, pg_catalog.now()),
      updated_at = pg_catalog.now()
  where o.id in (
    select c.id from public.email_outbox c
    where (p_ids is null or c.id = any (p_ids))
      and (
        (c.status = 'queued' and c.next_attempt_at <= pg_catalog.now())
        or (c.status = 'sending' and c.lease_until < pg_catalog.now())
      )
    order by c.next_attempt_at
    limit p_limit
    for update skip locked
  )
  returning o.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- Duplicate detection
-- ---------------------------------------------------------------------------

-- Finds likely duplicates of an event (similar title, start within a day,
-- same country or both online), records them, and flags the event.
create function public.find_duplicates(p_event_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.event_duplicates (event_id, duplicate_id, score)
  select e.id, o.id, extensions.similarity(lower(e.title), lower(o.title))
  from public.events e
  join public.events o on o.id <> e.id
    and o.status <> 'rejected'
    and abs(extract(epoch from (o.start_instant - e.start_instant))) <= 86400
    and (o.country_code = e.country_code or (o.country_code is null and e.country_code is null))
    and extensions.similarity(lower(e.title), lower(o.title)) >= 0.6
  where e.id = p_event_id
  on conflict (event_id, duplicate_id) do update set score = excluded.score;

  get diagnostics v_count = row_count;
  if v_count > 0 then
    update public.events
    set flags = (select array_agg(distinct f) from unnest(flags || array['possible_duplicate']) f)
    where id = p_event_id;
  end if;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Submissions
-- ---------------------------------------------------------------------------

-- Creates a submitted event, its private details and its emails in one go.
-- The caller may choose the event id (so emails can link to it).
-- p_nonce makes a "Check your answers" page single-use: sending it twice
-- raises 'already_submitted' and creates nothing.
create function public.create_submission(p_event jsonb, p_private jsonb, p_nonce text, p_emails jsonb)
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
    status, flags, source
  )
  select
    coalesce(r.id, gen_random_uuid()), r.slug, r.title, r.summary, r.description, r.lang, r.all_day, r.starts_at, r.ends_at, r.start_date, r.end_date,
    r.timezone, r.format, r.country_code, r.city, r.venue, r.url, r.organiser, r.price,
    r.captions, r.sign_language, r.step_free, r.quiet_room, r.hearing_loop, r.remote_attendance, r.access_notes,
    'pending', coalesce(r.flags, '{}'), 'form'
  from jsonb_to_record(p_event) as r(
    id uuid, slug text, title text, summary text, description text, lang text, all_day boolean,
    starts_at timestamptz, ends_at timestamptz, start_date date, end_date date, timezone text,
    format public.event_format, country_code char(2), city text, venue text, url text, organiser text,
    price public.event_price, captions boolean, sign_language boolean, step_free boolean, quiet_room boolean,
    hearing_loop boolean, remote_attendance boolean, access_notes text, flags text[]
  )
  returning events.id, events.slug into v_id, v_slug;

  insert into public.events_private (event_id, submitter_email, submitter_name)
  values (v_id, p_private ->> 'submitter_email', nullif(p_private ->> 'submitter_name', ''));

  v_dupes := public.find_duplicates(v_id);
  perform public.enqueue_emails(p_emails);

  return query select v_id, v_slug, v_dupes;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create type public.report_reason as enum ('wrong_details', 'cancelled', 'not_accessibility', 'spam', 'access_problem', 'other');

create table public.event_reports (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  reason public.report_reason not null,
  details text check (details is null or length(details) <= 2000),
  reporter_email extensions.citext check (reporter_email is null or length(reporter_email) <= 320),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null
);

create index event_reports_open on public.event_reports (created_at) where resolved_at is null;

create function public.create_report(p_report jsonb, p_nonce text, p_emails jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  begin
    insert into public.submission_nonces (nonce, purpose) values (p_nonce, 'report');
  exception when unique_violation then
    raise exception 'already_submitted' using errcode = 'P0001';
  end;
  insert into public.event_reports (event_id, reason, details, reporter_email)
  values (
    (p_report ->> 'event_id')::uuid,
    (p_report ->> 'reason')::public.report_reason,
    nullif(p_report ->> 'details', ''),
    nullif(p_report ->> 'reporter_email', '')
  )
  returning id into v_id;
  perform public.enqueue_emails(p_emails);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderation
-- ---------------------------------------------------------------------------

-- Changes an event's status, checking the version the admin saw so two admins
-- can't overwrite each other. Raises 'version_conflict' if it changed, and
-- queues any emails in the same transaction.
create function public.moderate_event(
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
  update public.events
  set status = p_status,
      flags = case when p_status = 'approved' then array_remove(array_remove(flags, 'captcha_unverified'), 'possible_duplicate') else flags end
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

-- ---------------------------------------------------------------------------
-- Admin drafts (WCAG 2.2.5: nothing is lost if the session expires mid-edit)
-- ---------------------------------------------------------------------------

create table public.admin_drafts (
  id uuid primary key default gen_random_uuid(),
  path text not null check (path ~ '^/admin(/[A-Za-z0-9/_-]*)?$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

-- ---------------------------------------------------------------------------
-- Lock everything down (same model as the first migration)
-- ---------------------------------------------------------------------------

alter table public.rate_limits enable row level security;
alter table public.submission_nonces enable row level security;
alter table public.email_outbox enable row level security;
alter table public.event_reports enable row level security;
alter table public.admin_drafts enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
