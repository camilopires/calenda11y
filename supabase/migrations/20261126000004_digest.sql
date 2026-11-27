-- calenda11y: the email digest.

create type public.digest_cadence as enum ('weekly', 'monthly');

create table public.digest_subscribers (
  id uuid primary key default gen_random_uuid(),
  email extensions.citext not null unique check (length(email) <= 320),
  cadence public.digest_cadence not null,
  -- ISO country codes and/or 'online'. Empty means everywhere.
  countries text[] not null default '{}' check (cardinality(countries) <= 20),
  formats public.event_format[] not null default '{}',
  confirmed_at timestamptz,
  suppressed_at timestamptz,
  suppressed_reason text,
  -- Bumped to invalidate every manage and unsubscribe link sent so far.
  token_version integer not null default 1 check (token_version >= 1),
  last_confirm_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index digest_subscribers_sendable on public.digest_subscribers (cadence, id)
  where confirmed_at is not null and suppressed_at is null;

-- One-time tokens (confirming a subscription). Only the hash is stored.
create table public.tokens (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('subscribe_confirm', 'sponsor_profile', 'sponsor_portal')),
  subject_id uuid not null,
  hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Uses a token once. Returns the subject, or nothing if the token is unknown,
-- expired or already used. Concurrent calls can't both succeed.
create function public.redeem_token(p_purpose text, p_hash text)
returns uuid
language sql
set search_path = ''
as $$
  update public.tokens set used_at = pg_catalog.now()
  where purpose = p_purpose and hash = p_hash and used_at is null and expires_at > pg_catalog.now()
  returning subject_id;
$$;

create table public.digest_runs (
  id uuid primary key default gen_random_uuid(),
  cadence public.digest_cadence not null,
  -- The days the digest covers (inclusive), fixed when the run starts so a
  -- retry or catch-up covers exactly the same days.
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  cursor uuid,
  status text not null default 'running' check (status in ('running', 'complete')),
  counts jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (cadence, period_start)
);

-- Cleanup also removes unconfirmed sign-ups after 7 days and used or expired tokens.
create or replace function public.run_cleanup_digest()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := '{}'::jsonb;
  n integer;
begin
  delete from public.digest_subscribers where confirmed_at is null and created_at < pg_catalog.now() - interval '7 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('unconfirmed_subscribers', n);
  delete from public.tokens where expires_at < pg_catalog.now() - interval '1 day' or used_at < pg_catalog.now() - interval '1 day';
  get diagnostics n = row_count; v := v || jsonb_build_object('tokens', n);
  return v;
end;
$$;

alter table public.digest_subscribers enable row level security;
alter table public.tokens enable row level security;
alter table public.digest_runs enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
