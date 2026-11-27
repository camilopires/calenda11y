/**
 * Problems shown in a banner on every admin page, so failures never go
 * unnoticed. Each check reports what's wrong and where to fix it.
 */
import { db } from '../db.ts';
import { currentPeriod } from '../digest/period.ts';
import { ServiceError } from '../result.ts';

export interface Problem {
  message: string;
  href: string;
  linkText: string;
}

type Check = () => Promise<Problem | null>;

export type CountQuery = ReturnType<ReturnType<ReturnType<typeof db>['from']>['select']>;

/** Counts rows in a table that match `apply`. Exported for checks added by other modules. */
export async function count(table: string, apply: (q: CountQuery) => CountQuery): Promise<number> {
  const r = await apply(db().from(table).select('*', { count: 'exact', head: true }));
  if (r.error) throw new ServiceError('supabase', `health check on ${table}: ${r.error.message}`);
  return r.count ?? 0;
}

const HOUR = 3600_000;

/** A digest that should have gone out more than 4 hours ago but hasn't finished. */
function missedDigest(cadence: 'weekly' | 'monthly'): Check {
  return async () => {
    const p = currentPeriod(cadence, new Date());
    if (Date.now() < p.sendAfter.getTime() + 4 * HOUR) return null;
    const subscribers = await count('digest_subscribers', (q) =>
      q.eq('cadence', cadence).not('confirmed_at', 'is', null).is('suppressed_at', null),
    );
    if (!subscribers) return null;
    const done = await count('digest_runs', (q) =>
      q.eq('cadence', cadence).eq('period_start', p.start).eq('status', 'complete'),
    );
    return done
      ? null
      : {
          message: `This ${cadence === 'weekly' ? 'week' : 'month'}'s ${cadence} email has not been sent yet.`,
          href: '/admin/subscribers',
          linkText: 'See email digests',
        };
  };
}

/** Today's daily alerts should have finished by 10:00 UTC; an instant round shouldn't run for over an hour. */
async function stuckAlerts(): Promise<Problem | null> {
  const subscribers = async (cadence: 'daily' | 'instant') =>
    count('digest_subscribers', (q) =>
      q.eq('cadence', cadence).not('confirmed_at', 'is', null).is('suppressed_at', null),
    );
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= 10 && (await subscribers('daily'))) {
    const done = await count('alert_rounds', (q) =>
      q.eq('cadence', 'daily').eq('round_date', today).eq('status', 'complete'),
    );
    if (!done)
      return {
        message: "Today's daily alert emails have not been sent yet.",
        href: '/admin/subscribers',
        linkText: 'See emails',
      };
  }
  if (await subscribers('instant')) {
    const stuck = await count('alert_rounds', (q) =>
      q
        .eq('cadence', 'instant')
        .eq('status', 'running')
        .lt('started_at', new Date(Date.now() - HOUR).toISOString()),
    );
    if (stuck)
      return {
        message: 'Alert emails sent as events change have been stuck for over an hour.',
        href: '/admin/jobs',
        linkText: 'See scheduled jobs',
      };
  }
  return null;
}

const checks: Check[] = [
  missedDigest('weekly'),
  missedDigest('monthly'),
  stuckAlerts,
  async () => {
    const n = await count('import_sources', (q) => q.eq('enabled', true).not('last_error', 'is', null));
    return n
      ? {
          message: `${n} import ${n === 1 ? 'source' : 'sources'} failed the last time ${n === 1 ? 'it' : 'they'} ran.`,
          href: '/admin/sources',
          linkText: 'See import sources',
        }
      : null;
  },
  async () => {
    const n = await count('import_sources', (q) => q.eq('enabled', true).neq('credentials_status', 'ok'));
    return n
      ? {
          message: `${n} import ${n === 1 ? 'source needs' : 'sources need'} new or missing credentials.`,
          href: '/admin/sources',
          linkText: 'See import sources',
        }
      : null;
  },
  async () => {
    // A source that hasn't worked for 13 hours (more than two 6-hour runs) points to a stuck scheduler or feed.
    const cutoff = new Date(Date.now() - 13 * HOUR).toISOString();
    const n = await count('import_sources', (q) =>
      q.eq('enabled', true).lt('created_at', cutoff).or(`last_success_at.is.null,last_success_at.lt.${cutoff}`),
    );
    return n
      ? {
          message: `${n} import ${n === 1 ? 'source has' : 'sources have'} not worked for over 13 hours. The scheduler may not be running.`,
          href: '/admin/jobs',
          linkText: 'See scheduled jobs',
        }
      : null;
  },
  async () => {
    const n = await count('jobs', (q) => q.not('last_error', 'is', null).neq('kind', 'import'));
    return n
      ? {
          message: `${n} scheduled ${n === 1 ? 'job' : 'jobs'} failed.`,
          href: '/admin/jobs',
          linkText: 'See scheduled jobs',
        }
      : null;
  },
  async () => {
    // The cleanup job runs daily; if it hasn't for two days, the scheduler is probably stopped.
    const cutoff = new Date(Date.now() - 48 * HOUR).toISOString();
    const n = await count('jobs', (q) =>
      q.eq('key', 'cleanup').lt('created_at', cutoff).or(`last_success_at.is.null,last_success_at.lt.${cutoff}`),
    );
    return n
      ? {
          message: 'The daily clean-up has not run for 2 days. The scheduler may not be running.',
          href: '/admin/jobs',
          linkText: 'See scheduled jobs',
        }
      : null;
  },
  async () => {
    const n = await count('email_outbox', (q) => q.in('status', ['failed', 'unknown']));
    return n
      ? {
          message: `${n} ${n === 1 ? 'email' : 'emails'} could not be sent, or might not have been.`,
          href: '/admin/email-outbox',
          linkText: 'See emails with problems',
        }
      : null;
  },
];

/** Adds a health check (used by later features: imports, digest, sponsorships). */
export function registerCheck(check: Check): void {
  checks.push(check);
}

export async function problems(): Promise<Problem[]> {
  const results = await Promise.allSettled(checks.map((c) => c()));
  return results.flatMap((r) => {
    if (r.status === 'fulfilled') return r.value ? [r.value] : [];
    console.error('[health] a check failed', r.reason);
    return [
      {
        message: 'A health check could not run, so there may be problems this list does not show.',
        href: '/admin',
        linkText: 'Reload the admin page',
      },
    ];
  });
}
