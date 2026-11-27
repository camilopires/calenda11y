-- calenda11y: sponsorships (Stripe).
--
-- A sponsor is a Stripe customer. A sponsorship is one thing they paid for:
-- a subscription, or a one-off donation (listed for 12 months). Sponsors are
-- listed on the site while they have an eligible sponsorship and an
-- approved profile. Profile edits wait for approval; the last approved
-- version stays public until then.

create type public.sponsor_tier as enum ('donation', 'supporter', 'bronze', 'silver', 'gold');
create type public.profile_status as enum ('none', 'pending', 'approved', 'rejected');

create table public.sponsors (
  id uuid primary key default gen_random_uuid(),
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  contact_email extensions.citext check (contact_email is null or length(contact_email) <= 320),
  -- What the sponsor has submitted.
  name text check (name is null or length(name) between 1 and 120),
  url text check (url is null or (url ~ '^https://' and length(url) <= 500)),
  logo_alt text check (logo_alt is null or length(logo_alt) between 1 and 200),
  staged_logo_path text,
  profile_status public.profile_status not null default 'none',
  rejection_reason text,
  -- What is public, once approved.
  approved_name text,
  approved_url text,
  approved_logo_path text,
  approved_logo_alt text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (staged_logo_path is null or logo_alt is not null),
  check (approved_logo_path is null or approved_logo_alt is not null)
);

