import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAllEvents, listEvents, PAGE_SIZE } from '../../src/lib/events/query.ts';
import { parseFilters } from '../../src/lib/events/predicates.ts';
import { service } from './helpers.ts';

const db = service();
const TOKEN = `pagingtoken${Date.now()}`;
const COUNT = 1050;

beforeAll(async () => {
  const rows = Array.from({ length: COUNT }, (_, i) => ({
    slug: `${TOKEN}-${i}`,
    title: `${TOKEN} event ${i}`,
    summary: 'Paging test.',
    timezone: 'UTC',
    format: 'online',
    status: 'approved',
    starts_at: new Date(Date.UTC(2031, 0, 1) + i * 3600_000).toISOString(),
    ends_at: new Date(Date.UTC(2031, 0, 1) + i * 3600_000 + 1800_000).toISOString(),
  }));
  const { error } = await db.from('events').insert(rows);
  if (error) throw error;
});

afterAll(async () => {
  await db.from('events').delete().like('slug', `${TOKEN}-%`);
});

const filters = (extra = '') => parseFilters(new URLSearchParams(`q=${TOKEN}${extra}`)).filters;

describe('reading events', () => {
  it('reads every matching event past the 1000-row API limit, in order and without repeats', async () => {
    const all = await listAllEvents(filters());
    expect(all).toHaveLength(COUNT);
    expect(new Set(all.map((e) => e.id)).size).toBe(COUNT);
    const starts = all.map((e) => e.start_instant);
    expect([...starts].sort()).toEqual(starts);
  });

  it('pages through results', async () => {
    const page2 = await listEvents(filters('&page=2'));
    expect(page2.total).toBe(COUNT);
    expect(page2.pages).toBe(Math.ceil(COUNT / PAGE_SIZE));
    expect(page2.events).toHaveLength(PAGE_SIZE);
    expect(page2.events[0]!.title).toBe(`${TOKEN} event ${PAGE_SIZE}`);
  });

  it('returns an empty page past the end instead of failing', async () => {
    const r = await listEvents(filters('&page=999'));
    expect(r.events).toEqual([]);
  });
});
