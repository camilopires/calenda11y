/**
 * Turning a typed place into a position, for pages with the filter form.
 * One match: the page redirects to the same search with the position in
 * the link. Several: the page asks which one. None (or the service is busy
 * or off): an error on the "Near" field. Feeds never call this.
 */
import { lookupPlace } from './lookup.ts';
import { formatAt } from './place.ts';
import { convertRadius, shownUnit, unitFor } from './distance.ts';

export type Resolution =
  | { kind: 'redirect'; href: string }
  | { kind: 'choose'; choices: Array<{ label: string; href: string }> }
  | { kind: 'error'; message: string };

/** A link to the same page and filters, with this place chosen. */
function withPlace(url: URL, p: { label: string; lat: number; lng: number; countryCode: string | null }): string {
  const q = new URLSearchParams(url.searchParams);
  // "Within" was showing the old place's unit (or miles); keep the distance chosen in the new one.
  const shown = shownUnit(!!q.get('at'), q.get('u') === 'km' ? 'km' : 'mi');
  const unit = unitFor(p.countryCode);
  const within = Number(q.get('within') || 25);
  q.set('near', p.label);
  q.set('at', formatAt(p));
  q.set('u', unit);
  q.set('within', String(convertRadius(within, shown, unit)));
  q.delete('near_from');
  q.delete('page');
  return `${url.pathname}?${q}`;
}

export async function resolveNear(text: string, url: URL, ip: string): Promise<Resolution> {
  const r = await lookupPlace(text, { ip });
  if (!r.ok) {
    return {
      kind: 'error',
      message:
        r.reason === 'busy'
          ? 'Too many place searches right now. Try again in a moment.'
          : r.reason === 'off'
            ? 'Place search is not available right now.'
            : "We couldn't look up places just now. Try again later.",
    };
  }
  if (!r.places.length) return { kind: 'error', message: "We couldn't find that place. Try a town or city name" };
  if (r.places.length === 1) return { kind: 'redirect', href: withPlace(url, r.places[0]!) };
  return { kind: 'choose', choices: r.places.map((p) => ({ label: p.label, href: withPlace(url, p) })) };
}
