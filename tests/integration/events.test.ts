import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { service } from './helpers.ts';

const db = service();
const created: string[] = [];

async function insertEvent(fields: Record<string, unknown>) {
  const base = {
    slug: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test event',
    summary: 'A test event.',
    timezone: 'UTC',
    format: 'online',
    starts_at: '2030-01-01T10:00:00Z',
    ends_at: '2030-01-01T11:00:00Z',
  };
  const result = await db
    .from('events')
    .insert({ ...base, ...fields })
    .select()
    .single();
  if (result.data) created.push(result.data.id);
  return result;
}

afterAll(async () => {
  if (created.length) await db.from('events').delete().in('id', created);
});

describe('events table rules', () => {
  it('works out local dates in the event time zone', async () => {
    const { data, error } = await insertEvent({
      timezone: 'Pacific/Auckland',
      format: 'in_person',
      country_code: 'NZ',
      starts_at: '2030-01-01T22:00:00Z', // 11:00 on 2 January in Auckland
      ends_at: '2030-01-02T11:00:00Z', // midnight at the end of 2 January in Auckland
    });
    expect(error).toBeNull();
    expect(data.local_start_date).toBe('2030-01-02');
    // Ending exactly at midnight doesn't spill into the next day.
    expect(data.local_end_date).toBe('2030-01-02');
  });

  it('stores all-day events with an exclusive end date', async () => {
    const { data, error } = await insertEvent({
      all_day: true,
      starts_at: null,
      ends_at: null,
      start_date: '2030-03-10',
      end_date: '2030-03-12',
      timezone: 'Europe/London',
    });
    expect(error).toBeNull();
    expect(data.local_start_date).toBe('2030-03-10');
    expect(data.local_end_date).toBe('2030-03-11');
    expect(data.end_instant).toBe('2030-03-12T00:00:00+00:00');
  });

  it.each([
    ['an end before the start', { ends_at: '2030-01-01T09:00:00Z' }],
    ['an unknown time zone', { timezone: 'Mars/Olympus_Mons' }],
    ['an online event with a country', { country_code: 'GB' }],
    ['an in-person event without a country', { format: 'in_person' }],
    ['an http link', { url: 'http://example.org' }],
    ['an unknown country', { format: 'in_person', country_code: 'ZZ' }],
    ['an all-day event with times', { all_day: true, start_date: '2030-01-01', end_date: '2030-01-02' }],
    ['an imported event without a source id', { source: 'ics' }],
    ['an unknown flag', { flags: ['hacked'] }],
    ['an invalid language', { lang: 'english!' }],
    ['an empty summary', { summary: '   ' }],
  ])('rejects %s', async (_label, fields) => {
    const { error } = await insertEvent(fields);
    expect(error).not.toBeNull();
  });

  it('increases SEQUENCE when a published event changes, including a status-only cancellation', async () => {
    const { data } = await insertEvent({ status: 'approved' });
    expect(data.sequence).toBe(0);
    const moved = await db
      .from('events')
      .update({ starts_at: '2030-01-01T10:30:00Z' })
      .eq('id', data.id)
      .select()
      .single();
    expect(moved.data!.sequence).toBe(1);
    const cancelled = await db.from('events').update({ status: 'cancelled' }).eq('id', data.id).select().single();
    expect(cancelled.data!.sequence).toBe(2);
    expect(cancelled.data!.cancelled_at).not.toBeNull();
  });

  it('does not increase SEQUENCE for pending events', async () => {
    const { data } = await insertEvent({});
    const edited = await db.from('events').update({ title: 'New title' }).eq('id', data.id).select().single();
    expect(edited.data!.sequence).toBe(0);
    expect(edited.data!.version).toBe(2);
  });

  it('keeps the slug of a published event', async () => {
    const { data } = await insertEvent({ status: 'approved' });
    const { error } = await db.from('events').update({ slug: 'something-else-entirely' }).eq('id', data.id);
    expect(error?.message).toMatch(/slug of a published event/);
  });

  it('enforces one row per imported item', async () => {
    const source = await db.from('import_sources').insert({ type: 'ics', name: 'Test feed' }).select().single();
    const fields = { source: 'ics', source_id: source.data!.id, source_uid: 'uid-1' };
    expect((await insertEvent(fields)).error).toBeNull();
    expect((await insertEvent(fields)).error?.code).toBe('23505');
    await db.from('events').delete().eq('source_id', source.data!.id);
    await db.from('import_sources').delete().eq('id', source.data!.id);
  });
});

describe('search', () => {
  beforeAll(async () => {
    await insertEvent({ status: 'approved', title: 'Zebra crossing workshop', summary: 'Kerbs and tactile paving.' });
  });

  it('finds events by words in the title or summary', async () => {
    const { data } = await db
      .from('public_events')
      .select('title')
      .textSearch('search', 'tactile', { type: 'websearch', config: 'simple' });
    expect(data!.map((d) => d.title)).toContain('Zebra crossing workshop');
  });
});
