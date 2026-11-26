import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, requireEnv } from './env.ts';

const HINT = 'Run `pnpm exec supabase start` and then `pnpm env:local`.';

let service: SupabaseClient | undefined;

/**
 * The server's database client. It uses the service role, so every caller is
 * responsible for checking permissions first (public pages read only the
 * public_* views; admin code calls requireAdmin()).
 */
export function db(): SupabaseClient {
  service ??= createClient(env().SUPABASE_URL, requireEnv('SUPABASE_SERVICE_ROLE_KEY', HINT), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-client-info': 'calenda11y-server' } },
  });
  return service;
}

export function anonKey(): string {
  return requireEnv('SUPABASE_ANON_KEY', HINT);
}
