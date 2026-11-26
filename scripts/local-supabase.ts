import { execFileSync } from 'node:child_process';

export interface LocalSupabase {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  DB_URL: string;
}

/** Reads the running local Supabase stack's URL and keys from `supabase status`. */
export function readLocalSupabase(): LocalSupabase {
  let raw: string;
  try {
    raw = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(
      `Couldn't read the local Supabase status. Is it running? Try \`pnpm exec supabase start\`.\n${error}`,
    );
  }
  const json = JSON.parse(raw.slice(raw.indexOf('{'))) as Record<string, string>;
  const need = (k: string) => {
    const v = json[k];
    if (!v) throw new Error(`\`supabase status\` didn't report ${k}`);
    return v;
  };
  return {
    SUPABASE_URL: need('API_URL'),
    SUPABASE_ANON_KEY: need('ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: need('SERVICE_ROLE_KEY'),
    DB_URL: need('DB_URL'),
  };
}

/** Fills any missing Supabase variables in process.env from the local stack. */
export function ensureLocalSupabaseEnv(): void {
  if (process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const local = readLocalSupabase();
  process.env.SUPABASE_URL ??= local.SUPABASE_URL;
  process.env.SUPABASE_ANON_KEY ??= local.SUPABASE_ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= local.SUPABASE_SERVICE_ROLE_KEY;
  process.env.DB_URL ??= local.DB_URL;
}
