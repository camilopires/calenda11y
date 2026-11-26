import { ensureLocalSupabaseEnv } from '../../scripts/local-supabase.ts';

export default function setup(): void {
  ensureLocalSupabaseEnv();
}
