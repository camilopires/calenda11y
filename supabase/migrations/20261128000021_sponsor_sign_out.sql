-- Signing a sponsor out everywhere. Each sponsor session cookie carries the
-- session version it was issued for; an admin bumps the version to make every
-- existing cookie stop working.

alter table public.sponsors
  add column session_version integer not null default 1 check (session_version >= 1);

-- Returns the new version, or null if there's no such sponsor.
create function public.sign_out_sponsor(p_id uuid)
returns integer
language sql
set search_path = ''
as $$
  update public.sponsors set session_version = session_version + 1 where id = p_id returning session_version;
$$;

revoke execute on function public.sign_out_sponsor(uuid) from public, anon, authenticated;
grant execute on function public.sign_out_sponsor(uuid) to service_role;
