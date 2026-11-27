import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { settlePlace } from '../../src/lib/digest/place.ts';
import { readPreferences } from '../../src/lib/digest/form.ts';
import { resolveNear } from '../../src/lib/geo/resolve.ts';
import { FakeGeocoder, setGeocoder } from '../../src/lib/services/geocoder.ts';
import { service } from './helpers.ts';

const db = service();
beforeEach(async () => {
  setGeocoder(new FakeGeocoder());
  await db.from('geocode_slots').delete().eq('key', 'nominatim');
});
afterAll(() => setGeocoder(undefined));

describe('a place found in another unit', () => {
  it('the list keeps the distance chosen in miles, in km', async () => {
    const r = await resolveNear('Lisbon', new URL('http://x/?near=Lisbon&within=50'), '203.0.113.20');
    expect(r.kind).toBe('redirect');
    const q = new URL(r.kind === 'redirect' ? r.href : '', 'http://x').searchParams;
    expect([q.get('u'), q.get('within')]).toEqual(['km', '100']);
  });

  it('the list keeps a distance already in km when the new place is in km too', async () => {
    const r = await resolveNear(
      'Lisbon',
      new URL('http://x/?near=Lisbon&near_from=Porto&at=41.15,-8.62&u=km&within=50'),
      '203.0.113.21',
    );
    const q = new URL(r.kind === 'redirect' ? r.href : '', 'http://x').searchParams;
    expect([q.get('u'), q.get('within')]).toEqual(['km', '50']);
  });

  it('the email sign-up does the same', async () => {
    const fd = new FormData();
    fd.set('cadence', 'weekly');
    fd.set('near', 'Lisbon');
    fd.set('near_within', '50');
    const r = await settlePlace(readPreferences(fd), '203.0.113.22');
    expect(r.kind === 'ok' && r.prefs.near).toMatchObject({ unit: 'km', radius: 100 });
  });
});
