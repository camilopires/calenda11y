/**
 * Problems shown in a banner on every admin page, so failures never go
 * unnoticed. Each check reports what's wrong and where to fix it.
 */
import { db } from '../db.ts';
import { ServiceError } from '../result.ts';

export interface Problem {
  message: string;
  href: string;
  linkText: string;
}

type Check = () => Promise<Problem | null>;

type CountQuery = ReturnType<ReturnType<ReturnType<typeof db>['from']>['select']>;

/** Counts rows in a table that match `apply`. Exported for checks added by other modules. */
export async function count(table: string, apply: (q: CountQuery) => CountQuery): Promise<number> {
  const r = await apply(db().from(table).select('*', { count: 'exact', head: true }));
  if (r.error) throw new ServiceError('supabase', `health check on ${table}: ${r.error.message}`);
  return r.count ?? 0;
}

const checks: Check[] = [
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
