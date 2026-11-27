/**
 * Sending alerts about new and changed events.
 *
 * Each send is a "round" up to a fixed point in the change log (the
 * snapshot). Subscribers are worked through furthest-behind first; for each
 * one, the changes between their cursor and the snapshot are read (in
 * pages), matched to their choices, and queue_alert moves their cursor and
 * queues the email together. If time runs out, the next run continues the
 * same round, so nobody is skipped or emailed twice in one round.
 *
 * Daily rounds happen once per UTC day, from 08:00. Instant rounds start
 * whenever the previous one has finished (each tick, about every 10
 * minutes), so each person gets at most one email per round.
 */
import { db } from '../db.ts';
import { env } from '../env.ts';
import { queued, sendNow } from '../email/outbox.ts';
import { alertEmail, type AlertItem } from '../email/templates.ts';
import { describeWhen, todayUtc } from '../events/dates.ts';
import { PUBLIC_EVENT_COLUMNS, TOPIC_SLUGS, countryName, type PublicEvent } from '../events/model.ts';
import { ServiceError, unwrap, unwrapMaybe } from '../result.ts';
import { manageUrl, unsubscribeHeaders, unsubscribeUrl } from '../digest/links.ts';
import { SEND_HOUR_UTC } from '../digest/period.ts';
import { PREF_COLS, rowToPrefs, type Subscriber } from '../digest/subscribers.ts';
import { appendNear } from '../digest/send.ts';
import { asOfLastChange, mergeChanges, reasonLines, type ChangeRow } from './changes.ts';
import { cannotJudgeYet, wantsChange } from './match.ts';

export type AlertCadence = 'daily' | 'instant';

/** Changes are read this many at a time, below the API's 1,000-row limit. */
const CHANGE_PAGE = 500;
/** Events are looked up this many ids at a time (more makes the request address too long). */
const EVENT_CHUNK = 80;
/** An email lists at most this many events, then links to the rest. */
const MAX_ITEMS = 100;
const SUBSCRIBER_PAGE = 25;

interface Round {
  id: string;
  snapshot_seq: number;
  counts: Record<string, number>;
}

type AlertSubscriber = Pick<
  Subscriber,
  'id' | 'email' | 'countries' | 'formats' | 'types' | 'topics' | 'include_cfp' | 'near' | 'token_version'
> & { alert_cursor: number; prefs_revision: number };

const SUB_COLS = `id,email,${PREF_COLS},token_version,alert_cursor,prefs_revision`;

/** Finds the round to work on, starting one if it's time. Null when there's nothing to do yet. */
async function currentRound(cadence: AlertCadence, maxSeq: number, now: Date): Promise<Round | null> {
  const running = unwrapMaybe(
    await db()
      .from('alert_rounds')
      .select('id,snapshot_seq,counts')
      .eq('cadence', cadence)
      .eq('status', 'running')
      .maybeSingle(),
    'supabase',
    'finding the alert round',
  ) as Round | null;
  if (running) return running;

  const today = todayUtc(now);
  if (cadence === 'daily') {
    if (now.getUTCHours() < SEND_HOUR_UTC) return null;
    const done = unwrap(
      await db().from('alert_rounds').select('id').eq('cadence', 'daily').eq('round_date', today),
      'supabase',
      "checking today's alerts",
    ) as unknown[];
    if (done.length) return null;
  }
  const { data, error } = await db()
    .from('alert_rounds')
    .insert({ cadence, round_date: cadence === 'daily' ? today : null, snapshot_seq: maxSeq })
    .select('id,snapshot_seq,counts')
    .single();
  // Another run started it at the same moment: use theirs.
  if (error?.code === '23505') return currentRound(cadence, maxSeq, now);
  if (error || !data) throw new ServiceError('supabase', `starting alert round: ${error?.message ?? 'no data'}`);
  return data as Round;
}

/** All changes after `from`, up to the snapshot, in order, read page by page. */
async function changesBetween(from: number, to: number): Promise<ChangeRow[]> {
  const out: ChangeRow[] = [];
  let after = from;
  for (;;) {
    const rows = unwrap(
      await db()
        .from('event_changes')
        .select('seq,event_id,kind,what,before_status,after')
        .gt('seq', after)
        .lte('seq', to)
        .order('seq')
        .limit(CHANGE_PAGE),
      'supabase',
      'reading changes',
    ) as ChangeRow[];
    out.push(...rows);
    if (rows.length < CHANGE_PAGE) return out;
    after = rows[rows.length - 1]!.seq;
  }
}

