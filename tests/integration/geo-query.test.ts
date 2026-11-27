import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newFeedEntries } from '../../src/lib/alerts/feed.ts';
import { parseFilters } from '../../src/lib/events/predicates.ts';
import { listAllEvents, listEvents } from '../../src/lib/events/query.ts';
import { service } from './helpers.ts';

const db = service();
const tag = `geoq${Date.now()}`;

const place = (name: string, lat: number | null, lng: number | null, fields: Record<string, unknown> = {}) => ({
  slug: `${tag}-${name}`,
  title: `${tag} ${name}`,
  summary: 'A test.',
  timezone: 'UTC',
  format: 'in_person',
  country_code: 'FJ',
  city: name,
  starts_at: '2033-04-01T10:00:00Z',
  ends_at: '2033-04-01T12:00:00Z',
  types: ['meetup'],
  status: 'approved',
  lat,
  lng,
  geo_status: lat === null ? 'not_found' : 'found',
  ...fields,
});

beforeAll(async () => {
  const { error } = await db.from('events').insert([
    // Around Suva, near the date line: 179.9 and the other side, -179.95.
    place('east', -17.7, 179.9),
    place('west', -17.7, -179.95),
    // In the box's corner but outside a 50 km circle around (-17.7, 179.9).
    place('corner', -17.32, -179.7),
    place('far', -15.0, 178.0),
    place('unplaced', null, null),
    place('online', null, null, { format: 'online', country_code: null, city: null, geo_status: 'none' }),
    // Near the north pole.
    place('pole-a', 89.5, 10, { country_code: 'NO' }),
    place('pole-b', 89.6, -170, { country_code: 'NO' }),
  ]);
  if (error) throw error;
});
afterAll(async () => {
  await db.from('events').delete().like('slug', `${tag}-%`);
});

const titles = async (qs: string) =>
  (await listAllEvents(parseFilters(new URLSearchParams(qs)).filters))
    .map((e) => e.title.replace(`${tag} `, ''))
    .filter((t) => !t.startsWith('Online accessibility talk') && !t.includes(' '))
    .sort();
const ours = (list: string[]) =>
  list.filter((t) => ['east', 'west', 'corner', 'far', 'unplaced', 'online', 'pole-a', 'pole-b'].includes(t));

describe('near me in the database', () => {
  it('finds events on both sides of the date line, and not the box corner or far ones', async () => {
    expect(ours(await titles('near=Suva&at=-17.7,179.9&u=km&within=50'))).toEqual(['east', 'west']);
  });

  it('adds online events only when asked; events without a position never match', async () => {
    expect(ours(await titles('near=Suva&at=-17.7,179.9&u=km&within=50&online=include'))).toEqual([
      'east',
      'online',
      'west',
    ]);
  });

  it('finds events across the pole', async () => {
    expect(ours(await titles('near=Pole&at=89.55,0&u=km&within=100'))).toEqual(['pole-a', 'pole-b']);
  });

  it('combines with country and format filters', async () => {
    expect(ours(await titles('near=Suva&at=-17.7,179.9&u=km&within=50&country=NO'))).toEqual([]);
    expect(ours(await titles('near=Suva&at=-17.7,179.9&u=km&within=50&format=online&online=include'))).toEqual([
      'online',
    ]);
  });

  it('counts and pages exactly', async () => {
    const page = await listEvents(parseFilters(new URLSearchParams('near=Suva&at=-17.7,179.9&u=km&within=50')).filters);
    expect(page.events.map((e) => e.title)).toEqual(expect.arrayContaining([`${tag} east`, `${tag} west`]));
    expect(page.total).toBe(page.events.length);
  });

  it('the just-added feed uses the exact distance too', async () => {
    const entries = await newFeedEntries(
      parseFilters(new URLSearchParams('near=Suva&at=-17.7,179.9&u=km&within=50')).filters,
    );
    const names = entries.map((e) => e.event.title.replace(`${tag} `, ''));
    expect(names).toContain('east');
    expect(names).not.toContain('corner');
  });
});
