/**
 * The digest job: for the current period, works through subscribers in id
 * order (a cursor, so it can stop and carry on), and queues one email for
 * each subscriber who has matching events. Each email's outbox key includes
 * the run and the subscriber, so a retried run never queues it twice.
 */
import { db } from '../db.ts';
import { env } from '../env.ts';
import { queued } from '../email/outbox.ts';
import { digestEmail, type CfpItem, type DigestItem } from '../email/templates.ts';
import { cfpDeadline } from '../events/cfp.ts';
import { addDays, describeWhen, formatLongDate, todayUtc } from '../events/dates.ts';
import { PUBLIC_EVENT_COLUMNS, countryName, type PublicEvent } from '../events/model.ts';
import { unwrap, unwrapMaybe } from '../result.ts';
import { manageUrl, unsubscribeHeaders, unsubscribeUrl } from './links.ts';
import { currentPeriod, describePeriod, isDue, type Cadence, type Period } from './period.ts';
import type { Subscriber } from './subscribers.ts';

const MAX_EVENTS_PER_EMAIL = 40;

interface Run {
  id: string;
  cursor: string | null;
  status: 'running' | 'complete';
  counts: Record<string, number>;
  period_start: string;
  period_end: string;
}

export interface DigestSelection {
  /** Up to MAX_EVENTS_PER_EMAIL events, in start order. */
  events: PublicEvent[];
  /** How many match in all. */
  total: number;
}

type Prefs = Pick<Subscriber, 'countries' | 'formats' | 'types'>;

interface PrefQuery<Q> {
  in(column: string, values: readonly unknown[]): Q;
  or(filters: string): Q;
  overlaps(column: string, values: readonly unknown[]): Q;
}

/** A subscriber's country, format and type choices, as conditions on public_events. */
function applyPrefs<Q extends PrefQuery<Q>>(query: Q, prefs: Prefs): Q {
  let q = query;
  if (prefs.formats.length) q = q.in('format', prefs.formats);
  if (prefs.types.length) q = q.overlaps('types', prefs.types);
  const countries = prefs.countries.filter((c) => c !== 'online');
  const online = prefs.countries.includes('online');
  if (countries.length && online) q = q.or(`country_code.in.(${countries.join(',')}),format.in.(online,hybrid)`);
  else if (countries.length) q = q.in('country_code', countries);
  else if (online) q = q.in('format', ['online', 'hybrid']);
  return q;
}

/** How many calls for speakers the "closing soon" section lists, at most. */
const MAX_CALLS_PER_EMAIL = 20;
/** Calls closing this long after the period still count as "closing soon". */
const CFP_LOOKAHEAD_DAYS = 31;

/**
 * Open calls for speakers closing between now and a month after the period,
 * soonest first. Chosen by the exact closing instant, so calls with no date
 * (they close when the event starts) and calls in time zones behind UTC are
 * included correctly.
 */
export async function cfpFor(prefs: Prefs, period: Pick<Period, 'start' | 'end'>, now: Date): Promise<PublicEvent[]> {
  const until = `${addDays(period.end, CFP_LOOKAHEAD_DAYS)}T00:00:00Z`;
  const q = db()
    .from('public_events')
    .select(PUBLIC_EVENT_COLUMNS)
    .eq('status', 'approved')
    .gt('cfp_closes_at', now.toISOString())
    .lt('cfp_closes_at', until);
  const result = await applyPrefs(q, prefs).order('cfp_closes_at').order('id').limit(MAX_CALLS_PER_EMAIL);
  return unwrap(result, 'supabase', 'selecting calls for speakers') as unknown as PublicEvent[];
}

function cfpItem(e: PublicEvent): CfpItem {
  return {
    title: e.title,
    url: e.cfp_url!,
    deadline:
      e.cfp_capped || !e.cfp_last_day ? 'Apply before the event starts' : `Apply by ${formatLongDate(e.cfp_last_day)}`,
    event: `${formatLongDate(e.local_start_date)}, ${placeOf(e)}`,
  };
}

/** Events in the period that a subscriber's choices match. */
export async function eventsFor(
  prefs: Prefs,
  period: Pick<Period, 'start' | 'end'>,
  now: Date,
): Promise<DigestSelection> {
  const today = todayUtc(now);
  const q = db()
    .from('public_events')
    .select(PUBLIC_EVENT_COLUMNS, { count: 'exact' })
    .eq('status', 'approved')
    .gt('end_instant', now.toISOString())
    .gte('local_end_date', period.start > today ? period.start : today)
    .lte('local_start_date', period.end);
  const result = await applyPrefs(q, prefs).order('start_instant').order('id').limit(MAX_EVENTS_PER_EMAIL);
  const events = unwrap(result, 'supabase', 'selecting digest events') as unknown as PublicEvent[];
  return { events, total: result.count ?? events.length };
}

/** A link to the same events on the site, as close as the list's filters allow. */
export function digestListUrl(
  prefs: Pick<Subscriber, 'countries' | 'formats' | 'types'>,
  period: Pick<Period, 'start' | 'end'>,
  today: string,
): string {
  const p = new URLSearchParams();
  const countries = prefs.countries.filter((c) => c !== 'online');
  const online = prefs.countries.includes('online');
  // The list can show one country, or online events, but not both at once.
  if (countries.length === 1 && !online) p.set('country', countries[0]!);
  else if (!countries.length && online) p.set('country', 'online');
  for (const f of prefs.formats) p.append('format', f);
  for (const t of prefs.types) p.append('type', t);
  p.set('from', period.start > today ? period.start : today);
  p.set('to', period.end);
  return new URL(`/?${p}`, env().SITE_URL).href;
}

