-- Audit fixes for subscriber emails and data retention:
--  * digests and sign-up emails are only queued while the subscriber row is
--    locked and still eligible, so one can't slip in after an unsubscribe or
--    a bounce;
--  * unsubscribing and bounce suppression each happen in one transaction with
--    removing the copies of that address's subscription emails, and an email
--    being sent at that moment is cancelled (never retried or reclaimed);
--  * every finished outbox row goes after 90 days, whatever its status;
--  * used form codes are kept for good, because signed forms never expire
--    (WCAG 2.2.3), so the record that one was used mustn't either.

alter table public.email_outbox add column cancelled_at timestamptz;

-- The kinds that exist only because of a digest subscription.
create function public.is_subscription_email(p_kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_kind in ('digest', 'alert', 'subscribe_confirm', 'subscribe_manage');
$$;

-- Removes the copies of an address's subscription emails. One being sent
-- right now is marked cancelled instead; the trigger below deletes it as
-- soon as the sender records any result.
create function public.cancel_subscription_emails(p_email extensions.citext)
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.email_outbox
  where to_email = p_email and public.is_subscription_email(kind) and status <> 'sending';
  update public.email_outbox
  set cancelled_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where to_email = p_email and public.is_subscription_email(kind) and status = 'sending' and cancelled_at is null;
end;
$$;

-- A cancelled email whose send finished (or failed, or was put back in the
-- queue) is deleted straight away.
create function public.email_outbox_after_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.cancelled_at is not null and new.status <> 'sending' then
    delete from public.email_outbox where id = new.id;
  end if;
  return null;
end;
$$;

create trigger email_outbox_cancelled
after update on public.email_outbox
for each row when (new.cancelled_at is not null)
execute function public.email_outbox_after_update();

-- Unsubscribing: the subscriber row and their subscription emails go
-- together. Locking the row first means a digest being queued for them
-- (queue_digests holds the same lock) either finishes first and is removed
-- here, or runs after and finds no subscriber.
create function public.unsubscribe_subscriber(p_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_email extensions.citext;
begin
  select email into v_email from public.digest_subscribers where id = p_id for update;
  if not found then
    return false;
  end if;
  delete from public.digest_subscribers where id = p_id;
  perform public.cancel_subscription_emails(v_email);
  return true;
end;
$$;

-- A bounce or spam complaint: stop sending to the address (the row is kept,
-- marked suppressed, so it isn't signed up again by accident) and remove its
-- subscription emails.
create function public.suppress_address(p_email extensions.citext, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.digest_subscribers
  set suppressed_at = pg_catalog.now(), suppressed_reason = p_reason
  where email = p_email;
  perform public.cancel_subscription_emails(p_email);
end;
$$;

-- Queues digests. Each item is {subscriber, cadence, revision, email}; an
-- email is only queued if, with the row locked, the subscriber still exists,
-- is confirmed, isn't suppressed, and has the cadence and choices the digest
-- was made for. Returns how many were actually queued.
create function public.queue_digests(p_items jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_ok boolean;
  v_queued integer := 0;
  n integer;
begin
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select true into v_ok
    from public.digest_subscribers
    where id = (v_item ->> 'subscriber')::uuid
      and confirmed_at is not null
      and suppressed_at is null
      and cadence = (v_item ->> 'cadence')::public.digest_cadence
      and prefs_revision = (v_item ->> 'revision')::integer
    for update;
    if found then
      select count(*) into n from public.enqueue_emails(jsonb_build_array(v_item -> 'email'));
      v_queued := v_queued + n;
    end if;
  end loop;
  return v_queued;
end;
$$;

-- Queues a sign-up email (confirm or manage link) while the subscriber row is
-- locked and still exists and isn't suppressed.
create function public.queue_subscriber_email(p_subscriber uuid, p_email jsonb)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.digest_subscribers
  where id = p_subscriber and suppressed_at is null
  for update;
  if not found then
    return false;
  end if;
  perform public.enqueue_emails(jsonb_build_array(p_email));
  return true;
end;
$$;

-- Cancelled emails are never claimed again.
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
    and cancelled_at is null
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
      and c.cancelled_at is null
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

  -- Copies of emails are kept 90 days once they're finished with, whatever
  -- happened to them. A cancelled one stuck in sending (its sender stopped)
  -- goes once its lease has run out.
  delete from public.email_outbox
  where (status not in ('queued', 'sending') and updated_at < pg_catalog.now() - interval '90 days')
     or (cancelled_at is not null and status = 'sending' and lease_until < pg_catalog.now());
  get diagnostics n = row_count; v := v || jsonb_build_object('old_emails', n);

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

  -- Used form codes (submission_nonces) are never deleted: see the top of this file.

  return v;
end;
$$;

create or replace function public.run_cleanup_digest()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := '{}'::jsonb;
  n integer;
  v_email extensions.citext;
begin
  -- Unconfirmed sign-ups go after 7 days, with the emails sent to them.
  n := 0;
  for v_email in
    delete from public.digest_subscribers
    where confirmed_at is null and created_at < pg_catalog.now() - interval '7 days'
    returning email
  loop
    perform public.cancel_subscription_emails(v_email);
    n := n + 1;
  end loop;
  v := v || jsonb_build_object('unconfirmed_subscribers', n);
  delete from public.tokens where expires_at < pg_catalog.now() - interval '1 day' or used_at < pg_catalog.now() - interval '1 day';
  get diagnostics n = row_count; v := v || jsonb_build_object('tokens', n);
  -- Alert changes: only once they're 60 days old and every active alert
  -- subscriber has been sent them; anything over 180 days goes regardless.
  delete from public.event_changes c
  where (
      c.created_at < pg_catalog.now() - interval '60 days'
      and c.seq is not null
      and c.seq <= coalesce(
        (select min(s.alert_cursor) from public.digest_subscribers s
         where s.cadence in ('daily', 'instant') and s.confirmed_at is not null
           and s.suppressed_at is null and s.alert_cursor is not null),
        c.seq)
    )
    or c.created_at < pg_catalog.now() - interval '180 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('event_changes', n);
  -- Finished alert rounds (an instant one every 10 minutes) are kept 30 days.
  delete from public.alert_rounds where status = 'complete' and started_at < pg_catalog.now() - interval '30 days';
  get diagnostics n = row_count; v := v || jsonb_build_object('alert_rounds', n);
  return v;
end;
$$;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
