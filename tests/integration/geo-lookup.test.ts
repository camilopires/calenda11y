import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { lookupPlace } from '../../src/lib/geo/lookup.ts';
import { FakeGeocoder, setGeocoder } from '../../src/lib/services/geocoder.ts';
import { service } from './helpers.ts';

const db = service();
let fake: FakeGeocoder;
beforeEach(async () => {
  fake = new FakeGeocoder();
  setGeocoder(fake);
  await db.from('place_lookups').delete().in('query_key', ['chatham', 'lisbon', 'medway', 'atlantis']);
  await db.from('geocode_slots').delete().in('key', ['nominatim', 'nominatim-job']);
});
afterAll(() => setGeocoder(undefined));

describe('lookupPlace', () => {
  it('looks a place up once, then answers from the cache', async () => {
    const first = await lookupPlace('Chatham', { ip: '203.0.113.1' });
    expect(first).toMatchObject({ ok: true, places: [{ label: 'Chatham, Kent, United Kingdom', countryCode: 'GB' }] });
    const second = await lookupPlace('  chatham ', { ip: '203.0.113.1' });
    expect(second).toEqual(first);
    expect(fake.calls).toEqual(['Chatham']);
  });

  it('caches "nothing found" too, and looks again after 30 days', async () => {
    expect(await lookupPlace('Atlantis', { ip: '203.0.113.2' })).toEqual({ ok: true, places: [] });
    await db
      .from('place_lookups')
      .update({ looked_up_at: new Date(Date.now() - 31 * 86_400_000).toISOString() })
      .eq('query_key', 'atlantis');
    await lookupPlace('atlantis', { ip: '203.0.113.2' });
    expect(fake.calls).toHaveLength(2);
  });

  it('says "busy" rather than waiting long when the shared limit is taken', async () => {
    await db.from('geocode_slots').upsert({ key: 'nominatim', next_at: new Date(Date.now() + 10_000).toISOString() });
    expect(await lookupPlace('Lisbon', { ip: '203.0.113.3' })).toEqual({ ok: false, reason: 'busy' });
    expect(fake.calls).toEqual([]);
  });

  it('waits its turn: two lookups in a row are at least a second apart', async () => {
    const times: number[] = [];
    setGeocoder({
      search: async (q) => {
        times.push(Date.now());
        return fake.search(q);
      },
    });
    await lookupPlace('Lisbon', { ip: '203.0.113.4' });
    await lookupPlace('Medway', { ip: '203.0.113.4' });
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(950);
  });

  it('the background job never asks in the same second as a visitor', async () => {
    const times: Array<[string, number]> = [];
    setGeocoder({
      search: async (q) => {
        times.push([q, Date.now()]);
        return fake.search(q);
      },
    });
    // The job's own turn is 2 seconds away.
    await db.from('geocode_slots').upsert({ key: 'nominatim-job', next_at: new Date(Date.now() + 2000).toISOString() });
    const job = lookupPlace('Lisbon', { job: { deadline: Date.now() + 30_000 } });
    // A visitor arrives just as the job's turn comes.
    await new Promise((r) => setTimeout(r, 1900));
    await lookupPlace('Medway', { ip: '203.0.113.6' });
    await job;
    expect(times).toHaveLength(2);
    expect(Math.abs(times[0]![1] - times[1]![1])).toBeGreaterThanOrEqual(950);
  });

  it('refused searches do not push the next one back', async () => {
    await db.from('geocode_slots').upsert({ key: 'nominatim', next_at: new Date(Date.now() + 3500).toISOString() });
    for (const ip of ['203.0.113.7', '203.0.113.8', '203.0.113.9'])
      expect(await lookupPlace('Lisbon', { ip })).toEqual({ ok: false, reason: 'busy' });
    const { data } = await db.from('geocode_slots').select('next_at').eq('key', 'nominatim').single();
    expect(Date.parse(data!.next_at) - Date.now()).toBeLessThan(3600);
  });

  it('the same place searched at once is asked for only once', async () => {
    const both = await Promise.all([
      lookupPlace('Lisbon', { ip: '203.0.113.10' }),
      lookupPlace('lisbon', { ip: '203.0.113.11' }),
    ]);
    expect(both[0]).toEqual(both[1]);
    expect(fake.calls).toHaveLength(1);
  });

  it('reports a failing service without caching it', async () => {
    setGeocoder({
      search: async () => {
        throw new Error('down');
      },
    });
    expect(await lookupPlace('Medway', { ip: '203.0.113.5' })).toEqual({ ok: false, reason: 'error' });
    const { data } = await db.from('place_lookups').select('query_key').eq('query_key', 'medway');
    expect(data).toEqual([]);
  });
});