function placeOf(e: PublicEvent): string {
  return e.format === 'online'
    ? 'Online'
    : [e.city, e.country_code ? countryName(e.country_code) : null].filter(Boolean).join(', ');
}

function item(e: PublicEvent): DigestItem {
  const w = describeWhen(e);
  return {
    title: e.title,
    url: new URL(`/events/${e.slug}`, env().SITE_URL).href,
    when: `${w.date}, ${w.time}`,
    where: placeOf(e),
    summary: e.summary,
    cfp: cfpDeadline(e),
  };
}

const RUN_COLS = 'id,cursor,status,counts,period_start,period_end';
/** Emails are queued and progress saved after this many subscribers. */
const CHECKPOINT = 25;

/** Runs the digest for a cadence: first any earlier run left unfinished, then the current period. */
export async function runDigest(
  cadence: Cadence,
  deadline: number,
  now = new Date(),
): Promise<{ finished: boolean; counts: Record<string, number> }> {
  // A run interrupted before the period changed still has people waiting for it.
  const unfinished = unwrapMaybe(
    await db()
      .from('digest_runs')
      .select(RUN_COLS)
      .eq('cadence', cadence)
      .eq('status', 'running')
      .order('period_start')
      .limit(1)
      .maybeSingle(),
    'supabase',
    'finding unfinished digest run',
  ) as Run | null;
  const period = currentPeriod(cadence, now);
  if (unfinished && unfinished.period_start < period.start) {
    const r = await processRun(cadence, unfinished, deadline, now);
    if (!r.finished) return r;
  }

  if (!isDue(period, now)) return { finished: true, counts: { not_due: 1 } };
  let run = unwrapMaybe(
    await db()
      .from('digest_runs')
      .select(RUN_COLS)
      .eq('cadence', cadence)
      .eq('period_start', period.start)
      .maybeSingle(),
    'supabase',
    'finding digest run',
  ) as Run | null;
  if (run?.status === 'complete') return { finished: true, counts: run.counts };
  if (!run) {
    const created = await db()
      .from('digest_runs')
      .insert({ cadence, period_start: period.start, period_end: period.end })
      .select(RUN_COLS)
      .single();
    if (created.error?.code === '23505') return runDigest(cadence, deadline, now);
    run = unwrap(created, 'supabase', 'starting digest run') as Run;
  }
  return processRun(cadence, run, deadline, now);
}

async function processRun(
  cadence: Cadence,
  run: Run,
  deadline: number,
  now: Date,
): Promise<{ finished: boolean; counts: Record<string, number> }> {
  const counts = { ...run.counts };
  const period = { start: run.period_start, end: run.period_end };
  const heading = `Accessibility events: ${describePeriod({ cadence, ...period })}`;
  const today = todayUtc(now);
  const cache = new Map<string, DigestSelection>();
  const cfpCache = new Map<string, PublicEvent[]>();
  let cursor = run.cursor;

  while (Date.now() < deadline) {
    let q = db()
      .from('digest_subscribers')
      .select('id,email,cadence,countries,formats,types,include_cfp,confirmed_at,suppressed_at,token_version')
      .eq('cadence', cadence)
      .not('confirmed_at', 'is', null)
      .is('suppressed_at', null)
      .order('id')
      .limit(CHECKPOINT);
    if (cursor) q = q.gt('id', cursor);
    const subs = unwrap(await q, 'supabase', 'listing subscribers') as Subscriber[];
    if (!subs.length) {
      unwrap(
        await db()
          .from('digest_runs')
          .update({ status: 'complete', cursor, counts, finished_at: new Date().toISOString() })
          .eq('id', run.id)
          .select('id'),
        'supabase',
        'finishing digest run',
      );
      return { finished: true, counts };
    }
    const emails = [];
    let last = cursor;
    for (const s of subs) {
      // Check the time between subscribers, so a slow batch can't run past the budget.
      if (Date.now() >= deadline) break;
      const key = JSON.stringify([s.countries.slice().sort(), s.formats.slice().sort(), s.types.slice().sort()]);
      if (!cache.has(key)) cache.set(key, await eventsFor(s, period, now));
      const { events, total } = cache.get(key)!;
      if (s.include_cfp && !cfpCache.has(key)) cfpCache.set(key, await cfpFor(s, period, now));
      const calls = s.include_cfp ? cfpCache.get(key)! : [];
      last = s.id;
      if (!events.length && !calls.length) {
        counts.nothing_to_send = (counts.nothing_to_send ?? 0) + 1;
        continue;
      }
      emails.push(
        queued(
          'digest',
          `digest:${run.id}:${s.id}`,
          s.email,
          digestEmail(
            heading,
            events.map(item),
            manageUrl(s.id, s.token_version),
            unsubscribeUrl(s.id, s.token_version),
            {
              total,
              listUrl: digestListUrl(s, period, today),
              cfp: calls.map(cfpItem),
            },
          ),
          unsubscribeHeaders(s.id, s.token_version),
        ),
      );
    }
    if (emails.length) {
      unwrap(await db().rpc('enqueue_emails', { p_emails: emails }), 'supabase', 'queueing digests');
      counts.queued = (counts.queued ?? 0) + emails.length;
    }
    if (last !== cursor) {
      cursor = last;
      unwrap(
        await db().from('digest_runs').update({ cursor, counts }).eq('id', run.id).select('id'),
        'supabase',
        'saving digest progress',
      );
    }
  }
  return { finished: false, counts };
}
