/** Places in links: "?at=51.38,0.52" holds a position, so a shared link needs no lookup. */
import type { Point } from './distance.ts';

const AT = /^(-?\d{1,2}(?:\.\d{1,6})?),(-?\d{1,3}(?:\.\d{1,6})?)$/;

/** A position from "lat,lng" (up to 6 decimals), or null if it isn't one. */
export function parseAt(value: string | null | undefined): Point | null {
  const m = AT.exec(value ?? '');
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** "51.38,0.52", rounded to 5 decimals (about a metre). */
export function formatAt(p: Point): string {
  const r = (n: number) => Number(n.toFixed(5));
  return `${r(p.lat)},${r(p.lng)}`;
}

/** The longest place name kept: as long as a found place's label can be. */
export const NEAR_MAX = 200;
