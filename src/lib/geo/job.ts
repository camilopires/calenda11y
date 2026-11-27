/**
 * The background job that finds event positions. One worker, at most 4
 * lookups a minute (Nominatim's limit for scheduled jobs), sharing the place
 * cache with visitor searches so the same place is never asked twice. It
 * tries "venue, town, country" first, then "town, country".
 */
import { db } from '../db.ts';
import { countryName } from '../events/model.ts';
import { unwrap } from '../result.ts';
import { lookupPlace } from './lookup.ts';

const BATCH = 30;
const RETRY_AFTER_MS = 24 * 3600_000;

interface Waiting {
  id: string;
  format: string;
  venue: string | null;
  city: string | null;
  country_code: string | null;
}

export async function runGeocode(
  deadline: number,
  options: { jobSpacingMs?: number; limit?: number } = {},
): Promise<{ finished: boolean; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  // Failed lookups get another go after a day.
  unwrap(
    await db()
      .from('events')
      .update({ geo_status: 'pending' })
      .eq('geo_status', 'failed')
      .lt('geo_checked_at', new Date(Date.now() - RETRY_AFTER_MS).toISOString())
      .select('id'),
    'supabase',
    'retrying failed lookups',
  );

  const waiting = unwrap(
    await db()
      .from('events')
      .select('id,format,venue,city,country_code')
      .eq('geo_status', 'pending')
      .in('status', ['approved', 'cancelled', 'pending'])
      .neq('format', 'online')
      .order('created_at')
      .limit(options.limit ?? BATCH),
    'supabase',
    'listing events to locate',
  ) as Waiting[];

  for (const e of waiting) {
    if (Date.now() >= deadline) return { finished: false, counts };
    const country = e.country_code ? countryName(e.country_code) : null;
    const queries = [
      ...(e.venue && e.city ? [[e.venue, e.city, country]] : []),
      ...(e.city ? [[e.city, country]] : []),
    ].map((parts) => parts.filter(Boolean).join(', '));

    let outcome: { status: 'found'; lat: number; lng: number; query: string } | { status: 'not_found' | 'failed' } = {
      status: 'not_found',
    };
    for (const q of queries) {
      const r = await lookupPlace(q, {
        job: { deadline, ...(options.jobSpacingMs && { spacingMs: options.jobSpacingMs }) },
      });
      if (!r.ok && r.reason === 'busy') return { finished: true, counts };
      if (!r.ok) {
        outcome = { status: 'failed' };
        break;
      }
      const best = r.places[0];
      if (best) {
        outcome = { status: 'found', lat: best.lat, lng: best.lng, query: q };
        break;
      }
    }

    // Only if the event's place hasn't changed meanwhile.
    let q = db()
      .from('events')
      .update(
        outcome.status === 'found'
          ? {
              geo_status: 'found',
              lat: outcome.lat,
              lng: outcome.lng,
              geo_query: outcome.query,
              geo_checked_at: new Date().toISOString(),
            }
          : { geo_status: outcome.status, geo_checked_at: new Date().toISOString() },
      )
      .eq('id', e.id)
      .eq('geo_status', 'pending')
      .eq('format', e.format);
    q = e.venue === null ? q.is('venue', null) : q.eq('venue', e.venue);
    q = e.city === null ? q.is('city', null) : q.eq('city', e.city);
    q = e.country_code === null ? q.is('country_code', null) : q.eq('country_code', e.country_code);
    const saved = unwrap(await q.select('id'), 'supabase', 'saving event position') as unknown[];
    bump(saved.length ? outcome.status : 'moved_meanwhile');
  }
  return { finished: true, counts };
}
