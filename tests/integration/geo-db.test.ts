import { afterAll, describe, expect, it } from 'vitest';
import { anon, service } from './helpers.ts';

const db = service();
const tag = `geodb${Date.now()}`;
const ids: string[] = [];
afterAll(async () => {
  if (ids.length) await db.from('events').delete().in('id', ids);
  await db.from('place_lookups').delete().like('query_key', `${tag}%`);
  await db.from('geocode_slots').delete().like('key', `${tag}%`);
});
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function event(fields: Record<string, unknown> = {}) {
  const { data, error } = await db
    .from('events')
    .insert({
      slug: `${tag}-${uniq()}`,
      title: `${tag}`,
      summary: 'A test.',
      timezone: 'UTC',
      format: 'in_person',
      country_code: 'GB',
      city: 'Chatham',
      venue: 'Dockyard',
      starts_at: '2033-03-01T10:00:00Z',
      ends_at: '2033-03-01T12:00:00Z',
      types: ['meetup'],
      ...fields,
    })
    .select('id,geo_status,lat,lng')
    .single();
  expect(error).toBeNull();
  ids.push(data!.id);
  return data!;
}

describe('event positions', () => {
  it('a new in-person event waits for a position; an online one needs none', async () => {
    expect(await event()).toMatchObject({ geo_status: 'pending', lat: null });
    expect(await event({ format: 'online', country_code: null, city: null, venue: null })).toMatchObject({
      geo_status: 'none',
      lat: null,
    });
  });

  it('keeps a position the job sets, and waits again when the place changes', async () => {
    const e = await event();
    const { data: found } = await db
      .from('events')
      .update({ lat: 51.38, lng: 0.52, geo_status: 'found', geo_query: 'Dockyard, Chatham, United Kingdom' })
      .eq('id', e.id)
      .select('geo_status,lat')
      .single();
    expect(found).toEqual({ geo_status: 'found', lat: 51.38 });
    const { data: moved } = await db
      .from('events')
      .update({ venue: 'Town Hall' })
      .eq('id', e.id)
      .select('geo_status,lat,lng')
      .single();
    expect(moved).toEqual({ geo_status: 'pending', lat: null, lng: null });
  });

  it('refuses positions out of range, and "found" without a position', async () => {
    const e = await event();
    expect((await db.from('events').update({ lat: 91, lng: 0, geo_status: 'found' }).eq('id', e.id)).error?.code).toBe(
      '23514',
    );
    expect((await db.from('events').update({ geo_status: 'found' }).eq('id', e.id)).error?.code).toBe('23514');
  });

  it('the public view has positions; anon still cannot read places or slots', async () => {
    const e = await event({ status: 'approved' });
    await db.from('events').update({ lat: 51.38, lng: 0.52, geo_status: 'found' }).eq('id', e.id);
    const { data } = await db.from('public_events').select('lat,lng').eq('id', e.id).single();
    expect(data).toEqual({ lat: 51.38, lng: 0.52 });
    expect((await anon().from('place_lookups').select('query_key').limit(1)).error).not.toBeNull();
    expect((await anon().from('geocode_slots').select('key').limit(1)).error).not.toBeNull();
  });
});

describe('geocode spacing', () => {
  it('reservations made at once are spaced apart, whatever the window edges', async () => {
    const key = `${tag}-spacing`;
    const slots = await Promise.all(
      Array.from({ length: 5 }, () => db.rpc('reserve_geocode_slot', { p_key: key, p_spacing_ms: 1000 })),
    );
    const times = slots.map((s) => Date.parse(s.data as string)).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1000);
  });
});

describe('place cache cleanup', () => {
  it('removes lookups older than 30 days', async () => {
    await db.from('place_lookups').insert([
      { query_key: `${tag}-old`, results: [], looked_up_at: new Date(Date.now() - 31 * 86_400_000).toISOString() },
      { query_key: `${tag}-new`, results: [], looked_up_at: new Date().toISOString() },
    ]);
    await db.rpc('run_cleanup');
    const { data } = await db.from('place_lookups').select('query_key').like('query_key', `${tag}%`);
    expect(data).toEqual([{ query_key: `${tag}-new` }]);
  });
});

describe('digest places', () => {
  it('stores a place with its unit, all or nothing, and a change bumps the revision', async () => {
    const email = `${uniq()}-${tag}@example.test`;
    const { data: s } = await db
      .from('digest_subscribers')
      .insert({ email, cadence: 'weekly' })
      .select('id,prefs_revision')
      .single();
    const { data: placed, error } = await db
      .from('digest_subscribers')
      .update({ near_lat: 51.38, near_lng: 0.52, near_label: 'Chatham, Kent', near_km: 40.2, near_unit: 'mi' })
      .eq('id', s!.id)
      .select('prefs_revision')
      .single();
    expect(error).toBeNull();
    expect(placed!.prefs_revision).toBe(s!.prefs_revision + 1);
    expect((await db.from('digest_subscribers').update({ near_label: null }).eq('id', s!.id)).error?.code).toBe(
      '23514',
    );
    await db.from('digest_subscribers').delete().eq('id', s!.id);
  });
});
