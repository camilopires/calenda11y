// Writes the local Supabase URL and keys into .env (creating it from
// .env.example if needed). Run after `pnpm exec supabase start`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readLocalSupabase } from './local-supabase.ts';

const local = readLocalSupabase();
const file = existsSync('.env') ? readFileSync('.env', 'utf8') : readFileSync('.env.example', 'utf8');
const values: Record<string, string> = {
  SUPABASE_URL: local.SUPABASE_URL,
  SUPABASE_ANON_KEY: local.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: local.SUPABASE_SERVICE_ROLE_KEY,
};
let out = file;
for (const [key, value] of Object.entries(values)) {
  const line = `${key}=${value}`;
  out = new RegExp(`^${key}=.*$`, 'm').test(out)
    ? out.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${out}\n${line}\n`;
}
writeFileSync('.env', out);
console.log('Wrote local Supabase settings to .env');
