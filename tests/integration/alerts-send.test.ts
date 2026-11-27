import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAlerts } from '../../src/lib/alerts/send.ts';
import { setMailer } from '../../src/lib/services/mailer.ts';
import { service } from './helpers.ts';

const db = service();
const tag = `alsend${Date.now()}`;
const subs: string[] = [];
const sent: string[] = [];
// Far enough ahead that test events are still upcoming, and daily rounds don't clash with real ones.
const NOW = new Date('2034-01-10T09:00:00Z');
const LATER = Date.now() + 60_000;

beforeAll(() => {
  setMailer({
    send: async (m: { to: string }) => {
      sent.push(m.to);
      return { id: `fake-${sent.length}` };
    },
  } as never);
});

afterAll(async () => {
  await db.from('events').delete().like('slug', `${tag}-%`);
  if (subs.length) await db.from('digest_subscribers').delete().in('id', subs);
  await db.from('email_outbox').delete().like('to_email', `%-${tag}@example.test`);
  await db.from('alert_rounds').delete().in('round_date', ['2034-01-10', '2034-01-11']);
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function events(country: string, n: number, fields: Record<string, unknown> = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    slug: `${tag}-${country.toLowerCase()}-${uniq()}-${i}`,
    title: `${tag} ${country} ${i}`,
    summary: 'A test.',
    timezone: 'UTC',
    format: 'in_person',
    country_code: country,
    city: 'Somewhere',
    starts_at: '2035-01-01T10:00:00Z',
    ends_at: '2035-01-01T12:00:00Z',
    types: ['meetup'],
    status: 'approved',
    ...fields,
  }));
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await db
      .from('events')
      .insert(rows.slice(i, i + 500))
      .select('id');
    if (error) throw error;
    ids.push(...data!.map((d) => d.id));
  }
  return ids;
}

async function subscriber(country: string, cadence: 'instant' | 'daily' = 'instant', fields = {}) {
  const email = `${country.toLowerCase()}-${uniq()}-${tag}@example.test`;
  const { data, error } = await db
    .from('digest_subscribers')
    .insert({ email, cadence, countries: [country], confirmed_at: new Date().toISOString(), ...fields })
    .select('id,email')
    .single();
  if (error) throw error;
  subs.push(data!.id);
  return data!;
}

const mails = async (to: string) =>
  (await db.from('email_outbox').select('subject,text_body,status').eq('to_email', to)).data!;

