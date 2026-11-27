/**
 * Finding places for "near me", with OpenStreetMap's Nominatim by default.
 *
 * Its usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * applies: at most 1 request a second in total and 4 a minute from scheduled
 * jobs (both enforced by lookupPlace in geo/lookup.ts), an identifying
 * User-Agent, results cached, no auto-complete, no personal data, and the
 * service must be switchable without a release (GEOCODER_URL, GEOCODER_OFF).
 */
import { env } from '../env.ts';
import { ServiceError } from '../result.ts';

export interface Place {
  /** "Chatham, Kent, United Kingdom" */
  label: string;
  lat: number;
  lng: number;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string | null;
}

export interface Geocoder {
  search(query: string): Promise<Place[]>;
}

interface NominatimResult {
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string | undefined>;
}

/** "Chatham, Kent, United Kingdom" from Nominatim's (long) address. */
export function placeFromNominatim(r: NominatimResult): Place | null {
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const a = r.address ?? {};
  const name =
    a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb ?? a.municipality ?? r.name ?? r.display_name?.split(',')[0];
  const area = a.county ?? a.state_district ?? a.state;
  const parts = [name, area !== name ? area : undefined, a.country].filter((p): p is string => !!p?.trim());
  return {
    label: (parts.length ? parts.join(', ') : (r.display_name ?? '')).slice(0, 200),
    lat,
    lng,
    countryCode: a.country_code ? a.country_code.toUpperCase() : null,
  };
}

export class Nominatim implements Geocoder {
  readonly #url: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  constructor(url: string, siteUrl: string, fetchImpl: typeof fetch = fetch) {
    this.#url = url;
    this.#userAgent = `calenda11y/1.0 (+${siteUrl})`;
    this.#fetch = fetchImpl;
  }

  async search(query: string): Promise<Place[]> {
    const u = new URL(this.#url);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('addressdetails', '1');
    u.searchParams.set('limit', '5');
    u.searchParams.set('q', query);
    let res: Response;
    try {
      res = await this.#fetch(u, {
        headers: { 'User-Agent': this.#userAgent, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new ServiceError('geocoder', `place search failed: ${error instanceof Error ? error.message : error}`);
    }
    if (!res.ok) throw new ServiceError('geocoder', `place search answered HTTP ${res.status}`);
    const body = (await res.json()) as NominatimResult[];
    if (!Array.isArray(body)) throw new ServiceError('geocoder', 'place search gave an unexpected answer');
    return body.map(placeFromNominatim).filter((p): p is Place => p !== null);
  }
}

/** Test fake: a few fixed places, so tests never call the real service. */
export class FakeGeocoder implements Geocoder {
  calls: string[] = [];
  static readonly PLACES: Record<string, Place[]> = {
    medway: [
      { label: 'Medway, Kent, United Kingdom', lat: 51.38, lng: 0.52, countryCode: 'GB' },
      { label: 'Medway, Norfolk County, United States', lat: 42.1418, lng: -71.3967, countryCode: 'US' },
    ],
    chatham: [{ label: 'Chatham, Kent, United Kingdom', lat: 51.3807, lng: 0.5214, countryCode: 'GB' }],
    lisbon: [{ label: 'Lisbon, Portugal', lat: 38.7223, lng: -9.1393, countryCode: 'PT' }],
    'the historic dockyard, chatham, united kingdom': [
      { label: 'Chatham, Kent, United Kingdom', lat: 51.396, lng: 0.527, countryCode: 'GB' },
    ],
    'chatham, united kingdom': [
      { label: 'Chatham, Kent, United Kingdom', lat: 51.3807, lng: 0.5214, countryCode: 'GB' },
    ],
    'porto, portugal': [{ label: 'Porto, Portugal', lat: 41.1579, lng: -8.6291, countryCode: 'PT' }],
  };
  async search(query: string): Promise<Place[]> {
    this.calls.push(query);
    return FakeGeocoder.PLACES[query.trim().toLowerCase().replace(/\s+/g, ' ')] ?? [];
  }
}

let instance: Geocoder | undefined;

export function geocoder(): Geocoder {
  if (!instance) {
    const e = env();
    instance = e.APP_ENV === 'test' ? new FakeGeocoder() : new Nominatim(e.GEOCODER_URL, e.SITE_URL);
  }
  return instance;
}

/** For tests. */
export function setGeocoder(g: Geocoder | undefined): void {
  instance = g;
}
