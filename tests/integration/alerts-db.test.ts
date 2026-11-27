import { afterAll, describe, expect, it } from 'vitest';
import { anon, service } from './helpers.ts';

const db = service();
const tag = `alertdb${Date.now()}`;
const events: string[] = [];
const subs: string[] = [];
afterAll(async () => {
  if (events.length) await db.from('events').delete().in('id', events);
  if (subs.length) await db.from('digest_subscribers').delete().in('id', subs);
  await db.from('email_outbox').delete().like('dedupe_key', `itest-${tag}%`);
});
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function event(fields: Record<string, unknown> = {}) {
  const { data, error } = await db
    .from('events')
    .insert({
      slug: `${tag}-${uniq()}`,
      title: `${tag} event`,
      summary: 'A test.',
      timezone: 'Europe/Lisbon',
      format: 'in_person',
      country_code: 'PT',
      city: 'Lisbon',
      venue: 'Rua das Flores 12',
      starts_at: '2032-08-01T18:00:00Z',
      ends_at: '2032-08-01T20:00:00Z',
      types: ['meetup'],
      status: 'pending',
      ...fields,
    })
    .select('id,version')
    .single();
  expect(error).toBeNull();
  events.push(data!.id);
  return data!;
}

const changesFor = async (id: string) =>
  (await db.from('event_changes').select('kind,what,before_status,after').eq('event_id', id).order('id')).data!;

describe('the change log', () => {
  it('logs "new" when an event is first published, by insert or by update', async () => {
    const direct = await event({ status: 'approved' });
    expect(await changesFor(direct.id)).toMatchObject([{ kind: 'new', what: [] }]);
    const later = await event();
    expect(await changesFor(later.id)).toEqual([]);
    await db.from('events').update({ status: 'approved' }).eq('id', later.id);
    expect(await changesFor(later.id)).toMatchObject([{ kind: 'new', what: [], before_status: 'pending' }]);
  });

  it('logs each kind of material change, and nothing for other edits or unpublishing', async () => {
    const e = await event({ status: 'approved' });
    const upd = (f: Record<string, unknown>) => db.from('events').update(f).eq('id', e.id);
    await upd({ title: 'Just a new title', summary: 'Better words.' });
    await upd({ starts_at: '2032-08-02T18:00:00Z', ends_at: '2032-08-02T20:00:00Z' });
    await upd({ venue: 'Praça do Comércio' });
    await upd({ cfp_url: 'https://cfp.example/speak' });
    await upd({ captions: true });
    await upd({ status: 'cancelled' });
    await upd({ status: 'approved' });
    await upd({ city: 'Porto', step_free: true });
    await upd({ status: 'pending' });
    const rows = await changesFor(e.id);
    expect(rows.map((r) => [r.kind, r.what])).toEqual([
      ['new', []],
      ['updated', ['time']],
      ['updated', ['place']],
      ['updated', ['cfp']],
      ['updated', ['access']],
      ['updated', ['cancelled']],
      ['updated', ['restored']],
      ['updated', ['place', 'access']],
    ]);
    // Each row keeps what was true then.
    expect(rows[2]!.after).toMatchObject({ venue: 'Praça do Comércio', city: 'Lisbon' });
    expect(rows[7]!.after).toMatchObject({ city: 'Porto', step_free: true });
  });

  it('is never readable by anon', async () => {
    expect((await anon().from('event_changes').select('id').limit(1)).error).not.toBeNull();
  });
});

describe('sequencing in commit order', () => {
  it('a change that becomes visible later gets a later number, even with a lower id', async () => {
    const e = await event({ status: 'approved' });
    const first = (await db.rpc('sequence_changes')).data as number;
    // A row with a low id that only appears now, as if its transaction committed late.
    const { data: late, error } = await db
      .from('event_changes')
      .insert({ id: -Date.now(), event_id: e.id, kind: 'updated', what: ['time'], after: {} })
      .select('id')
      .single();
    expect(error).toBeNull();
    const second = (await db.rpc('sequence_changes')).data as number;
    const { data } = await db.from('event_changes').select('seq').eq('id', late!.id).single();
    expect(data!.seq).toBeGreaterThan(first);
    expect(data!.seq).toBe(second);
    await db.from('event_changes').delete().eq('id', late!.id);
  });
});

async function subscriber(fields: Record<string, unknown> = {}) {
  const { data, error } = await db
    .from('digest_subscribers')
    .insert({ email: `${uniq()}-${tag}@example.test`, cadence: 'instant', ...fields })
    .select('id,alert_cursor,prefs_revision,cadence')
    .single();
  expect(error).toBeNull();
  subs.push(data!.id);
  return data!;
}

const mail = (key: string) => ({
  kind: 'alert',
  dedupe_key: `itest-${tag}-${key}`,
  to_email: 'someone@example.test',
  subject: 'Alerts',
  html: '<p>Hi</p>',
  text_body: 'Hi',
});

