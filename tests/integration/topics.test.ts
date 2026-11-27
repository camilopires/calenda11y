import { afterAll, describe, expect, it } from 'vitest';
import { anon, service } from './helpers.ts';

const db = service();
const created: string[] = [];
afterAll(async () => {
  if (created.length) await db.from('events').delete().in('id', created);
});
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const base = (over: Record<string, unknown> = {}) => ({
  slug: `itest-topics-${uniq()}`,
  title: 'Topics test',
  summary: 'A test.',
  lang: 'en',
  all_day: false,
  starts_at: '2032-07-01T10:00:00Z',
  ends_at: '2032-07-01T11:00:00Z',
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
  types: ['talk'],
  ...over,
});

async function submit(over: Record<string, unknown> = {}) {
  const r = await db.rpc('create_submission', {
    p_event: base(over),
    p_private: { submitter_email: 'o@example.test' },
    p_nonce: `nonce-${uniq()}`,
    p_emails: [],
  });
  if (r.data?.[0]?.id) created.push(r.data[0].id);
  return r;
}

describe('event topics', () => {
  it('create_submission saves topics, and none when the payload has none', async () => {
    const a = await submit({ topics: ['testing', 'law'] });
    expect(a.error).toBeNull();
    const b = await submit();
    expect(b.error).toBeNull();
    const rows = (await db.from('events').select('id,topics').in('id', [a.data[0].id, b.data[0].id])).data!;
    const by = Object.fromEntries(rows.map((r) => [r.id, r.topics]));
    expect(by[a.data[0].id]).toEqual(['testing', 'law']);
    expect(by[b.data[0].id]).toEqual([]);
  });

  it('refuses a topic twice and unknown topics', async () => {
    expect((await submit({ topics: ['law', 'law'] })).error?.code).toBe('23514');
    expect((await submit({ topics: ['cooking'] })).error?.code).toBe('22P02');
  });

  it('the view exposes topics, filters by overlap, and a change bumps the sequence', async () => {
    const { data } = await db
      .from('events')
      .insert({ ...base({ topics: ['mobile'] }), status: 'approved' })
      .select('id,sequence')
      .single();
    created.push(data!.id);
    const hit = await db
      .from('public_events')
      .select('id,topics')
      .eq('id', data!.id)
      .overlaps('topics', ['mobile', 'law']);
    expect(hit.data).toEqual([{ id: data!.id, topics: ['mobile'] }]);
    await db
      .from('events')
      .update({ topics: ['mobile', 'careers'] })
      .eq('id', data!.id);
    const after = (await db.from('events').select('sequence').eq('id', data!.id).single()).data!;
    expect(after.sequence).toBe(data!.sequence + 1);
  });

  it('topic counts include upcoming published and cancelled events, and anon cannot read them', async () => {
    const count = async () =>
      (await db.from('public_topic_counts').select('upcoming').eq('topic', 'careers').maybeSingle()).data?.upcoming ??
      0;
    const before = await count();
    const rows = [
      { ...base({ topics: ['careers'] }), status: 'approved' },
      { ...base({ topics: ['careers'] }), status: 'cancelled' },
      { ...base({ topics: ['careers'] }), status: 'pending' },
      {
        ...base({ topics: ['careers'], starts_at: '2020-01-01T10:00:00Z', ends_at: '2020-01-01T11:00:00Z' }),
        status: 'approved',
      },
    ];
    const { data } = await db.from('events').insert(rows).select('id');
    created.push(...data!.map((d) => d.id));
    expect(await count()).toBe(before + 2);
    expect((await anon().from('public_topic_counts').select('topic')).error).not.toBeNull();
  });

  it('digest subscribers have topics, empty by default', async () => {
    const email = `topics-${uniq()}@example.test`;
    const { data } = await db.from('digest_subscribers').insert({ email, cadence: 'weekly' }).select('topics').single();
    expect(data!.topics).toEqual([]);
    await db.from('digest_subscribers').delete().eq('email', email);
  });
});
