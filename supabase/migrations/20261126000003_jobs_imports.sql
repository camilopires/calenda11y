-- calenda11y: scheduled jobs and staged imports.
--
-- pg_cron calls /api/cron/tick every 10 minutes (see supabase/cron.sql). Each
-- tick claims due jobs under a lease and does a bounded amount of work, so a
-- slow source or a big digest carries on in the next tick instead of
-- timing out. Whether work actually happened is recorded here, in jobs and
-- job_runs, never inferred from pg_net.

create table public.jobs (
  key text primary key check (key ~ '^[a-z]+(:[a-z0-9-]+)*$' and length(key) <= 120),
  kind text not null check (kind in ('import', 'outbox', 'cleanup', 'digest', 'sponsor_expiry')),
  interval_seconds integer not null check (interval_seconds between 60 and 2678400),
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  cursor jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  last_started_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table public.job_runs (
  id bigint generated always as identity primary key,
  job_key text not null references public.jobs (key) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  finished_job boolean,
  error text,
  counts jsonb not null default '{}'::jsonb
);

create index job_runs_recent on public.job_runs (job_key, started_at desc);

-- Claims the most overdue job whose lease has expired.
create function public.claim_job(p_lease_seconds integer)
returns setof public.jobs
language sql
set search_path = ''
as $$
  update public.jobs j
  set lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
      last_started_at = pg_catalog.now(),
      attempts = j.attempts + 1
  where j.key = (
    select c.key from public.jobs c
    where c.run_after <= pg_catalog.now() and (c.lease_until is null or c.lease_until < pg_catalog.now())
    order by c.run_after
    limit 1
    for update skip locked
  )
  returning j.*;
$$;

-- Claims one specific job (for "Run now"), if nobody else holds it.
create function public.claim_job_by_key(p_key text, p_lease_seconds integer)
returns setof public.jobs
language sql
set search_path = ''
as $$
  update public.jobs j
  set lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
      last_started_at = pg_catalog.now(),
      attempts = j.attempts + 1
  where j.key = p_key and (j.lease_until is null or j.lease_until < pg_catalog.now())
  returning j.*;
$$;

-- ---------------------------------------------------------------------------
-- Import runs: each run stages what the source said, so events are only
-- marked missing after every page has been read.
-- ---------------------------------------------------------------------------

alter table public.import_sources
  add column created_by uuid references auth.users (id) on delete set null,
  add column last_run_at timestamptz,
  add column last_counts jsonb;

create type public.import_run_status as enum ('fetching', 'processing', 'complete', 'failed');

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.import_sources (id) on delete cascade,
  status public.import_run_status not null default 'fetching',
  fetch_cursor jsonb,
  counts jsonb not null default '{}'::jsonb,
  skipped jsonb not null default '[]'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index import_runs_source on public.import_runs (source_id, started_at desc);
-- At most one unfinished run per source.
create unique index import_runs_one_active on public.import_runs (source_id) where status in ('fetching', 'processing');

create table public.import_items (
  run_id uuid not null references public.import_runs (id) on delete cascade,
  source_uid text not null check (length(source_uid) <= 1000),
  payload jsonb not null,
  processed_at timestamptz,
  outcome text,
  primary key (run_id, source_uid)
);

create index import_items_unprocessed on public.import_items (run_id) where processed_at is null;

-- After a complete run: published, upcoming events from this source that the
-- source no longer lists get flagged for a person to check (never deleted).
create function public.flag_missing_from_source(p_run_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_source uuid;
  v_status public.import_run_status;
  v_count integer;
begin
  select source_id, status into v_source, v_status from public.import_runs where id = p_run_id;
  if v_status is distinct from 'complete' then
    raise exception 'run_not_complete' using errcode = 'P0001';
  end if;
  update public.events e
  set flags = (select array_agg(distinct f) from unnest(e.flags || array['missing_from_source']) f)
  where e.source_id = v_source
    and e.status = 'approved'
    and e.end_instant > pg_catalog.now()
    and not ('missing_from_source' = any (e.flags))
    and not exists (select 1 from public.import_items i where i.run_id = p_run_id and i.source_uid = e.source_uid);
  get diagnostics v_count = row_count;

  -- Events that came back are no longer missing.
  update public.events e
  set flags = array_remove(e.flags, 'missing_from_source')
  where e.source_id = v_source
    and 'missing_from_source' = any (e.flags)
    and exists (select 1 from public.import_items i where i.run_id = p_run_id and i.source_uid = e.source_uid);
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cleanup (runs daily from the job queue). Returns what it removed.
-- ---------------------------------------------------------------------------

create function public.run_cleanup()
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

  delete from public.job_runs where started_at < pg_catalog.now() - interval '30 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('job_runs', n);

  delete from public.submission_nonces where used_at < pg_catalog.now() - interval '1 year';
  get diagnostics n = row_count; v := v || jsonb_build_object('nonces', n);

  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down
-- ---------------------------------------------------------------------------

alter table public.jobs enable row level security;
alter table public.job_runs enable row level security;
alter table public.import_runs enable row level security;
alter table public.import_items enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
