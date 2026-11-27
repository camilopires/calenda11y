import { describe, expect, it } from 'vitest';
import {
  RADII,
  boundingBox,
  formatDistance,
  haversineKm,
  inBox,
  toKm,
  unitFor,
  withinNear,
} from '../../src/lib/geo/distance.ts';
import { parseAt } from '../../src/lib/geo/place.ts';

const LONDON = { lat: 51.5074, lng: -0.1278 };
const PARIS = { lat: 48.8566, lng: 2.3522 };

/** The point `km` away from `p` on bearing `deg`. */
function destination(p: { lat: number; lng: number }, km: number, deg: number) {
  const R = 6371.0088;
  const d = km / R;
  const b = (deg * Math.PI) / 180;
  const lat1 = (p.lat * Math.PI) / 180;
  const lng1 = (p.lng * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 =
    lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  let lng = (lng2 * 180) / Math.PI;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return { lat: (lat2 * 180) / Math.PI, lng };
}

describe('distances', () => {
  it('London to Paris is about 344 km', () => {
    expect(haversineKm(LONDON, PARIS)).toBeGreaterThan(342);
    expect(haversineKm(LONDON, PARIS)).toBeLessThan(346);
  });

  it.each([
    ['Chatham', { lat: 51.38, lng: 0.52 }],
    ['near the date line', { lat: -17.7, lng: 179.9 }],
    ['the other side of it', { lat: -17.7, lng: -179.95 }],
    ['near the north pole', { lat: 89.2, lng: 10 }],
  ])('the box around %s holds every point on the circle', (_name, centre) => {
    for (const km of [10, 100]) {
      const box = boundingBox(centre, km);
      for (let deg = 0; deg < 360; deg += 15) expect(inBox(destination(centre, km * 0.999, deg), box)).toBe(true);
    }
  });

  it('splits the box at the date line', () => {
    const box = boundingBox({ lat: -17.7, lng: 179.9 }, 50);
    expect(box.lngRanges).toHaveLength(2);
    expect(box.lngRanges.some(([min]) => min === -180)).toBe(true);
  });

  it('covers every longitude near a pole', () => {
    expect(boundingBox({ lat: 89.5, lng: 0 }, 100).lngRanges).toEqual([[-180, 180]]);
  });

  it('withinNear is exact: inside the box but outside the circle is out', () => {
    const near = {
      lat: 51.38,
      lng: 0.52,
      km: 40,
      radius: 25,
      unit: 'mi' as const,
      label: 'Chatham',
      includeOnline: false,
    };
    expect(withinNear({ format: 'in_person', lat: 51.5, lng: 0.6 }, near)).toBe(true);
    const corner = destination({ lat: 51.38, lng: 0.52 }, 40 * 1.3, 45);
    expect(inBox(corner, boundingBox(near, 40))).toBe(true);
    expect(withinNear({ format: 'in_person', ...corner }, near)).toBe(false);
    expect(withinNear({ format: 'in_person', lat: null, lng: null }, near)).toBe(false);
    expect(withinNear({ format: 'online', lat: null, lng: null }, near)).toBe(false);
    expect(withinNear({ format: 'online', lat: null, lng: null }, { ...near, includeOnline: true })).toBe(true);
  });
});

describe('units and wording', () => {
  it('miles for the UK and the US, km elsewhere', () => {
    expect(unitFor('GB')).toBe('mi');
    expect(unitFor('US')).toBe('mi');
    expect(unitFor('PT')).toBe('km');
    expect(unitFor(null)).toBe('km');
  });

  it('converts and words distances', () => {
    expect(RADII).toEqual([10, 25, 50, 100]);
    expect(toKm(25, 'mi')).toBeCloseTo(40.234, 2);
    expect(toKm(25, 'km')).toBe(25);
    expect(formatDistance(0.5, 'mi')).toBe('under 1 mile');
    expect(formatDistance(1.7, 'mi')).toBe('1 mile');
    expect(formatDistance(19.6, 'mi')).toBe('12 miles');
    expect(formatDistance(0.4, 'km')).toBe('under 1 km');
    expect(formatDistance(40.4, 'km')).toBe('40 km');
  });
});

describe('parseAt', () => {
  it('reads a position from a link, and refuses anything else', () => {
    expect(parseAt('51.38,0.52')).toEqual({ lat: 51.38, lng: 0.52 });
    expect(parseAt('-17.71234,179.9')).toEqual({ lat: -17.71234, lng: 179.9 });
    for (const bad of ['91,0', '0,181', '51.38', 'a,b', '51.381234567,0.5', '', '1e2,3'])
      expect(parseAt(bad)).toBeNull();
  });
});
