import { afterAll, describe, expect, it } from 'vitest';
import { anon, rest, service } from './helpers.ts';

const db = service();
const created: string[] = [];
afterAll(async () => {
  if (created.length) await db.from('events').delete().in('id', created);
  await db.from('email_outbox').delete().like('dedupe_key', 'itest-types:%');
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    slug: `itest-types-${uniq()}`,
    title: 'Types test event',
    summary: 'A test.',
    lang: 'en',
    all_day: false,
    starts_at: '2032-06-01T10:00:00Z',
    ends_at: '2032-06-01T11:00:00Z',
    timezone: 'UTC',
    format: 'online',
    url: 'https://example.org',
    organiser: 'Tester',
    price: 'free',
    captions: false,
    sign_language: false,
    step_free: false,
    quiet_room: false,
    hearing_loop: false,
    remote_attendance: false,
    flags: [],
    types: ['conference', 'workshop'],
    ...overrides,
  };
}

async function submit(overrides: Record<string, unknown> = {}) {
  return db.rpc('create_submission', {
    p_event: payload(overrides),
    p_private: { submitter_email: 'organiser@example.test' },
    p_nonce: `nonce-${uniq()}`,
    p_emails: [],
  });
}

async function submitted(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await submit(overrides);
  expect(error).toBeNull();
  const id = data[0].id as string;
  created.push(id);
  return id;
}

/** Inserts an event directly, bypassing the form (as imports and old data do). */
async function inserted(fields: Record<string, unknown>): Promise<{ id: string; version: number }> {
  const { flags = [], types = [], ...rest } = fields;
  const p = payload();
  delete (p as Record<string, unknown>).flags;
  delete (p as Record<string, unknown>).types;
  const { data, error } = await db
    .from('events')
    .insert({ ...p, slug: `itest-types-${uniq()}`, flags, types, ...rest })
    .select('id, version')
    .single();
  expect(error).toBeNull();
  created.push(data!.id);
  return data!;
}

const version = async (id: string) => (await db.from('events').select('version').eq('id', id).single()).data!.version;

const moderate = (id: string, v: number, status: string, key: string) =>
  db.rpc('moderate_event', {
    p_event_id: id,
    p_expected_version: v,
    p_status: status,
    p_reason: null,
    p_emails: [
      {
        kind: 'test',
        dedupe_key: `itest-types:${key}`,
        to_email: 'someone@example.test',
        subject: 'Hello',
        html: '<p>Hello</p>',
        text_body: 'Hello',
      },
    ],
  });

describe('event types', () => {
  it('create_submission keeps several types', async () => {
    const id = await submitted();
    const { data } = await db.from('events').select('types').eq('id', id).single();
    expect(data!.types).toEqual(['conference', 'workshop']);
  });

  it('create_submission refuses a payload with no types instead of storing none', async () => {
    const p = payload();
    delete (p as Record<string, unknown>).types;
    const { error } = await db.rpc('create_submission', {
      p_event: p,
      p_private: { submitter_email: 'organiser@example.test' },
      p_nonce: `nonce-${uniq()}`,
      p_emails: [],
    });
    expect(error?.code).toBe('23502');
  });

  it('rejects a type listed twice, and unknown types', async () => {
    expect((await submit({ types: ['talk', 'talk'] })).error?.code).toBe('23514');
    expect((await submit({ types: ['party'] })).error?.code).toBe('22P02');
  });

  it('saving types removes the needs_type flag', async () => {
    const e = await inserted({ flags: ['needs_type', 'changed'], status: 'pending' });
    await db
      .from('events')
      .update({ types: ['workshop'] })
      .eq('id', e.id);
    const row = await db.from('events').select('flags').eq('id', e.id).single();
    expect(row.data!.flags).toEqual(['changed']);
  });

  it('allows the needs_type flag', async () => {
    const e = await inserted({ flags: ['needs_type'], status: 'pending' });
    expect(e.id).toBeTruthy();
  });

  it('public_events exposes types, and filters by overlap', async () => {
    const id = await submitted({ types: ['meetup', 'workshop'] });
    expect((await moderate(id, await version(id), 'approved', `ov-${id}`)).error).toBeNull();
    const hit = await db.from('public_events').select('id,types').eq('id', id).overlaps('types', ['workshop', 'talk']);
    expect(hit.data).toEqual([{ id, types: ['meetup', 'workshop'] }]);
    const miss = await db.from('public_events').select('id').eq('id', id).overlaps('types', ['conference']);
    expect(miss.data).toEqual([]);
  });

  it('changing the types of a published event bumps its sequence', async () => {
    const id = await submitted();
    await moderate(id, await version(id), 'approved', `seq-${id}`);
    const before = (await db.from('events').select('sequence').eq('id', id).single()).data!.sequence;
    await db
      .from('events')
      .update({ types: ['talk'] })
      .eq('id', id);
    const after = (await db.from('events').select('sequence').eq('id', id).single()).data!.sequence;
    expect(after).toBe(before + 1);
  });

  it('anon still cannot read events or the view', async () => {
    expect((await anon().from('events').select('types').limit(1)).error).not.toBeNull();
    expect((await rest('public_events?select=types&limit=1')).status).toBeGreaterThanOrEqual(400);
  });
});

