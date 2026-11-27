/**
 * The add-an-event and report forms can't be used to flood an inbox: the
 * submitter's acknowledgement is limited per address, and notices to admins
 * share one limit for the whole site.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSubmission } from '../../src/lib/forms/submissions.ts';
import { createReport } from '../../src/lib/forms/report.ts';
import { EMPTY_EVENT_FORM, validateEvent, type EventRecord } from '../../src/lib/forms/event.ts';
import { LIMITS, allow } from '../../src/lib/security/ratelimit.ts';
import { randomToken } from '../../src/lib/security/tokens.ts';
import { service } from './helpers.ts';

const db = service();
const tag = `limits${Date.now()}`;
const adminEmail = `admin-${tag}@example.test`;
let adminId = '';

function record(title: string): EventRecord {
  const r = validateEvent(
    {
      ...EMPTY_EVENT_FORM,
      title,
      summary: 'Short talks.',
      organiser: 'A11y Lisboa',
      url: 'https://example.org/lisbon',
      timing: 'timed',
      start_date: '2031-12-03',
      start_time: '18:30',
      end_time: '20:30',
      timezone: 'Europe/Lisbon',
      format: 'in_person',
      country: 'PT',
      city: 'Lisbon',
      price: 'free',
      types: ['meetup'],
    },
    { now: new Date('2031-11-01T12:00:00Z') },
  );
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.record;
}

const resetAdminLimit = () => db.from('rate_limits').delete().like('bucket', `${LIMITS.adminNotifyGlobal.name}:%`);

const outbox = async (kind: string, to?: string, label = '') => {
  let q = db.from('email_outbox').select('id').eq('kind', kind).like('dedupe_key', `%${tag}${label}%`);
  if (to) q = q.eq('to_email', to);
  return (await q).data ?? [];
};

beforeAll(async () => {
  const created = await db.auth.admin.createUser({ email: adminEmail, email_confirm: true });
  if (created.error) throw created.error;
  adminId = created.data.user!.id;
  await db.from('admins').insert({ user_id: adminId });
});

beforeEach(resetAdminLimit);

afterAll(async () => {
  await resetAdminLimit();
  await db.from('email_outbox').delete().like('dedupe_key', `%${tag}%`);
  await db.from('events').delete().like('title', `${tag}%`);
  await db.from('admins').delete().eq('user_id', adminId);
  await db.auth.admin.deleteUser(adminId);
});

describe('submission acknowledgements', () => {
  it('go to one address at most 3 times a day; every event is still saved', async () => {
    const to = `flooded-${tag}@example.test`;
    for (let i = 0; i < 4; i++) {
      const r = await createSubmission(
        record(`${tag} ack ${i}`),
        { email: to, name: '' },
        'verified',
        `${tag}-ack-${i}-${randomToken(8)}`,
      );
      expect(r.status).toBe('created');
    }
    expect(await outbox('submission_received', to)).toHaveLength(3);
    const { data } = await db.from('events').select('id').like('title', `${tag} ack %`);
    expect(data).toHaveLength(4);
  });
});

describe('notices to admins', () => {
  it('stop once the site-wide limit is used up, but the event is still saved', async () => {
    for (let i = 0; i < LIMITS.adminNotifyGlobal.limit; i++) await allow(LIMITS.adminNotifyGlobal, 'admin-notify');
    const r = await createSubmission(
      record(`${tag} over`),
      { email: `over-${tag}@example.test`, name: '' },
      'verified',
      `${tag}-over-${randomToken(8)}`,
    );
    expect(r.status).toBe('created');
    expect(await outbox('admin_new_submission', adminEmail, '-over-')).toEqual([]);
    const { data } = await db.from('events').select('id').eq('title', `${tag} over`);
    expect(data).toHaveLength(1);
  });

  it('are sent while under the limit', async () => {
    await createSubmission(
      record(`${tag} under`),
      { email: `under-${tag}@example.test`, name: '' },
      'verified',
      `${tag}-under-${randomToken(8)}`,
    );
    expect(await outbox('admin_new_submission', adminEmail, '-under-')).toHaveLength(1);
  });

  it('share the limit with reports', async () => {
    const { data: ev } = await db.from('events').select('id,title,lang').eq('title', `${tag} over`).single();
    for (let i = 0; i < LIMITS.adminNotifyGlobal.limit; i++) await allow(LIMITS.adminNotifyGlobal, 'admin-notify');
    const r = await createReport(
      ev as { id: string; title: string; lang: string },
      { reason: 'spam', details: '', email: '' },
      `${tag}-report-${randomToken(8)}`,
    );
    expect(r).toBe('created');
    expect(await outbox('admin_report', adminEmail)).toEqual([]);
  });
});
