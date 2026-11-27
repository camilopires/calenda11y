import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../../src/lib/imports/run.ts';
import { acceptPendingChanges } from '../../src/lib/imports/upsert.ts';
import type { AdapterContext, ImportSource } from '../../src/lib/imports/types.ts';
import { service } from './helpers.ts';

const db = service();
const sources: string[] = [];

const vevent = (uid: string, title: string, start: string, extra: string[] = []) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  'DTSTAMP:20270101T000000Z',
  `DTSTART:${start}`,
  `DTEND:${start.replace(/T(\d\d)/, (_m, h) => `T${String(Number(h) + 1).padStart(2, '0')}`)}`,
  `SUMMARY:${title}`,
  'LOCATION:Online',
  ...extra,
  'END:VEVENT',
];
const calendar = (...events: string[][]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...events.flat(), 'END:VCALENDAR'].join('\r\n');

function ctxFor(bodies: string[] | (() => string)): AdapterContext {
  return {
    now: new Date(),
    env: {},
    fetchText: async () => ({
      status: 200,
      contentType: 'text/calendar',
      body: typeof bodies === 'function' ? bodies() : bodies.shift()!,
    }),
  };
}

async function makeSource(): Promise<ImportSource> {
  const { data, error } = await db
    .from('import_sources')
    .insert({
      type: 'ics',
      name: `Feed ${Date.now()}`,
      config: { url: 'https://example.org/feed.ics', default_timezone: 'UTC' },
    })
    .select('id,type,name,config,enabled')
    .single();
  if (error) throw error;
  sources.push(data.id);
  return data as ImportSource;
}

const later = () => Date.now() + 60_000;
const eventsOf = async (sourceId: string) =>
  (
    await db
      .from('events')
      .select('id,source_uid,title,status,flags,pending_changes,version,sequence')
      .eq('source_id', sourceId)
      .order('source_uid')
  ).data!;

afterAll(async () => {
  if (sources.length) {
    await db.from('events').delete().in('source_id', sources);
    await db.from('import_sources').delete().in('id', sources);
  }
});

describe('types of imported events', () => {
  it('guesses types from the title, and flags events it could not classify', async () => {
    const source = await makeSource();
    await runImport(
      source,
      later(),
      ctxFor([
        calendar(
          vevent('typed', 'Accessibility Workshop', '20270410T100000Z'),
          vevent('untyped', 'Accessibility evening', '20270411T100000Z'),
        ),
      ]),
    );
    const rows = (await db.from('events').select('source_uid,types,flags').eq('source_id', source.id)).data!;
    const by = Object.fromEntries(rows.map((r) => [r.source_uid, r]));
    expect(by.typed).toMatchObject({ types: ['workshop'] });
    expect(by.typed!.flags).not.toContain('needs_type');
    expect(by.untyped).toMatchObject({ types: [] });
    expect(by.untyped!.flags).toContain('needs_type');
  });

  it('a rename at the source never changes or proposes types', async () => {
    const source = await makeSource();
    await runImport(source, later(), ctxFor([calendar(vevent('r', 'Accessibility Workshop', '20270412T100000Z'))]));
    const second = await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('r', 'Accessibility Conference', '20270412T100000Z'))]),
    );
    expect(second).toMatchObject({ ok: true, counts: { updated: 1 } });
    const row = (await db.from('events').select('id,title,types').eq('source_id', source.id).single()).data!;
    // Still pending, so the new title is applied straight away, but the types stay as they were.
    expect(row).toMatchObject({ title: 'Accessibility Conference', types: ['workshop'] });

    // Once published, the rename is proposed for review, without any type change.
    await db.from('events').update({ status: 'approved' }).eq('id', row.id);
    const third = await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('r', 'Accessibility Training', '20270412T100000Z'))]),
    );
    expect(third).toMatchObject({ ok: true, counts: { changed: 1 } });
    const published = (await db.from('events').select('title,types,pending_changes').eq('id', row.id).single()).data!;
    expect(published.title).toBe('Accessibility Conference');
    expect(published.types).toEqual(['workshop']);
    expect(published.pending_changes).toMatchObject({ title: 'Accessibility Training' });
    expect(published.pending_changes).not.toHaveProperty('types');
  });
});

