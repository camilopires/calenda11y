import { createClient } from '@supabase/supabase-js';

export const url = () => process.env.SUPABASE_URL!;
export const anon = () =>
  createClient(url(), process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
export const service = () =>
  createClient(url(), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Calls PostgREST directly, the way an attacker with the anon key would. */
export async function rest(path: string, init: RequestInit & { token?: string } = {}) {
  const key = process.env.SUPABASE_ANON_KEY!;
  return fetch(`${url()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${init.token ?? key}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

/** Creates a confirmed, signed-in user who is not an admin. */
export async function signedInUser(email = `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`) {
  const password = `pw-${Math.random().toString(36).slice(2)}-A1!`;
  const admin = service();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const client = anon();
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  return { client, token: signed.data.session!.access_token, userId: created.data.user!.id };
}