/** Public events by id, looked up in chunks. Unpublished events aren't returned. */
async function eventsById(ids: string[]): Promise<Map<string, PublicEvent>> {
  const out = new Map<string, PublicEvent>();
  for (let i = 0; i < ids.length; i += EVENT_CHUNK) {
    const rows = unwrap(
      await db()
        .from('public_events')
        .select(PUBLIC_EVENT_COLUMNS)
        .in('id', ids.slice(i, i + EVENT_CHUNK)),
      'supabase',
      'reading changed events',
    ) as unknown as PublicEvent[];
    for (const e of rows) out.set(e.id, e);
  }
  return out;
}

function itemFor(e: PublicEvent, reasons: string[]): AlertItem {
  const w = describeWhen(e);
  return {
    title: e.title,
    url: new URL(`/events/${e.slug}`, env().SITE_URL).href,
    when: `${w.date}, ${w.time}`,
    where:
      e.format === 'online'
        ? 'Online'
        : [e.city, e.country_code ? countryName(e.country_code) : null].filter(Boolean).join(', '),
    summary: e.summary,
    reasons,
  };
}

/** The event list on the site with the same choices, for "see everything". */
function listUrl(s: AlertSubscriber): string {
  const p = new URLSearchParams();
  const countries = s.countries.filter((c) => c !== 'online');
  if (countries.length === 1 && !s.countries.includes('online')) p.set('country', countries[0]!);
  else if (!countries.length && s.countries.includes('online')) p.set('country', 'online');
  for (const f of s.formats) p.append('format', f);
  for (const t of s.types) p.append('type', t);
  for (const t of s.topics) p.append('topic', TOPIC_SLUGS[t]);
  appendNear(p, s.near);
  return new URL(p.size ? `/?${p}` : '/', env().SITE_URL).href;
}

interface Batch {
  rows: ChangeRow[];
  byEvent: Map<string, ChangeRow[]>;
  events: Map<string, PublicEvent>;
}

export interface AlertRunOptions {
  /** For tests: stop after this many subscribers, as if time ran out. */
  maxSubscribers?: number;
  /** For tests: runs just before a subscriber's alert is queued. */
  beforeQueue?: (subscriberId: string) => Promise<void>;
}