describe('subscriber baseline and revision', () => {
  it('confirming an alert subscription sets the baseline; saving preferences bumps the revision', async () => {
    await db.rpc('sequence_changes');
    const s = await subscriber();
    expect(s.alert_cursor).toBeNull();
    const max = (
      await db.from('event_changes').select('seq').not('seq', 'is', null).order('seq', { ascending: false }).limit(1)
    ).data;
    const { data: confirmed } = await db
      .from('digest_subscribers')
      .update({ confirmed_at: new Date().toISOString() })
      .eq('id', s.id)
      .select('alert_cursor,prefs_revision')
      .single();
    expect(confirmed!.alert_cursor).toBe(max?.[0]?.seq ?? 0);
    const { data: saved } = await db
      .from('digest_subscribers')
      .update({ topics: ['law'] })
      .eq('id', s.id)
      .select('prefs_revision')
      .single();
    expect(saved!.prefs_revision).toBe(confirmed!.prefs_revision + 1);
    const { data: weekly } = await db
      .from('digest_subscribers')
      .update({ cadence: 'weekly' })
      .eq('id', s.id)
      .select('alert_cursor')
      .single();
    expect(weekly!.alert_cursor).toBeNull();
  });
});

describe('queue_alert', () => {
  async function ready() {
    const s = await subscriber({ confirmed_at: new Date().toISOString() });
    const { data } = await db.from('digest_subscribers').select('alert_cursor,prefs_revision').eq('id', s.id).single();
    return { id: s.id, cursor: data!.alert_cursor as number, revision: data!.prefs_revision as number };
  }
  const call = (s: { id: string; cursor: number; revision: number }, over: Record<string, unknown> = {}) =>
    db.rpc('queue_alert', {
      p_subscriber: s.id,
      p_cadence: 'instant',
      p_revision: s.revision,
      p_from: s.cursor,
      p_to: s.cursor + 5,
      p_email: mail(`${s.id}-${s.cursor + 5}`),
      ...over,
    });

  it('moves the cursor and queues once; a stale cursor does nothing', async () => {
    const s = await ready();
    expect((await call(s)).data).toBe(true);
    expect((await call(s)).data).toBe(false);
    const { data } = await db
      .from('email_outbox')
      .select('id')
      .eq('dedupe_key', `itest-${tag}-${s.id}-${s.cursor + 5}`);
    expect(data).toHaveLength(1);
  });

  it('does nothing for a suppressed subscriber, another cadence or old preferences', async () => {
    for (const change of [{ suppressed_at: new Date().toISOString() }, { cadence: 'daily' }, { topics: ['mobile'] }]) {
      const s = await ready();
      await db.from('digest_subscribers').update(change).eq('id', s.id);
      // The baseline moves when the cadence changes, so read the cursor again for that case.
      const now = (await db.from('digest_subscribers').select('alert_cursor').eq('id', s.id).single()).data!;
      expect((await call({ ...s, cursor: now.alert_cursor ?? s.cursor })).data).toBe(false);
    }
  });

  it('moves the cursor without queueing when there is nothing to send', async () => {
    const s = await ready();
    expect((await call(s, { p_email: null })).data).toBe(true);
    const { data } = await db.from('digest_subscribers').select('alert_cursor').eq('id', s.id).single();
    expect(data!.alert_cursor).toBe(s.cursor + 5);
  });

  it('rolls back the cursor when queueing fails, and a retry works', async () => {
    const s = await ready();
    const bad = await call(s, { p_email: { kind: 'alert' } });
    expect(bad.error).not.toBeNull();
    const { data } = await db.from('digest_subscribers').select('alert_cursor').eq('id', s.id).single();
    expect(data!.alert_cursor).toBe(s.cursor);
    expect((await call(s)).data).toBe(true);
  });
});

describe('cleanup', () => {
  it('keeps old changes a subscriber still needs, and removes the rest', async () => {
    const e = await event({ status: 'approved' });
    await db.rpc('sequence_changes');
    const old = new Date(Date.now() - 70 * 86_400_000).toISOString();
    await db.from('event_changes').update({ created_at: old }).eq('event_id', e.id);
    const { data: row } = await db.from('event_changes').select('seq').eq('event_id', e.id).single();
    const lagging = await subscriber({ confirmed_at: new Date().toISOString() });
    await db
      .from('digest_subscribers')
      .update({ alert_cursor: row!.seq - 1 })
      .eq('id', lagging.id);
    await db.rpc('run_cleanup_digest');
    expect(await changesFor(e.id)).toHaveLength(1);
    // Everyone with alerts (including subscribers other tests left behind) has now had it.
    await db
      .from('digest_subscribers')
      .update({ alert_cursor: row!.seq })
      .in('cadence', ['daily', 'instant'])
      .lt('alert_cursor', row!.seq);
    await db.rpc('run_cleanup_digest');
    expect(await changesFor(e.id)).toHaveLength(0);
  });
});

describe('alert round cleanup', () => {
  it('removes finished rounds older than 30 days, and keeps recent ones', async () => {
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const { data } = await db
      .from('alert_rounds')
      .insert([
        { cadence: 'daily', round_date: '2001-01-01', snapshot_seq: 0, status: 'complete', started_at: old },
        // Bulk inserts send null for missing columns, so both rows say when they started.
        {
          cadence: 'daily',
          round_date: '2001-01-02',
          snapshot_seq: 0,
          status: 'complete',
          started_at: new Date().toISOString(),
        },
      ])
      .select('id,round_date');
    await db.rpc('run_cleanup_digest');
    const left = (await db.from('alert_rounds').select('round_date').in('round_date', ['2001-01-01', '2001-01-02']))
      .data!;
    expect(left).toEqual([{ round_date: '2001-01-02' }]);
    await db
      .from('alert_rounds')
      .delete()
      .in(
        'id',
        data!.map((r) => r.id),
      );
  });
});
