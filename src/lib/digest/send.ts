/**
 * The digest job: for the current period, works through subscribers in id
 * order (a cursor, so it can stop and carry on), and queues one email for
 * each subscriber who has matching events. Each email's outbox key includes
 * the run and the subscriber, so a retried run never queues it twice.
 */
import { db } from '../db.ts';
import { env } from '../env.ts';
import { queued } from '../email/outbox.ts';
import { digestEmail, type DigestItem } from '../email/templates.ts';
import { describeWhen, todayUtc } from '../events/dates.ts';
import { PUBLIC_EVENT_COLUMNS, countryName, type PublicEvent } from '../events/model.ts';
import { unwrap, unwrapMaybe } from '../result.ts';
import { manageUrl, unsubscribeHeaders, unsubscribeUrl } from './links.ts';
import { currentPeriod, describePeriod, isDue, type Cadence, type Period } from './period.ts';
import type { Subscriber } from './subscribers.ts';

const BATCH = 200;
const MAX_EVENTS_PER_EMAIL = 40;

interface Run {
  id: string;
  cursor: string | null;
  status: 'running' | 'complete';
  counts: Record<string, number>;
  period_start: string;
  period_end: string;
}

/** Events in the period that a subscriber's choices match. */
export async function eventsFor(
  prefs: Pick<Subscriber, 'countries' | 'formats'>,
  period: Pick<Period, 'start' | 'end'>,
  now: Date,
): Promise<PublicEvent[]> {
  const today = todayUtc(now);
  let q = db()
    .from('public_events')
    .select(PUBLIC_EVENT_COLUMNS)
    .eq('status', 'approved')
    .gt('end_instant', now.toISOString())
    .gte('local_end_date', period.start > today ? period.start : today)
    .lte('local_start_date', period.end);
  if (prefs.formats.length) q = q.in('format', prefs.formats);
  const countries = prefs.countries.filter((c) => c !== 'online');
  const online = prefs.countries.includes('online');
  if (countries.length && online) q = q.or(`country_code.in.(${countries.join(',')}),format.in.(online,hybrid)`);
  else if (countries.length) q = q.in('country_code', countries);
  else if (online) q = q.in('format', ['online', 'hybrid']);
  return unwrap(
    await q.order('start_instant').order('id').limit(MAX_EVENTS_PER_EMAIL),
    'supabase',
    'selecting digest events',
  ) as unknown as PublicEvent[];
}

function item(e: PublicEvent): DigestItem {
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
  };
}

export async function runDigest(
  cadence: Cadence,
  deadline: number,
  now = new Date(),
): Promise<{ finished: boolean; counts: Record<string, number> }> {
  const period = currentPeriod(cadence, now);
  if (!isDue(period, now)) return { finished: true, counts: { not_due: 1 } };

  let run = unwrapMaybe(
    await db()
      .from('digest_runs')
      .select('id,cursor,status,counts,period_start,period_end')
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
      .select('id,cursor,status,counts,period_start,period_end')
      .single();
    if (created.error?.code === '23505') return runDigest(cadence, deadline, now);
    run = unwrap(created, 'supabase', 'starting digest run') as Run;
  }

  const counts = { ...run.counts };
  const heading = `Accessibility events: ${describePeriod({ cadence, start: run.period_start, end: run.period_end })}`;
  let cursor = run.cursor;
  while (Date.now() < deadline) {
    let q = db()
      .from('digest_subscribers')
      .select('id,email,cadence,countries,formats,confirmed_at,suppressed_at,token_version')
      .eq('cadence', cadence)
      .not('confirmed_at', 'is', null)
      .is('suppressed_at', null)
      .order('id')
      .limit(BATCH);
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
    const cache = new Map<string, PublicEvent[]>();
    const emails = [];
    for (const s of subs) {
      const key = JSON.stringify([s.countries.slice().sort(), s.formats.slice().sort()]);
      if (!cache.has(key)) cache.set(key, await eventsFor(s, { start: run.period_start, end: run.period_end }, now));
      const events = cache.get(key)!;
      if (!events.length) {
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
          ),
          unsubscribeHeaders(s.id, s.token_version),
        ),
      );
    }
    if (emails.length) {
      unwrap(await db().rpc('enqueue_emails', { p_emails: emails }), 'supabase', 'queueing digests');
      counts.queued = (counts.queued ?? 0) + emails.length;
    }
    cursor = subs.at(-1)!.id;
    unwrap(
      await db().from('digest_runs').update({ cursor, counts }).eq('id', run.id).select('id'),
      'supabase',
      'saving digest progress',
    );
  }
  return { finished: false, counts };
}
