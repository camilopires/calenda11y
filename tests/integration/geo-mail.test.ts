import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAlerts } from '../../src/lib/alerts/send.ts';
import { eventsFor, runDigest } from '../../src/lib/digest/send.ts';
import { setMailer } from '../../src/lib/services/mailer.ts';
import { service } from './helpers.ts';

const db = service();
const tag = `geomail${Date.now()}`;
const subs: string[] = [];
const NOW = new Date('2036-03-03T09:00:00Z');
const CHATHAM = { lat: 51.3807, lng: 0.5214 };
const LISBON = { lat: 38.7223, lng: -9.1393 };
const near = (p: { lat: number; lng: number }, label: string) => ({
  near_lat: p.lat,
  near_lng: p.lng,
  near_label: label,
  near_km: 40.2336,
  near_unit: 'mi',
  near_online: false,
});

beforeAll(() => {
  setMailer({ send: async () => ({ id: `fake-${Math.random()}` }) } as never);
});
afterAll(async () => {
  await db.from('events').delete().like('slug', `${tag}-%`);
  if (subs.length) await db.from('digest_subscribers').delete().in('id', subs);
  await db.from('email_outbox').delete().like('to_email', `%-${tag}@example.test`);
  await db.from('digest_runs').delete().eq('period_start', '2036-03-03');
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const at = (p: { lat: number; lng: number } | null, fields: Record<string, unknown> = {}) => ({
  slug: `${tag}-${uniq()}`,
  title: `${tag} ${uniq()}`,
  summary: 'A test.',
  timezone: 'UTC',
  format: 'in_person',
  country_code: 'GB',
  city: 'Chatham',
  starts_at: '2036-03-05T10:00:00Z',
  ends_at: '2036-03-05T12:00:00Z',
  types: ['meetup'],
  status: 'approved',
  ...(p ? { lat: p.lat, lng: p.lng, geo_status: 'found' } : {}),
  ...fields,
});
async function insert(rows: Record<string, unknown>[]) {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await db
      .from('events')
      .insert(rows.slice(i, i + 500))
      .select('id,title');
    if (error) throw error;
    ids.push(...data!.map((d) => d.id));
  }
  return ids;
}
async function subscriber(fields: Record<string, unknown>) {
  const { data, error } = await db
    .from('digest_subscribers')
    .insert({ email: `${uniq()}-${tag}@example.test`, confirmed_at: new Date().toISOString(), ...fields })
    .select('id,email')
    .single();
  if (error) throw error;
  subs.push(data!.id);
  return data!;
}
const mails = async (to: string) =>
  (await db.from('email_outbox').select('text_body').eq('to_email', to)).data!.map((m) => m.text_body as string);

describe('the digest with a place', () => {
  it('subscribers near different places get their own events in the same run', async () => {
    await insert([
      at(CHATHAM, { title: `${tag} chatham-event` }),
      at(LISBON, { title: `${tag} lisbon-event`, country_code: 'PT', city: 'Lisbon' }),
    ]);
    const c = await subscriber({ cadence: 'weekly', ...near(CHATHAM, 'Chatham') });
    const l = await subscriber({ cadence: 'weekly', ...near(LISBON, 'Lisbon') });
    await runDigest('weekly', Date.now() + 60_000, NOW);
    const cm = (await mails(c.email)).join('\n');
    const lm = (await mails(l.email)).join('\n');
    expect(cm).toContain('chatham-event');
    expect(cm).not.toContain('lisbon-event');
    expect(lm).toContain('lisbon-event');
    expect(lm).not.toContain('chatham-event');
  });

  it('works together with "online events as well as a country"', async () => {
    const r = await eventsFor(
      {
        countries: ['GB', 'online'],
        formats: [],
        types: [],
        topics: [],
        near: { ...CHATHAM, km: 40.2336, radius: 25, unit: 'mi', label: 'Chatham', includeOnline: false },
      },
      { start: '2036-03-03', end: '2036-03-09' },
      NOW,
    );
    expect(r.events.some((e) => e.title === `${tag} chatham-event`)).toBe(true);
    expect(r.events.some((e) => e.title === `${tag} lisbon-event`)).toBe(false);
  });

  it('reads past 1,000 box candidates to find the ones really near', async () => {
    // In the box's corner (about 45 km away) but outside a 25-mile (40 km) circle, and earlier.
    const corner = { lat: CHATHAM.lat + 0.3, lng: CHATHAM.lng + 0.4 };
    await insert(
      Array.from({ length: 1020 }, () =>
        at(corner, { starts_at: '2036-03-04T09:00:00Z', ends_at: '2036-03-04T10:00:00Z', city: 'Corner' }),
      ),
    );
    const late = (
      await insert([
        at(CHATHAM, { title: `${tag} late-near`, starts_at: '2036-03-08T10:00:00Z', ends_at: '2036-03-08T11:00:00Z' }),
      ])
    )[0];
    const r = await eventsFor(
      {
        countries: [],
        formats: [],
        types: [],
        topics: [],
        near: { ...CHATHAM, km: 40.2336, radius: 25, unit: 'mi', label: 'Chatham', includeOnline: false },
      },
      { start: '2036-03-03', end: '2036-03-09' },
      NOW,
    );
    expect(r.events.some((e) => e.id === late)).toBe(true);
    expect(r.events.every((e) => e.city !== 'Corner')).toBe(true);
    expect(r.total).toBe(r.events.length);
  }, 120_000);
});

describe('alerts with a place', () => {
  it('wait while an event is still being placed, then send it once', async () => {
    const s = await subscriber({ cadence: 'instant', countries: ['GB'], ...near(CHATHAM, 'Chatham') });
    const [id] = await insert([at(null, { title: `${tag} waiting-event` })]);
    await runAlerts('instant', Date.now() + 60_000, NOW);
    expect((await mails(s.email)).join('\n')).not.toContain('waiting-event');
    await db
      .from('events')
      .update({ ...CHATHAM, geo_status: 'found' })
      .eq('id', id!);
    await runAlerts('instant', Date.now() + 60_000, NOW);
    const sent = (await mails(s.email)).filter((m) => m.includes('waiting-event'));
    expect(sent).toHaveLength(1);
    await runAlerts('instant', Date.now() + 60_000, NOW);
    expect((await mails(s.email)).filter((m) => m.includes('waiting-event'))).toHaveLength(1);
  });

  it("aren't held up by events that couldn't be placed", async () => {
    const s = await subscriber({ cadence: 'instant', countries: ['GB'], ...near(CHATHAM, 'Chatham') });
    const [lost] = await insert([at(null, { title: `${tag} unplaceable` })]);
    // As if the lookup job had tried and failed to find it.
    await db.from('events').update({ geo_status: 'not_found' }).eq('id', lost!);
    await insert([at(CHATHAM, { title: `${tag} placed-after` })]);
    await runAlerts('instant', Date.now() + 60_000, NOW);
    const all = (await mails(s.email)).join('\n');
    expect(all).toContain('placed-after');
    expect(all).not.toContain('unplaceable');
  });
});