describe('topics of imported events', () => {
  it('are guessed when an event is added, and left alone after that', async () => {
    const source = await makeSource();
    await runImport(source, later(), ctxFor([calendar(vevent('t', 'WCAG audits', '20270420T100000Z'))]));
    const { data: ev } = await db.from('events').select('id,topics').eq('source_id', source.id).single();
    expect(ev!.topics).toEqual(['testing']);
    await db
      .from('events')
      .update({ topics: ['careers'] })
      .eq('id', ev!.id);
    await runImport(source, later(), ctxFor([calendar(vevent('t', 'Screen reader basics', '20270420T100000Z'))]));
    const after = (await db.from('events').select('title,topics').eq('id', ev!.id).single()).data!;
    expect(after).toEqual({ title: 'Screen reader basics', topics: ['careers'] });
  });
});

describe('imports and calls for speakers', () => {
  it('an import update never sets, changes or removes a call for speakers', async () => {
    const source = await makeSource();
    await runImport(source, later(), ctxFor([calendar(vevent('c', 'Accessibility Workshop', '20270412T100000Z'))]));
    const { data: ev } = await db.from('events').select('id').eq('source_id', source.id).single();
    await db
      .from('events')
      .update({ cfp_url: 'https://cfp.example/speak', cfp_closes_on: '2027-04-01' })
      .eq('id', ev!.id);
    const r = await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('c', 'Accessibility Workshop renamed', '20270412T100000Z'))]),
    );
    expect(r).toMatchObject({ ok: true, counts: { updated: 1 } });
    const after = (await db.from('events').select('title,cfp_url,cfp_closes_on').eq('id', ev!.id).single()).data!;
    expect(after).toEqual({
      title: 'Accessibility Workshop renamed',
      cfp_url: 'https://cfp.example/speak',
      cfp_closes_on: '2027-04-01',
    });
  });
});

