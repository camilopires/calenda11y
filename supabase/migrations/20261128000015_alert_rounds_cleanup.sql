-- Instant alert rounds are recorded every 10 minutes; finished ones older
-- than 30 days are removed by the daily cleanup.

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

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
