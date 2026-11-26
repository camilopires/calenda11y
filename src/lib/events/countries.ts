import { db } from '../db.ts';
import { unwrap } from '../result.ts';
import { countryName } from './model.ts';

let cache: Array<{ code: string; name: string }> | undefined;

/** Every country, sorted by English name. */
export async function allCountries(): Promise<Array<{ code: string; name: string }>> {
  if (!cache) {
    const rows = unwrap(await db().from('countries').select('code'), 'supabase', 'reading countries') as Array<{
      code: string;
    }>;
    cache = rows
      .map((r) => ({ code: r.code, name: countryName(r.code) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }
  return cache;
}
