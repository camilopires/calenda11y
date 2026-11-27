/**
 * Audit fixes: digests can't be queued for someone who has just left, copies
 * of subscription emails go when the address does, old outbox rows and used
 * form codes are kept for exactly as long as they should be.
 */
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { service } from './helpers.ts';

const db = service();
const tag = `privacy${Date.now()}`;
const addr = (name: string) => `${name}-${tag}@example.test`;

afterAll(async () => {
  await db.from('email_outbox').delete().like('to_email', `%${tag}@example.test`);
  await db.from('digest_subscribers').delete().like('email', `%${tag}@example.test`);
});

async function subscriber(name: string, fields: Record<string, unknown> = {}) {
  const { data, error } = await db
    .from('digest_subscribers')
    .insert({ email: addr(name), cadence: 'weekly', confirmed_at: new Date().toISOString(), ...fields })
    .select('id,email,prefs_revision')
    .single();
  if (error) throw error;
  return data as { id: string; email: string; prefs_revision: number };
}

const mail = (kind: string, to: string, key = `${kind}:${to}:${Math.random()}`) => ({
  kind,
  dedupe_key: key,
  to_email: to,
  subject: 'S',
  html: '<p>x</p>',
  text_body: 'x',
});

const digestFor = (s: { id: string; email: string; prefs_revision: number }, cadence = 'weekly') => ({
  subscriber: s.id,
  cadence,
  revision: s.prefs_revision,
  email: mail('digest', s.email, `digest:${tag}:${s.id}`),
});

const rowsTo = async (to: string) =>
  ((await db.from('email_outbox').select('id,kind,status,cancelled_at').eq('to_email', to)).data ?? []) as Array<{
    id: string;
    kind: string;
    status: string;
    cancelled_at: string | null;
  }>;

/**
 * An open transaction in the local database, so a test can hold a row lock
 * while another request runs. Uses psql inside the Supabase container.
 */
