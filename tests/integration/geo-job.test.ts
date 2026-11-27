import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runGeocode } from '../../src/lib/geo/job.ts';
import { FakeGeocoder, setGeocoder } from '../../src/lib/services/geocoder.ts';
import { service } from './helpers.ts';

const db = service();
const tag = `geojob${Date.now()}`;
const ids: string[] = [];
let fake: FakeGeocoder;
// Tests don't wait 15 seconds between the job's lookups.
const FAST = { jobSpacingMs: 1 };

beforeEach(async () => {
  fake = new FakeGeocoder();
  setGeocoder(fake);
  await db.from('geocode_slots').delete().in('key', ['nominatim', 'nominatim-job']);
  await db
    .from('place_lookups')
    .delete()
    .in('query_key', [
      'the historic dockyard, chatham, united kingdom',
      'chatham, united kingdom',
      'nowhere hall, atlantis, united kingdom',
      'atlantis, united kingdom',
      'the old mill, porto, portugal',
      'porto, portugal',
    ]);
  // Only this file's events are waiting.
  await db
    .from('events')
    .update({ geo_status: 'not_found' })
    .eq('geo_status', 'pending')
    .not('slug', 'like', `${tag}%`);
});
afterAll(async () => {
  setGeocoder(undefined);
  if (ids.length) await db.from('events').delete().in('id', ids);
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
async function event(fields: Record<string, unknown>) {
  const { data, error } = await db
    .from('events')
    .insert({
      slug: `${tag}-${uniq()}`,
      title: tag,
      summary: 'A test.',
      timezone: 'UTC',
      format: 'in_person',
      country_code: 'GB',
      starts_at: '2033-03-01T10:00:00Z',
      ends_at: '2033-03-01T12:00:00Z',
      types: ['meetup'],
      status: 'approved',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  ids.push(data!.id);
  return data!.id as string;
}
const row = async (id: string) =>
  (await db.from('events').select('geo_status,lat,lng,geo_query').eq('id', id).single()).data!;

describe('the geocode job', () => {
  it('tries the venue first, then the town, and gives up with "not found"', async () => {
    const venue = await event({ city: 'Chatham', venue: 'The Historic Dockyard' });
    const town = await event({ city: 'Porto', venue: 'The Old Mill', country_code: 'PT' });
    const lost = await event({ city: 'Atlantis', venue: 'Nowhere Hall' });
    await runGeocode(Date.now() + 30_000, FAST);
    expect(await row(venue)).toMatchObject({
      geo_status: 'found',
      lat: 51.396,
      geo_query: 'The Historic Dockyard, Chatham, United Kingdom',
    });
    expect(await row(town)).toMatchObject({ geo_status: 'found', lat: 41.1579, geo_query: 'Porto, Portugal' });
    expect(await row(lost)).toMatchObject({ geo_status: 'not_found', lat: null });
  });

  it('includes cancelled events, and shares the cache between events', async () => {
    const a = await event({ city: 'Chatham', status: 'cancelled' });
    const b = await event({ city: 'Chatham' });
    await runGeocode(Date.now() + 30_000, FAST);
    expect((await row(a)).geo_status).toBe('found');
    expect((await row(b)).geo_status).toBe('found');
    expect(fake.calls.filter((q) => q === 'Chatham, United Kingdom')).toHaveLength(1);
  });

  it("doesn't overwrite an event that moved while it was being looked up", async () => {
    const id = await event({ city: 'Chatham' });
    setGeocoder({
      search: async (q) => {
        await db.from('events').update({ city: 'Porto', country_code: 'PT' }).eq('id', id);
        return fake.search(q);
      },
    });
    await runGeocode(Date.now() + 30_000, { ...FAST, limit: 1 });
    expect(await row(id)).toMatchObject({ geo_status: 'pending', lat: null });
  });

  it('retries a failed lookup after 24 hours', async () => {
    const id = await event({ city: 'Chatham' });
    setGeocoder({
      search: async () => {
        throw new Error('down');
      },
    });
    await runGeocode(Date.now() + 30_000, FAST);
    expect((await row(id)).geo_status).toBe('failed');
    setGeocoder(fake);
    await runGeocode(Date.now() + 30_000, FAST);
    expect((await row(id)).geo_status).toBe('failed');
    await db
      .from('events')
      .update({ geo_checked_at: new Date(Date.now() - 25 * 3600_000).toISOString() })
      .eq('id', id);
    await runGeocode(Date.now() + 30_000, FAST);
    expect((await row(id)).geo_status).toBe('found');
  });
});
