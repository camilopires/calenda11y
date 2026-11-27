import { afterAll, describe, expect, it } from 'vitest';
import { cfpClosesAt } from '../../src/lib/events/cfp.ts';
import { parseFilters } from '../../src/lib/events/predicates.ts';
import { listAllEvents } from '../../src/lib/events/query.ts';
import { cfpFeedEvents } from '../../src/lib/calendar/feeds.ts';
import { service } from './helpers.ts';

const db = service();
const created: string[] = [];
afterAll(async () => {
  if (created.length) await db.from('events').delete().in('id', created);
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

interface Row {
  id: string;
  cfp_closes_at: string | null;
  cfp_last_day: string | null;
  cfp_capped: boolean | null;
  start_instant: string;
  sequence: number;
  version: number;
}

const COLS = 'id,cfp_closes_at,cfp_last_day,cfp_capped,start_instant,sequence,version';

async function insert(fields: Record<string, unknown>): Promise<Row> {
  const { data, error } = await db
    .from('events')
    .insert({
      slug: `itest-cfp-${uniq()}`,
      title: 'CFP test',
      summary: 'A test.',
      timezone: 'UTC',
      format: 'online',
      starts_at: '2032-06-10T18:00:00Z',
      ends_at: '2032-06-10T20:00:00Z',
      url: 'https://example.org',
      organiser: 'Tester',
      types: ['conference'],
      status: 'pending',
      ...fields,
    })
    .select(COLS)
    .single();
  expect(error).toBeNull();
  created.push(data!.id);
  return data as Row;
}

describe('call for speakers deadline', () => {
  it('closes at the end of the closing date in the event time zone (summer and winter)', async () => {
    const summer = await insert({
      timezone: 'Europe/Lisbon',
      cfp_url: 'https://cfp.example',
      cfp_closes_on: '2032-05-15',
    });
    expect(summer).toMatchObject({ cfp_last_day: '2032-05-15', cfp_capped: false });
    expect(new Date(summer.cfp_closes_at!).toISOString()).toBe('2032-05-15T23:00:00.000Z');
    const winter = await insert({
      timezone: 'Europe/Lisbon',
      cfp_url: 'https://cfp.example',
      cfp_closes_on: '2032-01-15',
    });
    expect(new Date(winter.cfp_closes_at!).toISOString()).toBe('2032-01-16T00:00:00.000Z');
    const ny = await insert({
      timezone: 'America/New_York',
      cfp_url: 'https://cfp.example',
      cfp_closes_on: '2032-03-01',
    });
    expect(new Date(ny.cfp_closes_at!).toISOString()).toBe('2032-03-02T05:00:00.000Z');
  });

  it('with no date, closes when the event starts', async () => {
    const r = await insert({ cfp_url: 'https://cfp.example' });
    expect(r.cfp_closes_at).toBe(r.start_instant);
    expect(r).toMatchObject({ cfp_capped: true, cfp_last_day: '2032-06-10' });
  });

  it('a date after the start, or on the start day of a timed event, is capped at the start', async () => {
    const after = await insert({ cfp_url: 'https://cfp.example', cfp_closes_on: '2032-07-01' });
    expect(after.cfp_closes_at).toBe(after.start_instant);
    expect(after.cfp_capped).toBe(true);
    const sameDay = await insert({ cfp_url: 'https://cfp.example', cfp_closes_on: '2032-06-10' });
    expect(sameDay).toMatchObject({ cfp_capped: true, cfp_last_day: '2032-06-10' });
  });

  it('has nothing without a link, and refuses a date with no link', async () => {
    const none = await insert({});
    expect(none).toMatchObject({ cfp_closes_at: null, cfp_last_day: null, cfp_capped: null });
    const { error } = await db.from('events').insert({
      slug: `itest-cfp-${uniq()}`,
      title: 'Bad',
      summary: 'A test.',
      timezone: 'UTC',
      format: 'online',
      starts_at: '2032-06-10T18:00:00Z',
      ends_at: '2032-06-10T20:00:00Z',
      types: ['talk'],
      cfp_closes_on: '2032-05-01',
    });
    expect(error?.code).toBe('23514');
  });

  it('follows the event when it moves earlier', async () => {
    const r = await insert({ cfp_url: 'https://cfp.example', cfp_closes_on: '2032-06-01' });
    expect(r.cfp_capped).toBe(false);
    const { data } = await db
      .from('events')
      .update({ starts_at: '2032-05-20T18:00:00Z', ends_at: '2032-05-20T20:00:00Z' })
      .eq('id', r.id)
      .select(COLS)
      .single();
    expect(data).toMatchObject({ cfp_capped: true, cfp_last_day: '2032-05-20' });
  });

  it('the TypeScript calculation matches the database', async () => {
    const cases = [
      { timezone: 'Europe/Lisbon', cfp_url: 'https://cfp.example', cfp_closes_on: '2032-05-15' },
      { timezone: 'America/New_York', cfp_url: 'https://cfp.example', cfp_closes_on: null },
      { timezone: 'UTC', cfp_url: 'https://cfp.example', cfp_closes_on: '2032-06-10' },
      {
        timezone: 'Europe/Berlin',
        cfp_url: 'https://cfp.example',
        cfp_closes_on: '2032-06-01',
        all_day: true,
        starts_at: null,
        ends_at: null,
        start_date: '2032-06-01',
        end_date: '2032-06-03',
      },
    ];
    for (const c of cases) {
      const row = await insert(c);
      const record = {
        all_day: false,
        starts_at: '2032-06-10T18:00:00Z',
        start_date: null,
        ...c,
      };
      expect(cfpClosesAt(record)).toEqual(
        row.cfp_closes_at
          ? { at: new Date(row.cfp_closes_at).toISOString(), lastDay: row.cfp_last_day, capped: row.cfp_capped }
          : null,
      );
    }
  });

  it('a change to a published event bumps its sequence, and the view exposes the call', async () => {
    const r = await insert({ status: 'approved' });
    await db.from('events').update({ cfp_url: 'https://cfp.example/new' }).eq('id', r.id);
    const after = (await db.from('events').select('sequence').eq('id', r.id).single()).data!;
    expect(after.sequence).toBe(r.sequence + 1);
    const view = await db
      .from('public_events')
      .select('cfp_url,cfp_closes_at,cfp_last_day,cfp_capped')
      .eq('id', r.id)
      .single();
    expect(view.data).toMatchObject({ cfp_url: 'https://cfp.example/new', cfp_capped: true });
  });
});

describe('the "Open for speakers" filter', () => {
  it('leaves out cancelled events, and includes them again once restored', async () => {
    const r = await insert({ status: 'approved', cfp_url: 'https://cfp.example', cfp_closes_on: '2032-05-01' });
    const open = async () =>
      (await listAllEvents(parseFilters(new URLSearchParams('cfp=open&type=conference')).filters)).some(
        (e) => e.id === r.id,
      );
    expect(await open()).toBe(true);
    await db.from('events').update({ status: 'cancelled' }).eq('id', r.id);
    expect(await open()).toBe(false);
    await db.from('events').update({ status: 'approved' }).eq('id', r.id);
    expect(await open()).toBe(true);
  });
});

describe('the calls-for-speakers feed', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const iso = (d: Date) => d.toISOString();
  const day = (d: Date) => d.toISOString().slice(0, 10);

  it('keeps a recent deadline even when its event has ended, and even from an open-only search', async () => {
    const ended = await insert({
      status: 'approved',
      starts_at: iso(daysAgo(2)),
      ends_at: iso(daysAgo(1)),
      cfp_url: 'https://cfp.example/ended',
      cfp_closes_on: day(daysAgo(5)),
    });
    const old = await insert({
      status: 'approved',
      starts_at: iso(daysAgo(40)),
      ends_at: iso(daysAgo(39)),
      cfp_url: 'https://cfp.example/old',
      cfp_closes_on: day(daysAgo(45)),
    });
    const pending = await insert({ status: 'pending', cfp_url: 'https://cfp.example/pending' });
    for (const qs of ['type=conference', 'type=conference&cfp=open']) {
      const ids = (await cfpFeedEvents(parseFilters(new URLSearchParams(qs)).filters)).map((e) => e.id);
      expect(ids).toContain(ended.id);
      expect(ids).not.toContain(old.id);
      expect(ids).not.toContain(pending.id);
    }
  });
});

describe('digest subscribers and calls for speakers', () => {
  it('include_cfp is off by default', async () => {
    const email = `cfp-${uniq()}@example.test`;
    const { data } = await db
      .from('digest_subscribers')
      .insert({ email, cadence: 'weekly' })
      .select('include_cfp')
      .single();
    expect(data!.include_cfp).toBe(false);
    await db.from('digest_subscribers').delete().eq('email', email);
  });
});