describe('importing a feed', () => {
  let source: ImportSource;
  beforeAll(async () => {
    source = await makeSource();
  });

  it('adds new events as pending and records the run', async () => {
    const r = await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('a', 'Alpha', '20270310T100000Z'), vevent('b', 'Beta', '20270311T100000Z'))]),
    );
    expect(r).toMatchObject({ finished: true, ok: true, counts: { fetched: 2, created: 2 } });
    const events = await eventsOf(source.id);
    expect(events.map((e) => [e.source_uid, e.status])).toEqual([
      ['a', 'pending'],
      ['b', 'pending'],
    ]);
    const src = (
      await db.from('import_sources').select('last_success_at,last_error,last_counts').eq('id', source.id).single()
    ).data!;
    expect(src.last_success_at).not.toBeNull();
    expect(src.last_error).toBeNull();
  });

  it('running again changes nothing', async () => {
    const r = await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('a', 'Alpha', '20270310T100000Z'), vevent('b', 'Beta', '20270311T100000Z'))]),
    );
    expect(r.counts).toMatchObject({ unchanged: 2 });
    expect(await eventsOf(source.id)).toHaveLength(2);
  });

  it('updates pending events straight away', async () => {
    await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('a', 'Alpha renamed', '20270310T100000Z'), vevent('b', 'Beta', '20270311T100000Z'))]),
    );
    const a = (await eventsOf(source.id)).find((e) => e.source_uid === 'a')!;
    expect(a.title).toBe('Alpha renamed');
    expect(a.pending_changes).toBeNull();
  });

  it('holds changes to a published event for review, keeping the public version', async () => {
    const b = (await eventsOf(source.id)).find((e) => e.source_uid === 'b')!;
    await db.from('events').update({ status: 'approved' }).eq('id', b.id);
    const r = await runImport(
      source,
      later(),
      ctxFor([
        calendar(vevent('a', 'Alpha renamed', '20270310T100000Z'), vevent('b', 'Beta moved', '20270312T100000Z')),
      ]),
    );
    expect(r.counts).toMatchObject({ changed: 1 });
    const after = (await eventsOf(source.id)).find((e) => e.source_uid === 'b')!;
    expect(after.title).toBe('Beta');
    expect(after.flags).toContain('changed');
    expect(after.pending_changes).toMatchObject({ title: 'Beta moved', starts_at: '2027-03-12T10:00:00.000Z' });

    // An admin accepts them: now they're public, and calendars see a new SEQUENCE.
    expect(await acceptPendingChanges(after.id, after.version)).toBe(true);
    const accepted = (await eventsOf(source.id)).find((e) => e.source_uid === 'b')!;
    expect(accepted).toMatchObject({ title: 'Beta moved', pending_changes: null });
    expect(accepted.flags).not.toContain('changed');
    expect(accepted.sequence).toBeGreaterThan(after.sequence);
  });

  it('does not report an admin edit as a source change', async () => {
    const b = (await eventsOf(source.id)).find((e) => e.source_uid === 'b')!;
    await db.from('events').update({ title: 'Beta (edited by admin)' }).eq('id', b.id);
    const r = await runImport(
      source,
      later(),
      ctxFor([
        calendar(vevent('a', 'Alpha renamed', '20270310T100000Z'), vevent('b', 'Beta moved', '20270312T100000Z')),
      ]),
    );
    expect(r.counts).toMatchObject({ unchanged: 2 });
  });

  it('flags a published event the source cancels', async () => {
    const r = await runImport(
      source,
      later(),
      ctxFor([
        calendar(
          vevent('a', 'Alpha renamed', '20270310T100000Z'),
          vevent('b', 'Beta moved', '20270312T100000Z', ['STATUS:CANCELLED']),
        ),
      ]),
    );
    expect(r.counts).toMatchObject({ changed: 1 });
    const b = (await eventsOf(source.id)).find((e) => e.source_uid === 'b')!;
    expect(b.flags).toContain('cancel_requested');
    expect(b.status).toBe('approved');
  });

  it('flags published events that disappear, but only after a complete run', async () => {
    // A failing fetch must not make anything look missing.
    const failing: AdapterContext = {
      now: new Date(),
      env: {},
      fetchText: async () => ({ status: 500, body: '', contentType: '' }),
    };
    const failed = await runImport(source, later(), failing);
    expect(failed).toMatchObject({ finished: true, ok: false, error: 'The feed answered with HTTP 500' });
    expect((await eventsOf(source.id)).find((e) => e.source_uid === 'b')!.flags).not.toContain('missing_from_source');
    const src = (await db.from('import_sources').select('last_error').eq('id', source.id).single()).data!;
    expect(src.last_error).toBe('The feed answered with HTTP 500');

    const r = await runImport(source, later(), ctxFor([calendar(vevent('a', 'Alpha renamed', '20270310T100000Z'))]));
    expect(r.counts).toMatchObject({ missing_from_source: 1 });
    expect((await eventsOf(source.id)).find((e) => e.source_uid === 'b')!.flags).toContain('missing_from_source');
  });
});

describe('time budgets', () => {
  it('stops when the budget is used up and carries on next time', async () => {
    const source = await makeSource();
    const body = calendar(...Array.from({ length: 120 }, (_, i) => vevent(`u${i}`, `Event ${i}`, '20270401T100000Z')));
    // A deadline in the past: the run opens, fetches one page, and stops.
    const first = await runImport(
      source,
      Date.now() - 1,
      ctxFor(() => body),
    );
    expect(first.finished).toBe(false);
    let result = first;
    for (let i = 0; i < 10 && !result.finished; i++)
      result = await runImport(
        source,
        later(),
        ctxFor(() => body),
      );
    expect(result).toMatchObject({ finished: true, ok: true });
    expect(await eventsOf(source.id)).toHaveLength(120);
  });
});

