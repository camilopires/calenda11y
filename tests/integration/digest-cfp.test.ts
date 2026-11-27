import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfpFor, runDigest } from '../../src/lib/digest/send.ts';
import { service } from './helpers.ts';

const db = service();
const tag = `dcfp${Date.now()}`;
// A Monday far in the future, so these events are the only ones around.
const NOW = new Date('2033-06-06T09:00:00Z');
const PERIOD = { start: '2033-06-06', end: '2033-06-12' };

const event = (slug: string, fields: Record<string, unknown>) => ({
  slug: `${tag}-${slug}`,
  title: `${tag} ${slug}`,
  summary: 'A test.',
  timezone: 'UTC',
  format: 'in_person',
  country_code: 'IS',
  city: 'Reykjavik',
  starts_at: '2033-09-01T10:00:00Z',
  ends_at: '2033-09-01T12:00:00Z',
  types: ['conference'],
  status: 'approved',
  cfp_url: `https://cfp.example/${slug}`,
  ...fields,
});

beforeAll(async () => {
  const { error } = await db.from('events').insert([
    event('soon', { cfp_closes_on: '2033-07-01' }),
    event('workshop', { types: ['workshop'], cfp_closes_on: '2033-07-01' }),
    event('too-far', { cfp_closes_on: '2033-08-30' }),
    event('no-date', { starts_at: '2033-06-20T10:00:00Z', ends_at: '2033-06-20T12:00:00Z' }),
    event('honolulu', { timezone: 'Pacific/Honolulu', cfp_closes_on: '2033-06-05' }),
    event('closed', { cfp_closes_on: '2033-06-01' }),
    event('cancelled', { status: 'cancelled', cfp_closes_on: '2033-07-02' }),
    event('only-call', {
      country_code: 'GL',
      city: 'Nuuk',
      starts_at: '2034-01-10T10:00:00Z',
      ends_at: '2034-01-10T12:00:00Z',
      cfp_closes_on: '2033-06-20',
    }),
  ]);
  if (error) throw error;
});

afterAll(async () => {
  await db.from('events').delete().like('slug', `${tag}-%`);
  await db.from('digest_subscribers').delete().like('email', `%-${tag}@example.test`);
  await db.from('email_outbox').delete().like('to_email', `%-${tag}@example.test`);
  await db.from('digest_runs').delete().eq('period_start', '2033-06-01');
});

describe('topics in the digest', () => {
  it('two subscribers who differ only in topics each get their own events and calls', async () => {
    const legal = `law-${tag}@example.test`;
    const career = `careers-${tag}@example.test`;
    await db.from('events').insert([
      event('law-event', {
        country_code: 'FO',
        city: 'Torshavn',
        topics: ['law'],
        starts_at: '2033-06-15T10:00:00Z',
        ends_at: '2033-06-15T12:00:00Z',
        cfp_url: null,
      }),
      event('careers-event', {
        country_code: 'FO',
        city: 'Torshavn',
        topics: ['careers'],
        starts_at: '2033-06-16T10:00:00Z',
        ends_at: '2033-06-16T12:00:00Z',
        cfp_url: null,
      }),
      event('careers-call', {
        country_code: 'FO',
        city: 'Torshavn',
        topics: ['careers'],
        cfp_closes_on: '2033-06-20',
      }),
    ]);
    for (const [email, topics] of [
      [legal, ['law']],
      [career, ['careers']],
    ] as const) {
      await db.from('digest_subscribers').insert({
        email,
        cadence: 'monthly',
        countries: ['FO'],
        topics,
        include_cfp: true,
        confirmed_at: new Date().toISOString(),
      });
    }
    await db.from('digest_runs').delete().eq('period_start', '2033-06-01');
    await runDigest('monthly', Date.now() + 30_000, new Date('2033-06-01T09:00:00Z'));
    const body = async (to: string) =>
      (await db.from('email_outbox').select('text_body').eq('to_email', to).single()).data!.text_body as string;
    const l = await body(legal);
    expect(l).toContain(`${tag} law-event`);
    expect(l).not.toContain(`${tag} careers`);
    const c = await body(career);
    expect(c).toContain(`${tag} careers-event`);
    expect(c).toContain(`${tag} careers-call`);
    expect(c).not.toContain(`${tag} law-event`);
  });
});

describe('calls for speakers in the digest', () => {
  it('picks open calls closing in the period or the month after, by closing time', async () => {
    const calls = await cfpFor(
      { countries: ['IS'], formats: [], types: ['conference'], topics: [], near: null },
      PERIOD,
      NOW,
    );
    // Honolulu's last day (5 June) is "yesterday" in UTC, but it's still open there.
    expect(calls.map((e) => e.slug)).toEqual([`${tag}-honolulu`, `${tag}-no-date`, `${tag}-soon`]);
  });

  it('sends calls even when no events match the period', async () => {
    const email = `only-${tag}@example.test`;
    await db.from('digest_subscribers').insert({
      email,
      cadence: 'monthly',
      countries: ['GL'],
      include_cfp: true,
      confirmed_at: new Date().toISOString(),
    });
    await db.from('digest_runs').delete().eq('period_start', '2033-06-01');
    await runDigest('monthly', Date.now() + 30_000, new Date('2033-06-01T09:00:00Z'));
    const { data } = await db.from('email_outbox').select('text_body').eq('to_email', email).single();
    expect(data!.text_body).toContain(
      'No events in this period match your choices, but these calls for speakers are open.',
    );
    expect(data!.text_body).toContain('Calls for speakers closing soon');
    expect(data!.text_body).toContain(`${tag} only-call`);
  });

  it('sends nothing to someone who has not asked for calls', async () => {
    const email = `nocfp-${tag}@example.test`;
    await db.from('digest_subscribers').insert({
      email,
      cadence: 'monthly',
      countries: ['GL'],
      confirmed_at: new Date().toISOString(),
    });
    await db.from('digest_runs').delete().eq('period_start', '2033-06-01');
    await runDigest('monthly', Date.now() + 30_000, new Date('2033-06-01T09:00:00Z'));
    const { data } = await db.from('email_outbox').select('id').eq('to_email', email);
    expect(data).toEqual([]);
  });
});
