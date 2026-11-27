-- Fixes from the implementation review.

-- ---------------------------------------------------------------------------
-- Outbox: never resend anything that might already have been sent more than
-- 24 hours ago (past Resend's de-duplication window). That covers rows stuck
-- in 'sending' and rows put back in the queue after an attempt whose outcome
-- isn't certain (for example the send worked but saving that failed).
-- Claims also hand back the lease, so a sender only saves rows it still owns.
-- ---------------------------------------------------------------------------

create or replace function public.claim_outbox(p_limit integer, p_lease_seconds integer, p_ids uuid[] default null)
returns setof public.email_outbox
language plpgsql
set search_path = ''
as $$
begin
  update public.email_outbox
  set status = 'unknown', lease_until = null, updated_at = pg_catalog.now(),
      last_error = coalesce(last_error, 'An earlier attempt may have sent this more than 24 hours ago; check whether it arrived')
  where first_sent_attempt_at < pg_catalog.now() - interval '24 hours'
    and (
      (status = 'sending' and lease_until < pg_catalog.now())
      or (status = 'queued' and attempts > 0)
    );

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
-- Imports: a run that stopped early (too many items) is not a full snapshot,
-- so it must never mark events as missing. Completing a run and flagging
-- missing events happen in one transaction.
-- ---------------------------------------------------------------------------

alter table public.import_runs add column truncated boolean not null default false;

create or replace function public.flag_missing_from_source(p_run_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_source uuid;
  v_status public.import_run_status;
  v_truncated boolean;
  v_count integer := 0;
begin
  select source_id, status, truncated into v_source, v_status, v_truncated from public.import_runs where id = p_run_id;
  if v_status is distinct from 'complete' then
    raise exception 'run_not_complete' using errcode = 'P0001';
  end if;

  -- Events that came back are no longer missing (true even for a partial read).
  update public.events e
  set flags = array_remove(e.flags, 'missing_from_source')
  where e.source_id = v_source
    and 'missing_from_source' = any (e.flags)
    and exists (select 1 from public.import_items i where i.run_id = p_run_id and i.source_uid = e.source_uid);

  if v_truncated then
    return 0;
  end if;

  update public.events e
  set flags = (select array_agg(distinct f) from unnest(e.flags || array['missing_from_source']) f)
  where e.source_id = v_source
    and e.status = 'approved'
    and e.end_instant > pg_catalog.now()
    and not ('missing_from_source' = any (e.flags))
    and not exists (select 1 from public.import_items i where i.run_id = p_run_id and i.source_uid = e.source_uid);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.complete_import_run(p_run_id uuid, p_counts jsonb, p_skipped jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_missing integer;
begin
  update public.import_runs
  set status = 'complete', counts = p_counts, skipped = p_skipped, fetch_cursor = null, finished_at = pg_catalog.now()
  where id = p_run_id and status = 'processing';
  if not found then
    raise exception 'run_not_processing' using errcode = 'P0001';
  end if;
  v_missing := public.flag_missing_from_source(p_run_id);
  update public.import_runs
  set counts = counts || jsonb_build_object('missing_from_source', v_missing)
  where id = p_run_id;
  return v_missing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Digest: using a confirmation link and confirming happen together, so a
-- failure part-way never leaves a used link and an unconfirmed subscriber.
-- ---------------------------------------------------------------------------

create function public.confirm_subscription(p_hash text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_subject uuid;
begin
  update public.tokens set used_at = pg_catalog.now()
  where purpose = 'subscribe_confirm' and hash = p_hash and used_at is null and expires_at > pg_catalog.now()
  returning subject_id into v_subject;
  if v_subject is null then
    return null;
  end if;
  update public.digest_subscribers
  set confirmed_at = coalesce(confirmed_at, pg_catalog.now()), suppressed_at = null, suppressed_reason = null, updated_at = pg_catalog.now()
  where id = v_subject;
  if not found then
    raise exception 'subscriber_missing' using errcode = 'P0001';
  end if;
  return v_subject;
end;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