describe('job leases', () => {
  it('gives a due job to only one of two ticks', async () => {
    await db.from('jobs').upsert({
      key: 'cleanup:leasetest',
      kind: 'cleanup',
      interval_seconds: 3600,
      run_after: new Date(0).toISOString(),
      lease_until: null,
    });
    const [a, b] = await Promise.all([
      db.rpc('claim_job_by_key', { p_key: 'cleanup:leasetest', p_lease_seconds: 60 }),
      db.rpc('claim_job_by_key', { p_key: 'cleanup:leasetest', p_lease_seconds: 60 }),
    ]);
    expect([a.data.length, b.data.length].sort()).toEqual([0, 1]);
    await db.from('jobs').delete().eq('key', 'cleanup:leasetest');
  });

  it('cleanup runs and reports what it removed', async () => {
    const { data, error } = await db.rpc('run_cleanup');
    expect(error).toBeNull();
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(['rate_limits', 'admin_drafts', 'submitter_emails', 'job_runs']),
    );
  });
});

describe('cancellations of events not yet published', () => {
  it('flag a pending event the source cancels', async () => {
    const source = await makeSource();
    await runImport(source, later(), ctxFor([calendar(vevent('p1', 'Pending one', '20270501T100000Z'))]));
    const r = await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('p1', 'Pending one', '20270501T100000Z', ['STATUS:CANCELLED']))]),
    );
    expect(r.counts).toMatchObject({ updated: 1 });
    const [e] = await eventsOf(source.id);
    expect(e).toMatchObject({ status: 'pending' });
    expect(e!.flags).toContain('cancel_requested');
  });
});

describe('review regressions: imports', () => {
  it('never marks events missing after a run that was cut short', async () => {
    const source = await makeSource();
    await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('t1', 'Kept', '20270601T100000Z'), vevent('t2', 'Other', '20270602T100000Z'))]),
    );
    const t2 = (await eventsOf(source.id)).find((e) => e.source_uid === 't2')!;
    await db.from('events').update({ status: 'approved' }).eq('id', t2.id);
    // A cut-short read that only saw t1.
    const truncated: AdapterContext = {
      now: new Date(),
      env: {},
      fetchText: async () => ({
        status: 200,
        contentType: 'text/calendar',
        body: calendar(vevent('t1', 'Kept', '20270601T100000Z')),
      }),
    };
    const { ADAPTERS } = await import('../../src/lib/imports/adapters.ts');
    const original = ADAPTERS.ics.fetchPage;
    ADAPTERS.ics.fetchPage = async (...args) => ({ ...(await original(...args)), truncated: true });
    try {
      const r = await runImport(source, later(), truncated);
      expect(r.counts.missing_from_source ?? 0).toBe(0);
    } finally {
      ADAPTERS.ics.fetchPage = original;
    }
    expect((await eventsOf(source.id)).find((e) => e.source_uid === 't2')!.flags).not.toContain('missing_from_source');
  });

  it('only proposes fields the source changed, keeping an admin edit to another field', async () => {
    const source = await makeSource();
    await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('e1', 'Original title', '20270701T100000Z', ['LOCATION:Room 1']))]),
    );
    const e1 = (await eventsOf(source.id))[0]!;
    await db.from('events').update({ status: 'approved' }).eq('id', e1.id);
    await db.from('events').update({ title: 'Edited by admin' }).eq('id', e1.id);
    await runImport(
      source,
      later(),
      ctxFor([calendar(vevent('e1', 'Original title', '20270702T100000Z', ['LOCATION:Room 1']))]),
    );
    const after = (await eventsOf(source.id))[0]!;
    expect(after.pending_changes).toEqual({
      starts_at: '2027-07-02T10:00:00.000Z',
      ends_at: '2027-07-02T11:00:00.000Z',
    });
    expect(after.title).toBe('Edited by admin');
  });
});
