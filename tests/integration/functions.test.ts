import { afterAll, describe, expect, it } from 'vitest';
import { rest, service } from './helpers.ts';

const db = service();
const createdEvents: string[] = [];
const createdEmails: string[] = [];

afterAll(async () => {
  if (createdEvents.length) await db.from('events').delete().in('id', createdEvents);
  await db.from('email_outbox').delete().like('dedupe_key', 'itest:%');
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function eventPayload(overrides: Record<string, unknown> = {}) {
  return {
    slug: `itest-${uniq()}`,
    title: 'Integration test event',
    summary: 'A test.',
    description: null,
    lang: 'en',
    all_day: false,
    starts_at: '2032-05-01T10:00:00Z',
    ends_at: '2032-05-01T11:00:00Z',
    start_date: null,
    end_date: null,
    timezone: 'UTC',
    format: 'online',
    country_code: null,
    city: null,
    venue: null,
    url: 'https://example.org',
    organiser: 'Tester',
    price: 'free',
    captions: false,
    sign_language: false,
    step_free: false,
    quiet_room: false,
    hearing_loop: false,
    remote_attendance: false,
    access_notes: null,
    flags: [],
    ...overrides,
  };
}

const email = (key: string) => ({
  kind: 'test',
  dedupe_key: `itest:${key}`,
  to_email: 'someone@example.test',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text_body: 'Hello',
});

describe('hit_rate_limit', () => {
  it('lets exactly the limit through when requests arrive at the same time', async () => {
    const bucket = `itest:${uniq()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.rpc('hit_rate_limit', { p_bucket: bucket, p_limit: 5, p_window_seconds: 3600 }),
      ),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(results.filter((r) => r.data === true)).toHaveLength(5);
  });

  it('cannot be called with the anon key', async () => {
    const res = await rest('rpc/hit_rate_limit', {
      method: 'POST',
      body: JSON.stringify({ p_bucket: 'x', p_limit: 1000, p_window_seconds: 1 }),
    });
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('create_submission', () => {
  it('creates the event, its private details and its emails together', async () => {
    const nonce = `nonce-${uniq()}`;
    const { data, error } = await db.rpc('create_submission', {
      p_event: eventPayload(),
      p_private: { submitter_email: 'organiser@example.test', submitter_name: 'Org' },
      p_nonce: nonce,
      p_emails: [email(`received-${nonce}`)],
    });
    expect(error).toBeNull();
    const id = data[0].id as string;
    createdEvents.push(id);
    const ev = await db.from('events').select('status, source').eq('id', id).single();
    expect(ev.data).toEqual({ status: 'pending', source: 'form' });
    const priv = await db.from('events_private').select('submitter_email').eq('event_id', id).single();
    expect(priv.data!.submitter_email).toBe('organiser@example.test');
    const mail = await db.from('email_outbox').select('status').eq('dedupe_key', `itest:received-${nonce}`);
    expect(mail.data).toEqual([{ status: 'queued' }]);
  });

  it('refuses a replayed nonce and creates nothing', async () => {
    const nonce = `nonce-${uniq()}`;
    const args = (slug: string) => ({
      p_event: eventPayload({ slug }),
      p_private: { submitter_email: 'o@example.test' },
      p_nonce: nonce,
      p_emails: [],
    });
    const first = await db.rpc('create_submission', args(`itest-a-${uniq()}`));
    createdEvents.push(first.data[0].id);
    const secondSlug = `itest-b-${uniq()}`;
    const second = await db.rpc('create_submission', args(secondSlug));
    expect(second.error?.message).toBe('already_submitted');
    const { count } = await db.from('events').select('id', { count: 'exact', head: true }).eq('slug', secondSlug);
    expect(count).toBe(0);
  });

  it('rolls back the nonce if the event is invalid, so the person can fix it and try again', async () => {
    const nonce = `nonce-${uniq()}`;
    const bad = await db.rpc('create_submission', {
      p_event: eventPayload({ timezone: 'Not/AZone' }),
      p_private: { submitter_email: 'o@example.test' },
      p_nonce: nonce,
      p_emails: [],
    });
    expect(bad.error).not.toBeNull();
    const retry = await db.rpc('create_submission', {
      p_event: eventPayload(),
      p_private: { submitter_email: 'o@example.test' },
      p_nonce: nonce,
      p_emails: [],
    });
    expect(retry.error).toBeNull();
    createdEvents.push(retry.data[0].id);
  });

  it('flags likely duplicates', async () => {
    const base = {
      title: 'Duplicate detection meetup in Porto',
      format: 'in_person',
      country_code: 'PT',
      city: 'Porto',
    };
    const a = await db.rpc('create_submission', {
      p_event: eventPayload(base),
      p_private: {},
      p_nonce: `nonce-${uniq()}`,
      p_emails: [],
    });
    createdEvents.push(a.data[0].id);
    const b = await db.rpc('create_submission', {
      p_event: eventPayload({
        ...base,
        title: 'Duplicate detection meetup, Porto',
        starts_at: '2032-05-01T12:00:00Z',
        ends_at: '2032-05-01T13:00:00Z',
      }),
      p_private: {},
      p_nonce: `nonce-${uniq()}`,
      p_emails: [],
    });
    createdEvents.push(b.data[0].id);
    expect(b.data[0].duplicates).toBe(1);
    const flagged = await db.from('events').select('flags').eq('id', b.data[0].id).single();
    expect(flagged.data!.flags).toContain('possible_duplicate');
  });
});

describe('moderate_event', () => {
  it('approves with the expected version and refuses a stale one', async () => {
    const created = await db.rpc('create_submission', {
      p_event: eventPayload(),
      p_private: {},
      p_nonce: `nonce-${uniq()}`,
      p_emails: [],
    });
    const id = created.data[0].id as string;
    createdEvents.push(id);
    const { version } = (await db.from('events').select('version').eq('id', id).single()).data!;
    const ok = await db.rpc('moderate_event', {
      p_event_id: id,
      p_expected_version: version,
      p_status: 'approved',
      p_reason: null,
      p_emails: [],
    });
    expect(ok.error).toBeNull();
    expect(ok.data.status).toBe('approved');
    const stale = await db.rpc('moderate_event', {
      p_event_id: id,
      p_expected_version: version,
      p_status: 'rejected',
      p_reason: 'x',
      p_emails: [],
    });
    expect(stale.error?.message).toBe('version_conflict');
  });

  it('stores the rejection reason privately', async () => {
    const created = await db.rpc('create_submission', {
      p_event: eventPayload(),
      p_private: { submitter_email: 'o@example.test' },
      p_nonce: `nonce-${uniq()}`,
      p_emails: [],
    });
    const id = created.data[0].id as string;
    createdEvents.push(id);
    const { version } = (await db.from('events').select('version').eq('id', id).single()).data!;
    const r = await db.rpc('moderate_event', {
      p_event_id: id,
      p_expected_version: version,
      p_status: 'rejected',
      p_reason: 'Not about accessibility',
      p_emails: [],
    });
    expect(r.error).toBeNull();
    const priv = await db.from('events_private').select('rejection_reason').eq('event_id', id).single();
    expect(priv.data!.rejection_reason).toBe('Not about accessibility');
  });
});

describe('email outbox', () => {
  it('skips a second email with the same dedupe key', async () => {
    const key = uniq();
    const first = await db.rpc('enqueue_emails', { p_emails: [email(key)] });
    const second = await db.rpc('enqueue_emails', { p_emails: [email(key)] });
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(0);
    createdEmails.push(first.data[0]);
  });

  it('gives each email to only one of two concurrent senders', async () => {
    const ids = (await db.rpc('enqueue_emails', { p_emails: [email(uniq()), email(uniq()), email(uniq())] }))
      .data as string[];
    const [a, b] = await Promise.all([
      db.rpc('claim_outbox', { p_limit: 10, p_lease_seconds: 60, p_ids: ids }),
      db.rpc('claim_outbox', { p_limit: 10, p_lease_seconds: 60, p_ids: ids }),
    ]);
    const claimed = [...a.data, ...b.data].map((r: { id: string }) => r.id);
    expect(claimed.sort()).toEqual([...ids].sort());
  });

  it('reclaims an expired lease, but marks it unknown after 24 hours', async () => {
    const [id] = (await db.rpc('enqueue_emails', { p_emails: [email(uniq())] })).data as string[];
    await db.rpc('claim_outbox', { p_limit: 1, p_lease_seconds: 60, p_ids: [id] });
    await db
      .from('email_outbox')
      .update({ lease_until: new Date(Date.now() - 1000).toISOString() })
      .eq('id', id!);
    const again = await db.rpc('claim_outbox', { p_limit: 1, p_lease_seconds: 60, p_ids: [id] });
    expect(again.data).toHaveLength(1);
    expect(again.data[0].attempts).toBe(2);

    await db
      .from('email_outbox')
      .update({
        lease_until: new Date(Date.now() - 1000).toISOString(),
        first_sent_attempt_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
      })
      .eq('id', id!);
    const late = await db.rpc('claim_outbox', { p_limit: 1, p_lease_seconds: 60, p_ids: [id] });
    expect(late.data).toHaveLength(0);
    const row = await db.from('email_outbox').select('status').eq('id', id!).single();
    expect(row.data!.status).toBe('unknown');
  });
});

describe('review regressions: outbox', () => {
  it('marks a re-queued email unknown once its first attempt is over 24 hours old', async () => {
    const [id] = (await db.rpc('enqueue_emails', { p_emails: [email(uniq())] })).data as string[];
    await db
      .from('email_outbox')
      .update({
        status: 'queued',
        attempts: 1,
        first_sent_attempt_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
      })
      .eq('id', id!);
    const claimed = await db.rpc('claim_outbox', { p_limit: 5, p_lease_seconds: 60, p_ids: [id] });
    expect(claimed.data).toHaveLength(0);
    expect((await db.from('email_outbox').select('status').eq('id', id!).single()).data!.status).toBe('unknown');
  });

  it('a sender that lost its lease cannot overwrite the new owner', async () => {
    const { sendOutbox } = await import('../../src/lib/email/outbox.ts');
    const { setMailer } = await import('../../src/lib/services/mailer.ts');
    const [id] = (await db.rpc('enqueue_emails', { p_emails: [email(uniq())] })).data as string[];
    setMailer({
      send: async () => {
        // While "sending", the lease expires and another sender claims it.
        await db
          .from('email_outbox')
          .update({ lease_until: new Date(Date.now() - 1000).toISOString() })
          .eq('id', id!);
        await db.rpc('claim_outbox', { p_limit: 1, p_lease_seconds: 60, p_ids: [id] });
        return { id: 'provider-1' };
      },
    });
    try {
      const summary = await sendOutbox({ ids: [id!] });
      expect(summary).toMatchObject({ sent: 0, lost_lease: 1 });
      expect((await db.from('email_outbox').select('status').eq('id', id!).single()).data!.status).toBe('sending');
    } finally {
      setMailer(undefined);
    }
  });
});
