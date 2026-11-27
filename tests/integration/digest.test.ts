import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDigest } from '../../src/lib/digest/send.ts';
import { service } from './helpers.ts';

const db = service();
// A Monday well in the future, so the period is ours alone.
const NOW = new Date('2031-03-03T09:00:00Z');
const tag = `digest${Date.now()}`;
const subs: string[] = [];

beforeAll(async () => {
  await db.from('digest_runs').delete().eq('period_start', '2031-03-03');
  await db.from('events').insert([
    {
      slug: `${tag}-pt`,
      title: `${tag} Lisbon`,
      summary: 'In Lisbon.',
      timezone: 'Europe/Lisbon',
      format: 'in_person',
      country_code: 'PT',
      city: 'Lisbon',
      starts_at: '2031-03-05T18:00:00Z',
      ends_at: '2031-03-05T20:00:00Z',
      status: 'approved',
    },
    {
      slug: `${tag}-online`,
      title: `${tag} Online`,
      summary: 'Online.',
      timezone: 'UTC',
      format: 'online',
      starts_at: '2031-03-06T15:00:00Z',
      ends_at: '2031-03-06T16:00:00Z',
      status: 'approved',
    },
    {
      slug: `${tag}-next-week`,
      title: `${tag} Next week`,
      summary: 'Later.',
      timezone: 'UTC',
      format: 'online',
      starts_at: '2031-03-12T15:00:00Z',
      ends_at: '2031-03-12T16:00:00Z',
      status: 'approved',
    },
    {
      slug: `${tag}-pending`,
      title: `${tag} Pending`,
      summary: 'Not public.',
      timezone: 'UTC',
      format: 'online',
      starts_at: '2031-03-06T15:00:00Z',
      ends_at: '2031-03-06T16:00:00Z',
      status: 'pending',
    },
  ]);
  const { data } = await db
    .from('digest_subscribers')
    .insert([
      { email: `pt-${tag}@example.test`, cadence: 'weekly', countries: ['PT'], confirmed_at: new Date().toISOString() },
      {
        email: `online-${tag}@example.test`,
        cadence: 'weekly',
        countries: ['online'],
        confirmed_at: new Date().toISOString(),
      },
      { email: `jp-${tag}@example.test`, cadence: 'weekly', countries: ['JP'], confirmed_at: new Date().toISOString() },
      { email: `unconfirmed-${tag}@example.test`, cadence: 'weekly', countries: [] },
      {
        email: `bounced-${tag}@example.test`,
        cadence: 'weekly',
        countries: [],
        confirmed_at: new Date().toISOString(),
        suppressed_at: new Date().toISOString(),
      },
    ])
    .select('id');
  subs.push(...data!.map((d) => d.id));
});

afterAll(async () => {
  await db.from('events').delete().like('slug', `${tag}-%`);
  await db.from('digest_subscribers').delete().in('id', subs);
  await db.from('email_outbox').delete().like('to_email', `%${tag}@example.test`);
  await db.from('digest_runs').delete().eq('period_start', '2031-03-03');
});

const outbox = async () =>
  (
    await db
      .from('email_outbox')
      .select('to_email,subject,text_body,headers')
      .like('to_email', `%${tag}@example.test`)
      .order('to_email')
  ).data!;

describe('weekly digest', () => {
  it('queues one email per subscriber with matching published events, in this week only', async () => {
    const r = await runDigest('weekly', Date.now() + 30_000, NOW);
    expect(r.finished).toBe(true);
    const mails = await outbox();
    expect(mails.map((m) => m.to_email)).toEqual([`online-${tag}@example.test`, `pt-${tag}@example.test`]);
    const pt = mails.find((m) => m.to_email.startsWith('pt-'))!;
    expect(pt.subject).toBe('Accessibility events: 3 to 9 March 2031');
    expect(pt.text_body).toContain(`${tag} Lisbon`);
    expect(pt.text_body).not.toContain(`${tag} Online`);
    expect(pt.text_body).not.toContain('Next week');
    expect(pt.text_body).not.toContain('Pending');
    expect(pt.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const online = mails.find((m) => m.to_email.startsWith('online-'))!;
    expect(online.text_body).toContain(`${tag} Online`);
  });

  it('does not queue anything twice when it runs again, or twice at once', async () => {
    await db.from('digest_runs').update({ status: 'running', cursor: null }).eq('period_start', '2031-03-03');
    await Promise.all([runDigest('weekly', Date.now() + 30_000, NOW), runDigest('weekly', Date.now() + 30_000, NOW)]);
    expect(await outbox()).toHaveLength(2);
  });

  it('keeps the period fixed for a late run', async () => {
    const late = await runDigest('weekly', Date.now() + 30_000, new Date('2031-03-06T09:00:00Z'));
    expect(late.finished).toBe(true);
    const { data } = await db
      .from('digest_runs')
      .select('period_start,period_end,status')
      .eq('period_start', '2031-03-03')
      .single();
    expect(data).toEqual({ period_start: '2031-03-03', period_end: '2031-03-09', status: 'complete' });
  });

  it('is not sent before Monday 08:00 UTC', async () => {
    const r = await runDigest('weekly', Date.now() + 30_000, new Date('2031-03-10T07:00:00Z'));
    expect(r.counts).toEqual({ not_due: 1 });
  });
});

describe('review regressions: digest', () => {
  it('unsubscribing drops digests still waiting to be sent', async () => {
    const { unsubscribe } = await import('../../src/lib/digest/subscribers.ts');
    const addr = `leaver-${tag}@example.test`;
    const { data: sub } = await db
      .from('digest_subscribers')
      .insert({ email: addr, cadence: 'weekly', confirmed_at: new Date().toISOString() })
      .select('id,email')
      .single();
    await db.rpc('enqueue_emails', {
      p_emails: [
        {
          kind: 'digest',
          dedupe_key: `digest:test:${sub!.id}`,
          to_email: addr,
          subject: 'S',
          html: '<p>x</p>',
          text_body: 'x',
        },
      ],
    });
    await unsubscribe(sub!);
    const { data } = await db.from('email_outbox').select('id').eq('to_email', addr);
    expect(data).toEqual([]);
  });

  it('finishes a run left unfinished when the period ended', async () => {
    // An unfinished run from the week before, with our subscribers still to do.
    await db.from('digest_runs').delete().eq('period_start', '2031-02-24');
    await db
      .from('digest_runs')
      .insert({ cadence: 'weekly', period_start: '2031-02-24', period_end: '2031-03-02', status: 'running' });
    await runDigest('weekly', Date.now() + 30_000, new Date('2031-03-03T09:00:00Z'));
    const { data } = await db.from('digest_runs').select('status').eq('period_start', '2031-02-24').single();
    expect(data!.status).toBe('complete');
    await db.from('digest_runs').delete().eq('period_start', '2031-02-24');
  });
});
