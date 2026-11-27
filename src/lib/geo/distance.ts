/**
 * Distances for "near me". Searches use a box first (a fast database
 * filter), then the exact great-circle distance, so an event in the box's
 * corner but outside the circle is left out.
 */
export interface Point {
  lat: number;
  lng: number;
}

export type Unit = 'mi' | 'km';

export interface NearFilter extends Point {
  /** The radius, in km. */
  km: number;
  /** The radius as chosen, in `unit` (10, 25, 50 or 100). */
  radius: number;
  /** How distances are shown: from the place's country. */
  unit: Unit;
  /** The place's name, as shown ("Chatham, Kent"). */
  label: string;
  /** Online events count as "near" too. */
  includeOnline: boolean;
}

/** The choices in "Within", in the place's unit. */
export const RADII = [10, 25, 50, 100] as const;

const EARTH_KM = 6371.0088;
const KM_PER_MILE = 1.609344;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Box {
  minLat: number;
  maxLat: number;
  /** One range, or two when the box crosses the date line. */
  lngRanges: Array<[number, number]>;
}

/** A box that holds every point within `km` of the centre. */
export function boundingBox(c: Point, km: number): Box {
  const dLat = (km / EARTH_KM) * (180 / Math.PI);
  const minLat = Math.max(-90, c.lat - dLat);
  const maxLat = Math.min(90, c.lat + dLat);
  // Near a pole the circle can take in every longitude.
  if (maxLat >= 89.999 || minLat <= -89.999) return { minLat, maxLat, lngRanges: [[-180, 180]] };
  const widest = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const dLng = (km / (EARTH_KM * Math.cos(rad(widest)))) * (180 / Math.PI);
  if (dLng >= 180) return { minLat, maxLat, lngRanges: [[-180, 180]] };
  const lo = c.lng - dLng;
  const hi = c.lng + dLng;
  if (lo < -180)
    return {
      minLat,
      maxLat,
      lngRanges: [
        [lo + 360, 180],
        [-180, hi],
      ],
    };
  if (hi > 180)
    return {
      minLat,
      maxLat,
      lngRanges: [
        [lo, 180],
        [-180, hi - 360],
      ],
    };
  return { minLat, maxLat, lngRanges: [[lo, hi]] };
}

export function inBox(p: Point, b: Box): boolean {
  return p.lat >= b.minLat && p.lat <= b.maxLat && b.lngRanges.some(([lo, hi]) => p.lng >= lo && p.lng <= hi);
}

/** Whether an event counts as near: online ones only when asked for, in-person ones by exact distance. */
export function withinNear(e: { format: string; lat: number | null; lng: number | null }, near: NearFilter): boolean {
  if (e.format === 'online') return near.includeOnline;
  if (e.lat === null || e.lng === null) return false;
  return haversineKm(near, { lat: e.lat, lng: e.lng }) <= near.km;
}

/** Miles where people expect them (the UK, the US, Liberia, Myanmar); km elsewhere. */
export function unitFor(countryCode: string | null | undefined): Unit {
  return countryCode && ['GB', 'US', 'LR', 'MM'].includes(countryCode.toUpperCase()) ? 'mi' : 'km';
}

export const toKm = (n: number, unit: Unit) => (unit === 'mi' ? n * KM_PER_MILE : n);

/** "under 1 mile", "12 miles", "40 km". */
export function formatDistance(km: number, unit: Unit): string {
  const n = unit === 'mi' ? km / KM_PER_MILE : km;
  if (n < 1) return unit === 'mi' ? 'under 1 mile' : 'under 1 km';
  const r = Math.round(n);
  return unit === 'mi' ? `${r} ${r === 1 ? 'mile' : 'miles'}` : `${r} km`;
}

/** The unit "Within" shows: the place's, once one is found; miles until then. */
export const shownUnit = (placed: boolean, unit: Unit): Unit => (placed && unit === 'km' ? 'km' : 'mi');

/**
 * A distance chosen in one unit, in another: the nearest choice in the
 * list (the larger on a tie), so 50 miles becomes 100 km, not 50 km.
 */
export function convertRadius(radius: number, from: Unit, to: Unit): number {
  if (from === to) return radius;
  const km = toKm(radius, from);
  const target = to === 'mi' ? km / KM_PER_MILE : km;
  let best: number = RADII[0];
  for (const r of RADII) if (Math.abs(r - target) <= Math.abs(best - target)) best = r;
  return best;
}