describe('instant alerts', () => {
  it('many changes in one round make one email, sent straight away; the next round sends nothing new', async () => {
    const s = await subscriber('LI');
    await events('LI', 3);
    await runAlerts('instant', LATER, NOW);
    const m = await mails(s.email);
    expect(m).toHaveLength(1);
    expect(m[0]!.subject).toBe('New and updated accessibility events');
    for (let i = 0; i < 3; i++) expect(m[0]!.text_body).toContain(`${tag} LI ${i}`);
    expect(m[0]!.status).toBe('sent');
    await runAlerts('instant', LATER, NOW);
    expect(await mails(s.email)).toHaveLength(1);
  });

  it('a change made after confirming, before the first run, is delivered', async () => {
    const s = await subscriber('MC');
    await events('MC', 1);
    await runAlerts('instant', LATER, NOW);
    expect((await mails(s.email))[0]!.text_body).toContain(`${tag} MC 0`);
  });

  it('updates say what changed', async () => {
    const [id] = await events('SM', 1);
    const s = await subscriber('SM');
    await db.from('events').update({ venue: 'New Hall' }).eq('id', id!);
    await runAlerts('instant', LATER, NOW);
    const body = (await mails(s.email))[0]!.text_body;
    expect(body).toContain('Updated');
    expect(body).toContain('Moved to: New Hall, Somewhere, San Marino');
  });

  it('describes each change as it was at the round, so a later cancellation is told once, in the next round', async () => {
    const [id] = await events('LU', 1);
    const s = await subscriber('LU');
    await db.from('events').update({ venue: 'Hall A' }).eq('id', id!);
    // Round 1 starts and stops before reaching anyone; then the event is cancelled.
    await runAlerts('instant', LATER, NOW, { maxSubscribers: 0 });
    await db.from('events').update({ status: 'cancelled' }).eq('id', id!);
    await runAlerts('instant', LATER, NOW);
    let m = await mails(s.email);
    expect(m).toHaveLength(1);
    expect(m[0]!.text_body).toContain('Moved to: Hall A');
    expect(m[0]!.text_body).not.toContain('Cancelled');
    await runAlerts('instant', LATER, NOW);
    m = await mails(s.email);
    expect(m).toHaveLength(2);
    expect(m.filter((x) => x.text_body.includes('Cancelled'))).toHaveLength(1);
  });

  it('a round is not closed while someone whose preferences changed is still waiting', async () => {
    const [id] = await events('LT', 1);
    const s = await subscriber('LT');
    await db.from('events').update({ venue: 'Hall B' }).eq('id', id!);
    // Their preferences change after the run has read them but before it queues.
    await runAlerts('instant', LATER, NOW, {
      beforeQueue: async (sub) => {
        if (sub === s.id) await db.from('digest_subscribers').update({ include_cfp: true }).eq('id', s.id);
      },
    });
    const { data: round } = await db
      .from('alert_rounds')
      .select('status')
      .eq('cadence', 'instant')
      .eq('status', 'running');
    expect(round).toHaveLength(1);
    await runAlerts('instant', LATER, NOW);
    expect((await mails(s.email))[0]!.text_body).toContain('Moved to: Hall B');
  });

  it('a round cut short continues with the same snapshot, and nobody gets two emails', async () => {
    const a = await subscriber('AD');
    const b = await subscriber('AD');
    await events('AD', 1);
    // Only one subscriber is handled, as if time ran out.
    const first = await runAlerts('instant', LATER, NOW, { maxSubscribers: 1 });
    expect(first.finished).toBe(false);
    // More changes arrive before the round finishes; they wait for the next round.
    await events('AD', 1, { title: `${tag} AD late` });
    await runAlerts('instant', LATER, NOW);
    for (const s of [a, b]) {
      const m = await mails(s.email);
      expect(m).toHaveLength(1);
      expect(m[0]!.text_body).not.toContain('AD late');
    }
    await runAlerts('instant', LATER, NOW);
    for (const s of [a, b]) expect(await mails(s.email)).toHaveLength(2);
  });

  it('pages through more than 1,000 changes and events, and says when it shows only some', async () => {
    const s = await subscriber('VA');
    await events('VA', 1050);
    await runAlerts('instant', Date.now() + 120_000, NOW);
    const m = await mails(s.email);
    expect(m).toHaveLength(1);
    expect(m[0]!.text_body).toContain('These are the first 100 of 1050.');
    await runAlerts('instant', LATER, NOW);
    expect(await mails(s.email)).toHaveLength(1);
  }, 120_000);

  it('a subscriber who unsubscribes has their queued alert dropped', async () => {
    const { dropQueuedDigests } = await import('../../src/lib/digest/subscribers.ts');
    const s = await subscriber('IS');
    await db.rpc('enqueue_emails', {
      p_emails: [
        {
          kind: 'alert',
          dedupe_key: `alert:test:${s.id}`,
          to_email: s.email,
          subject: 'x',
          html: '<p>x</p>',
          text_body: 'x',
        },
      ],
    });
    await dropQueuedDigests(s.email);
    expect(await mails(s.email)).toEqual([]);
  });
});

describe('daily alerts', () => {
  it('not before 08:00, once a day, and the next day sends what came in since', async () => {
    const s = await subscriber('MT', 'daily');
    await events('MT', 1);
    expect((await runAlerts('daily', LATER, new Date('2034-01-10T07:00:00Z'))).counts).toEqual({ not_due: 1 });
    await runAlerts('daily', LATER, NOW);
    expect(await mails(s.email)).toHaveLength(1);
    await events('MT', 1, { title: `${tag} MT next` });
    await runAlerts('daily', LATER, new Date('2034-01-10T15:00:00Z'));
    expect(await mails(s.email)).toHaveLength(1);
    await runAlerts('daily', LATER, new Date('2034-01-11T08:30:00Z'));
    const m = await mails(s.email);
    expect(m).toHaveLength(2);
    expect(m.some((x) => x.text_body.includes(`${tag} MT next`))).toBe(true);
  });
});

describe('the just-added feed', () => {
  it('a matching change is still listed after 500 unrelated ones', async () => {
    const { newFeedEntries } = await import('../../src/lib/alerts/feed.ts');
    const { parseFilters } = await import('../../src/lib/events/predicates.ts');
    const [match] = await events('GG', 1, { topics: ['careers'] });
    await events('JE', 520);
    const entries = await newFeedEntries(parseFilters(new URLSearchParams('topic=careers')).filters);
    expect(entries.some((e) => e.event.id === match)).toBe(true);
  }, 120_000);
});