describe('moderate_event and types', () => {
  it('refuses a first publish with no types, and queues no email', async () => {
    const e = await inserted({ flags: ['needs_type'], status: 'pending' });
    const r = await moderate(e.id, e.version, 'approved', `none-${e.id}`);
    expect(r.error?.message).toBe('needs_type');
    const mail = await db.from('email_outbox').select('id').eq('dedupe_key', `itest-types:none-${e.id}`);
    expect(mail.data).toEqual([]);
    const row = await db.from('events').select('status').eq('id', e.id).single();
    expect(row.data!.status).toBe('pending');
  });

  it('a never-published event with no types cannot be made public as cancelled either', async () => {
    const e = await inserted({ flags: ['needs_type'], status: 'pending' });
    const r = await moderate(e.id, e.version, 'cancelled', `cancel-untyped-${e.id}`);
    expect(r.error?.message).toBe('needs_type');
    expect((await db.from('public_events').select('id').eq('id', e.id)).data).toEqual([]);
  });

  it('a typed first publish works and clears needs_type', async () => {
    const e = await inserted({ flags: ['needs_type', 'possible_duplicate'], types: ['meetup'], status: 'pending' });
    const r = await moderate(e.id, e.version, 'approved', `typed-${e.id}`);
    expect(r.error).toBeNull();
    const row = await db.from('events').select('status, flags').eq('id', e.id).single();
    expect(row.data).toEqual({ status: 'approved', flags: [] });
  });

  it('an older untyped event that was published before can be republished and restored', async () => {
    const e = await inserted({ status: 'approved' });
    // Unpublish (back to pending), then publish again.
    expect((await moderate(e.id, await version(e.id), 'pending', `unpub-${e.id}`)).error).toBeNull();
    expect((await moderate(e.id, await version(e.id), 'approved', `repub-${e.id}`)).error).toBeNull();
    // Cancel, then restore.
    expect((await moderate(e.id, await version(e.id), 'cancelled', `cancel-${e.id}`)).error).toBeNull();
    expect((await moderate(e.id, await version(e.id), 'approved', `restore-${e.id}`)).error).toBeNull();
  });

  it('a stale version still fails', async () => {
    const e = await inserted({ types: ['talk'], status: 'pending' });
    expect((await moderate(e.id, e.version - 1, 'approved', `stale-${e.id}`)).error?.message).toBe('version_conflict');
  });
});

describe('digest subscribers and types', () => {
  it('stores types, empty by default', async () => {
    const email = `types-${uniq()}@example.test`;
    const a = await db.from('digest_subscribers').insert({ email, cadence: 'weekly' }).select('types').single();
    expect(a.data!.types).toEqual([]);
    const b = await db
      .from('digest_subscribers')
      .update({ types: ['conference'] })
      .eq('email', email)
      .select('types')
      .single();
    expect(b.data!.types).toEqual(['conference']);
    await db.from('digest_subscribers').delete().eq('email', email);
  });
});