create table public.sponsorships (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references public.sponsors (id) on delete cascade,
  kind text not null check (kind in ('subscription', 'one_off')),
  tier public.sponsor_tier not null,
  billing_interval text check (billing_interval in ('month', 'year')),
  stripe_subscription_id text unique check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'),
  stripe_checkout_session_id text unique check (stripe_checkout_session_id is null or stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'),
  stripe_status text not null,
  paid boolean not null default false,
  amount_minor integer check (amount_minor is null or amount_minor >= 0),
  currency char(3),
  active_until timestamptz,
  updated_from_stripe_at timestamptz not null,
  created_at timestamptz not null default now(),
  check ((kind = 'subscription') = (stripe_subscription_id is not null)),
  check (kind = 'subscription' or stripe_checkout_session_id is not null),
  check ((kind = 'subscription') = (billing_interval is not null))
);

create index sponsorships_sponsor on public.sponsorships (sponsor_id);

-- Ties a Checkout session to the browser that started it, so the thanks page
-- only shows a profile link to the person who paid.
create table public.sponsorship_attempts (
  id uuid primary key default gen_random_uuid(),
  browser_secret_hash text not null,
  tier public.sponsor_tier not null,
  billing_interval text check (billing_interval in ('month', 'year')),
  checkout_session_id text unique,
  sponsor_id uuid references public.sponsors (id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.stripe_events (
  event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9_]+$'),
  type text not null,
  processed_at timestamptz not null default now()
);

-- Applies the state of a Stripe object (fetched fresh from Stripe by the
-- caller) in one transaction:
--  - records the webhook event id, so a repeat delivery does nothing;
--  - creates or updates the sponsor and the sponsorship, never letting an
--    older snapshot overwrite a newer one;
--  - links the browser's checkout attempt, adds a profile token, queues emails.
-- Returns 'duplicate' for an already-processed event, else 'applied'.
create function public.apply_stripe_sync(p_event_id text, p_event_type text, p jsonb)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_sponsor uuid;
  s jsonb := p -> 'sponsorship';
begin
  if p_event_id is not null then
    insert into public.stripe_events (event_id, type) values (p_event_id, p_event_type) on conflict do nothing;
    if not found then
      return 'duplicate';
    end if;
  end if;

  insert into public.sponsors (stripe_customer_id, contact_email)
  values (p ->> 'customer_id', nullif(p ->> 'email', ''))
  on conflict (stripe_customer_id) do update
    set contact_email = coalesce(excluded.contact_email, public.sponsors.contact_email), updated_at = pg_catalog.now()
  returning id into v_sponsor;

  if s ->> 'kind' = 'subscription' then
    insert into public.sponsorships as t (sponsor_id, kind, tier, billing_interval, stripe_subscription_id, stripe_checkout_session_id,
      stripe_status, paid, amount_minor, currency, active_until, updated_from_stripe_at)
    values (v_sponsor, 'subscription', (s ->> 'tier')::public.sponsor_tier, s ->> 'interval', s ->> 'subscription_id',
      nullif(s ->> 'session_id', ''), s ->> 'status', (s ->> 'paid')::boolean, (s ->> 'amount_minor')::integer, s ->> 'currency',
      (s ->> 'active_until')::timestamptz, (s ->> 'observed_at')::timestamptz)
    on conflict (stripe_subscription_id) do update set
      tier = excluded.tier,
      billing_interval = excluded.billing_interval,
      stripe_status = excluded.stripe_status,
      paid = excluded.paid,
      amount_minor = excluded.amount_minor,
      active_until = excluded.active_until,
      stripe_checkout_session_id = coalesce(t.stripe_checkout_session_id, excluded.stripe_checkout_session_id),
      updated_from_stripe_at = excluded.updated_from_stripe_at
    where t.updated_from_stripe_at <= excluded.updated_from_stripe_at;
  else
    insert into public.sponsorships as t (sponsor_id, kind, tier, stripe_checkout_session_id, stripe_status, paid,
      amount_minor, currency, active_until, updated_from_stripe_at)
    values (v_sponsor, 'one_off', 'donation', s ->> 'session_id', s ->> 'status', (s ->> 'paid')::boolean,
      (s ->> 'amount_minor')::integer, s ->> 'currency', (s ->> 'active_until')::timestamptz, (s ->> 'observed_at')::timestamptz)
    on conflict (stripe_checkout_session_id) do update set
      stripe_status = excluded.stripe_status,
      paid = excluded.paid,
      amount_minor = excluded.amount_minor,
      -- Keep the first paid date's 12 months, even if a late event repeats it.
      active_until = coalesce(t.active_until, excluded.active_until),
      updated_from_stripe_at = excluded.updated_from_stripe_at
    where t.updated_from_stripe_at <= excluded.updated_from_stripe_at;
  end if;

  if p ? 'attempt_id' then
    update public.sponsorship_attempts
    set sponsor_id = v_sponsor, checkout_session_id = coalesce(checkout_session_id, s ->> 'session_id')
    where id = (p ->> 'attempt_id')::uuid;
  end if;

  if p ? 'profile_token_hash' then
    insert into public.tokens (purpose, subject_id, hash, expires_at)
    values ('sponsor_profile', v_sponsor, p ->> 'profile_token_hash', pg_catalog.now() + interval '30 days')
    on conflict (hash) do nothing;
  end if;

  perform public.enqueue_emails(p -> 'emails');
  return 'applied';
end;
$$;

-- Sponsors shown on the site: an approved profile and a sponsorship that
-- counts (an active subscription, or a paid donation in the last 12 months).
create view public.public_sponsors
with (security_invoker = false)
as
select
  s.id,
  s.approved_name as name,
  s.approved_url as url,
  s.approved_logo_path as logo_path,
  s.approved_logo_alt as logo_alt,
  (array_agg(p.tier order by
    case p.tier when 'gold' then 4 when 'silver' then 3 when 'bronze' then 2 when 'supporter' then 1 else 0 end desc))[1] as tier
from public.sponsors s
join public.sponsorships p on p.sponsor_id = s.id
where s.approved_name is not null
  and (
    (p.kind = 'subscription' and p.stripe_status in ('active', 'trialing', 'past_due'))
    or (p.kind = 'one_off' and p.paid and p.active_until > now())
  )
group by s.id;

-- Storage: logos wait in a private bucket until approved, then a re-encoded
-- copy goes in the public bucket under a new, never-reused name.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('sponsor-staging', 'sponsor-staging', false, 1048576, array['image/webp']),
  ('sponsor-logos', 'sponsor-logos', true, 1048576, array['image/webp'])
on conflict (id) do nothing;

alter table public.sponsors enable row level security;
alter table public.sponsorships enable row level security;
alter table public.sponsorship_attempts enable row level security;
alter table public.stripe_events enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