function heldTransaction() {
  const psql = spawn(
    'docker',
    ['exec', '-i', 'supabase_db_calenda11y', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let out = '';
  psql.stdout.on('data', (d) => (out += String(d)));
  psql.stderr.on('data', (d) => (out += String(d)));
  const done = new Promise<string>((resolve) => psql.on('close', () => resolve(out)));
  return {
    run: (sql: string) => psql.stdin.write(`${sql}\n`),
    output: () => out,
    commit: async () => {
      psql.stdin.end('commit;\n');
      return done;
    },
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('queue_digests', () => {
  it('queues for a confirmed, current subscriber, once', async () => {
    const s = await subscriber('ok');
    const first = await db.rpc('queue_digests', { p_items: [digestFor(s)] });
    expect(first.error).toBeNull();
    expect(first.data).toBe(1);
    expect((await db.rpc('queue_digests', { p_items: [digestFor(s)] })).data).toBe(0);
    expect(await rowsTo(s.email)).toHaveLength(1);
  });

  it('refuses a subscriber who left, is suppressed, unconfirmed, or changed cadence or choices', async () => {
    const gone = await subscriber('gone');
    await db.from('digest_subscribers').delete().eq('id', gone.id);
    const bounced = await subscriber('bounced', { suppressed_at: new Date().toISOString() });
    const unconfirmed = await subscriber('unconfirmed', { confirmed_at: null });
    const monthly = await subscriber('monthly', { cadence: 'monthly' });
    const changed = await subscriber('changed');
    await db
      .from('digest_subscribers')
      .update({ countries: ['PT'] })
      .eq('id', changed.id);
    const { data, error } = await db.rpc('queue_digests', {
      p_items: [digestFor(gone), digestFor(bounced), digestFor(unconfirmed), digestFor(monthly), digestFor(changed)],
    });
    expect(error).toBeNull();
    expect(data).toBe(0);
    for (const s of [gone, bounced, unconfirmed, monthly, changed]) expect(await rowsTo(s.email)).toEqual([]);
  });

  it('waits for an unsubscribe in progress, then sees the subscriber is gone', async () => {
    const s = await subscriber('leaving');
    const tx = heldTransaction();
    tx.run(`begin; select public.unsubscribe_subscriber('${s.id}');`);
    await settle(500);
    // .then() sends it now: the builder otherwise waits until awaited.
    const queuing = db.rpc('queue_digests', { p_items: [digestFor(s)] }).then((r) => r);
    await settle(500);
    await tx.commit();
    const { data, error } = await queuing;
    expect(error).toBeNull();
    expect(data).toBe(0);
    expect(await rowsTo(s.email)).toEqual([]);
  });

  it('makes an unsubscribe wait for a digest being queued, then removes that digest', async () => {
    const s = await subscriber('mid-run');
    const tx = heldTransaction();
    tx.run(`begin; select public.queue_digests('${JSON.stringify([digestFor(s)]).replace(/'/g, "''")}'::jsonb);`);
    await settle(500);
    const leaving = db.rpc('unsubscribe_subscriber', { p_id: s.id }).then((r) => r);
    await settle(500);
    const log = await tx.commit();
    expect(log).not.toMatch(/ERROR/);
    expect((await leaving).error).toBeNull();
    expect(await rowsTo(s.email)).toEqual([]);
  });

  it('is what the digest run uses', async () => {
    const { runDigest } = await import('../../src/lib/digest/send.ts');
    const { db: appDb } = await import('../../src/lib/db.ts');
    const client = appDb();
    const rpc = vi.spyOn(client, 'rpc');
    await db.from('digest_runs').delete().eq('period_start', '2032-03-01');
    await db.from('events').insert({
      slug: `${tag}-ev`,
      title: `${tag} event`,
      summary: 'x',
      timezone: 'UTC',
      format: 'online',
      starts_at: '2032-03-03T15:00:00Z',
      ends_at: '2032-03-03T16:00:00Z',
      status: 'approved',
    });
    const s = await subscriber('runner');
    try {
      const r = await runDigest('weekly', Date.now() + 30_000, new Date('2032-03-01T09:00:00Z'));
      const names = rpc.mock.calls.map((c) => c[0]);
      expect(names).toContain('queue_digests');
      expect(names).not.toContain('enqueue_emails');
      // The count is what was actually queued.
      const queued = (await db.from('email_outbox').select('id').like('dedupe_key', 'digest:%').eq('to_email', s.email))
        .data!;
      expect(queued).toHaveLength(1);
      expect(r.counts.queued).toBeGreaterThanOrEqual(1);
    } finally {
      rpc.mockRestore();
      await db.from('events').delete().eq('slug', `${tag}-ev`);
      await db.from('digest_runs').delete().eq('period_start', '2032-03-01');
    }
  });
});

describe('unsubscribing and bounces remove copies of subscription emails', () => {
  async function withMail(name: string) {
    const s = await subscriber(name);
    const ids: Record<string, string> = {};
    for (const [kind, status] of [
      ['digest', 'queued'],
      ['alert', 'sent'],
      ['subscribe_confirm', 'failed'],
      ['subscribe_manage', 'unknown'],
      ['digest', 'sending'],
    ] as const) {
      const { data } = await db.rpc('enqueue_emails', { p_emails: [mail(kind, s.email)] });
      const id = (data as string[])[0]!;
      await db
        .from('email_outbox')
        .update({ status, lease_until: status === 'sending' ? new Date(Date.now() + 60_000).toISOString() : null })
        .eq('id', id);
      ids[`${kind}:${status}`] = id;
    }
    // Not a subscription email: left alone.
    const other = (await db.rpc('enqueue_emails', { p_emails: [mail('submission_received', s.email)] }))
      .data as string[];
    return { s, ids, other: other[0]! };
  }

  it('unsubscribe deletes them and cancels one being sent', async () => {
    const { unsubscribe } = await import('../../src/lib/digest/subscribers.ts');
    const { s, ids, other } = await withMail('unsub');
    await unsubscribe(s);
    const left = await rowsTo(s.email);
    expect(left.map((r) => r.id).sort()).toEqual([ids['digest:sending'], other].sort());
    expect(left.find((r) => r.id === ids['digest:sending'])!.cancelled_at).not.toBeNull();
    expect((await db.from('digest_subscribers').select('id').eq('id', s.id)).data).toEqual([]);
  });

  it('a cancelled email that fails for now is deleted, not retried', async () => {
    const { unsubscribe } = await import('../../src/lib/digest/subscribers.ts');
    const { s, ids } = await withMail('retry');
    await unsubscribe(s);
    // What the sender does after a temporary failure.
    await db.from('email_outbox').update({ status: 'queued' }).eq('id', ids['digest:sending']!);
    expect((await rowsTo(s.email)).map((r) => r.id)).not.toContain(ids['digest:sending']);
  });

  it('a cancelled email whose lease runs out is not claimed again', async () => {
    const { unsubscribe } = await import('../../src/lib/digest/subscribers.ts');
    const { s, ids } = await withMail('lease');
    await unsubscribe(s);
    await db
      .from('email_outbox')
      .update({ lease_until: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', ids['digest:sending']!);
    const { data } = await db.rpc('claim_outbox', { p_limit: 10, p_lease_seconds: 60, p_ids: [ids['digest:sending']] });
    expect(data).toEqual([]);
  });

  it('a bounce suppresses the address and removes the same copies', async () => {
    const { s, ids, other } = await withMail('bounce');
    const { error } = await db.rpc('suppress_address', { p_email: s.email, p_reason: 'bounced' });
    expect(error).toBeNull();
    const left = await rowsTo(s.email);
    expect(left.map((r) => r.id).sort()).toEqual([ids['digest:sending'], other].sort());
    const { data } = await db.from('digest_subscribers').select('suppressed_reason').eq('id', s.id).single();
    expect(data!.suppressed_reason).toBe('bounced');
  });

  it('sign-up emails are not queued for an address that has left or bounced', async () => {
    const gone = await subscriber('signup-gone');
    await db.from('digest_subscribers').delete().eq('id', gone.id);
    const bounced = await subscriber('signup-bounced', { suppressed_at: new Date().toISOString() });
    for (const s of [gone, bounced]) {
      const { data, error } = await db.rpc('queue_subscriber_email', {
        p_subscriber: s.id,
        p_email: mail('subscribe_manage', s.email),
      });
      expect(error).toBeNull();
      expect(data).toBe(false);
      expect(await rowsTo(s.email)).toEqual([]);
    }
    const ok = await subscriber('signup-ok', { confirmed_at: null });
    expect(
      (await db.rpc('queue_subscriber_email', { p_subscriber: ok.id, p_email: mail('subscribe_confirm', ok.email) }))
        .data,
    ).toBe(true);
  });
});

describe('cleanup', () => {
  it('deletes finished outbox rows after 90 days, whatever happened to them', async () => {
    const to = addr('old');
    const ids = (
      await db.rpc('enqueue_emails', {
        p_emails: [mail('submission_received', to), mail('submission_received', to), mail('submission_received', to)],
      })
    ).data as string[];
    const day = 86_400_000;
    await db
      .from('email_outbox')
      .update({ status: 'failed', updated_at: new Date(Date.now() - 91 * day).toISOString() })
      .eq('id', ids[0]!);
    await db
      .from('email_outbox')
      .update({ status: 'failed', updated_at: new Date(Date.now() - 10 * day).toISOString() })
      .eq('id', ids[1]!);
    await db
      .from('email_outbox')
      .update({ status: 'queued', updated_at: new Date(Date.now() - 91 * day).toISOString() })
      .eq('id', ids[2]!);
    expect((await db.rpc('run_cleanup')).error).toBeNull();
    expect((await rowsTo(to)).map((r) => r.id).sort()).toEqual([ids[1], ids[2]].sort());
  });

  it('deletes a cancelled email left in sending once its lease has run out', async () => {
    const to = addr('stuck');
    const [id] = (await db.rpc('enqueue_emails', { p_emails: [mail('digest', to)] })).data as string[];
    await db
      .from('email_outbox')
      .update({
        status: 'sending',
        lease_until: new Date(Date.now() - 60_000).toISOString(),
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', id!);
    await db.rpc('run_cleanup');
    expect(await rowsTo(to)).toEqual([]);
  });

  it("removes an unconfirmed subscriber's emails with them", async () => {
    const s = await subscriber('never', {
      confirmed_at: null,
      created_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });
    await db.rpc('enqueue_emails', { p_emails: [mail('subscribe_confirm', s.email)] });
    expect((await db.rpc('run_cleanup_digest')).error).toBeNull();
    expect((await db.from('digest_subscribers').select('id').eq('id', s.id)).data).toEqual([]);
    expect(await rowsTo(s.email)).toEqual([]);
  });

  it('keeps used form codes, so an old signed form is still refused', async () => {
    const nonce = `${tag}-old-nonce`;
    await db
      .from('submission_nonces')
      .insert({ nonce, purpose: 'report', used_at: new Date(Date.now() - 2 * 365 * 86_400_000).toISOString() });
    await db.rpc('run_cleanup');
    expect((await db.from('submission_nonces').select('nonce').eq('nonce', nonce)).data).toHaveLength(1);
    const replay = await db.rpc('create_report', { p_report: {}, p_nonce: nonce, p_emails: [] });
    expect(replay.error?.message).toBe('already_submitted');
    await db.from('submission_nonces').delete().eq('nonce', nonce);
  });
});