export async function runAlerts(
  cadence: AlertCadence,
  deadline: number,
  now: Date = new Date(),
  options: AlertRunOptions = {},
): Promise<{ finished: boolean; counts: Record<string, number> }> {
  const maxSeq = unwrap(await db().rpc('sequence_changes'), 'supabase', 'numbering changes') as number;
  const round = await currentRound(cadence, maxSeq, now);
  if (!round) return { finished: true, counts: { not_due: 1 } };

  const counts = { ...round.counts };
  const batches = new Map<number, Batch>();
  // Someone whose details changed while we worked is skipped until the next run, not retried forever.
  const refused = new Set<string>();
  // People with a place whose alerts wait for a position; they're done for this round.
  const held = new Set<string>();
  let handled = 0;
  let queuedCount = 0;

  for (;;) {
    const q = db()
      .from('digest_subscribers')
      .select(SUB_COLS)
      .eq('cadence', cadence)
      .not('confirmed_at', 'is', null)
      .is('suppressed_at', null)
      .lt('alert_cursor', round.snapshot_seq)
      .order('alert_cursor')
      .order('id')
      .limit(SUBSCRIBER_PAGE + refused.size + held.size);
    const page = (unwrap(await q, 'supabase', 'listing alert subscribers') as unknown as Array<Record<string, unknown>>)
      .map((r) => rowToPrefs(r as never) as unknown as AlertSubscriber)
      .filter((s) => !refused.has(s.id) && !held.has(s.id));
    if (!page.length && refused.size) {
      // Only people whose details changed while we worked are left: keep the
      // round open so the next run tries them again with their new details.
      unwrap(
        await db().from('alert_rounds').update({ counts }).eq('id', round.id).select('id'),
        'supabase',
        'saving alert progress',
      );
      if (queuedCount) await sendNow(`alert:${cadence}:${round.snapshot_seq}:`);
      return { finished: true, counts };
    }
    if (!page.length) {
      unwrap(
        await db()
          .from('alert_rounds')
          .update({ status: 'complete', counts, finished_at: new Date().toISOString() })
          .eq('id', round.id)
          .select('id'),
        'supabase',
        'finishing alert round',
      );
      if (queuedCount) await sendNow(`alert:${cadence}:${round.snapshot_seq}:`);
      return { finished: true, counts };
    }

    for (const s of page) {
      if (Date.now() >= deadline || (options.maxSubscribers !== undefined && handled >= options.maxSubscribers)) {
        unwrap(
          await db().from('alert_rounds').update({ counts }).eq('id', round.id).select('id'),
          'supabase',
          'saving alert progress',
        );
        if (queuedCount) await sendNow(`alert:${cadence}:${round.snapshot_seq}:`);
        return { finished: false, counts };
      }
      handled++;
      let batch = batches.get(s.alert_cursor);
      if (!batch) {
        const rows = await changesBetween(s.alert_cursor, round.snapshot_seq);
        const byEvent = new Map<string, ChangeRow[]>();
        for (const r of rows) byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r]);
        batch = { rows, byEvent, events: await eventsById([...byEvent.keys()]) };
        batches.set(s.alert_cursor, batch);
      }
      // Someone with a place waits just before any event that can't be judged yet.
      let upTo = round.snapshot_seq;
      if (s.near) {
        for (const [eventId, rows] of batch.byEvent) {
          const current = batch.events.get(eventId);
          if (current && cannotJudgeYet(current, asOfLastChange(current, rows))) {
            upTo = Math.min(upTo, Math.min(...rows.map((r) => r.seq)) - 1);
          }
        }
      }
      const rows = upTo === round.snapshot_seq ? batch.rows : batch.rows.filter((r) => r.seq <= upTo);
      const added: AlertItem[] = [];
      const updated: AlertItem[] = [];
      for (const [eventId, m] of mergeChanges(rows)) {
        const current = batch.events.get(eventId);
        // Not public any more: nothing to tell.
        if (!current) continue;
        const e = asOfLastChange(
          current,
          rows.filter((r) => r.event_id === eventId),
        );
        if (!wantsChange(e, m, s, now)) continue;
        (m.isNew ? added : updated).push(itemFor(e, reasonLines(e, m)));
      }
      if (upTo < round.snapshot_seq) {
        held.add(s.id);
        counts.waiting_for_positions = (counts.waiting_for_positions ?? 0) + 1;
        // Nothing earlier to send, and the cursor can't move: leave them for the next round.
        if (upTo <= s.alert_cursor) continue;
      }
      const total = added.length + updated.length;
      const shownAdded = added.slice(0, MAX_ITEMS);
      const shownUpdated = updated.slice(0, MAX_ITEMS - shownAdded.length);
      const email = total
        ? queued(
            'alert',
            `alert:${cadence}:${round.snapshot_seq}:${s.id}`,
            s.email,
            alertEmail(
              shownAdded,
              shownUpdated,
              manageUrl(s.id, s.token_version),
              unsubscribeUrl(s.id, s.token_version),
              {
                total,
                listUrl: listUrl(s),
              },
            ),
            unsubscribeHeaders(s.id, s.token_version),
          )
        : null;
      await options.beforeQueue?.(s.id);
      const ok = unwrap(
        await db().rpc('queue_alert', {
          p_subscriber: s.id,
          p_cadence: cadence,
          p_revision: s.prefs_revision,
          p_from: s.alert_cursor,
          p_to: upTo,
          p_email: email,
        }),
        'supabase',
        'queueing alert',
      ) as boolean;
      if (!ok) {
        refused.add(s.id);
        counts.changed_meanwhile = (counts.changed_meanwhile ?? 0) + 1;
      } else if (email) {
        queuedCount++;
        counts.queued = (counts.queued ?? 0) + 1;
      } else counts.nothing_to_send = (counts.nothing_to_send ?? 0) + 1;
    }
  }
}
