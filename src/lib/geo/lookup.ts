/**
 * Looking places up, within OpenStreetMap Nominatim's usage policy:
 *  - every answer (even "nothing found") is cached for 30 days, so the same
 *    search is never sent twice;
 *  - lookups are spaced exactly: 1 second apart for everyone together, and
 *    15 seconds apart (4 a minute) for the background job;
 *  - visitors also have a per-connection limit, and get "busy" rather than
 *    a long wait.
 * Nothing about the visitor is sent: only what they typed.
 */
import { db } from '../db.ts';
import { env } from '../env.ts';
import { unwrap, unwrapMaybe } from '../result.ts';
import { LIMITS, allow } from '../security/ratelimit.ts';
import { geocoder, type Place } from '../services/geocoder.ts';

const CACHE_DAYS = 30;
const SPACING_MS = 1000;
const JOB_SPACING_MS = 15_000;
/** Visitors don't wait longer than this for their turn. */
const MAX_VISITOR_WAIT_MS = 3000;

export type LookupResult = { ok: true; places: Place[] } | { ok: false; reason: 'busy' | 'error' | 'off' };

/** The cache key: lower case, spaces squashed. */
export const placeKey = (query: string) => query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reserve(key: string, spacing: number): Promise<number> {
  const at = unwrap(
    await db().rpc('reserve_geocode_slot', { p_key: key, p_spacing_ms: spacing }),
    'supabase',
    'reserving a lookup slot',
  ) as string;
  return Date.parse(at);
}

export async function lookupPlace(
  query: string,
  options: { ip?: string; job?: { deadline: number } } = {},
): Promise<LookupResult> {
  const key = placeKey(query);
  if (!key) return { ok: true, places: [] };

  const cached = unwrapMaybe(
    await db()
      .from('place_lookups')
      .select('results')
      .eq('query_key', key)
      .gt('looked_up_at', new Date(Date.now() - CACHE_DAYS * 86_400_000).toISOString())
      .maybeSingle(),
    'supabase',
    'reading place cache',
  ) as { results: Place[] } | null;
  if (cached) return { ok: true, places: cached.results };

  if (env().GEOCODER_OFF === '1') return { ok: false, reason: 'off' };
  if (options.ip && !(await allow(LIMITS.placeSearchPerIp, options.ip))) return { ok: false, reason: 'busy' };

  // The job keeps to 4 a minute; everyone together keeps to 1 a second.
  let startAt = await reserve('nominatim', SPACING_MS);
  if (options.job) startAt = Math.max(startAt, await reserve('nominatim-job', JOB_SPACING_MS));
  const wait = startAt - Date.now();
  if (!options.job && wait > MAX_VISITOR_WAIT_MS) return { ok: false, reason: 'busy' };
  if (options.job && startAt > options.job.deadline) return { ok: false, reason: 'busy' };
  if (wait > 0) await sleep(wait);

  let places: Place[];
  try {
    places = (await geocoder().search(query.trim().slice(0, 300))).slice(0, 5);
  } catch (error) {
    console.error('[geocoder] lookup failed', error);
    return { ok: false, reason: 'error' };
  }
  unwrap(
    await db()
      .from('place_lookups')
      .upsert({ query_key: key, results: places, looked_up_at: new Date().toISOString() })
      .select('query_key'),
    'supabase',
    'saving place lookup',
  );
  return { ok: true, places };
}
