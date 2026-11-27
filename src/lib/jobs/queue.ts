/**
 * The job queue. A tick (from pg_cron, or "Run now" in admin) claims due jobs
 * one at a time under a lease, gives each a share of the time budget, and
 * records every run in job_runs. A job that runs out of time keeps its
 * cursor and is picked up again on the next tick.
 */
import { db } from '../db.ts';
import { ServiceError, unwrap } from '../result.ts';

export type JobKind = 'import' | 'outbox' | 'cleanup' | 'digest' | 'sponsor_expiry' | 'alerts' | 'geocode';

export interface Job {
  key: string;
  kind: JobKind;
  interval_seconds: number;
  cursor: unknown;
  attempts: number;
}

export interface JobResult {
  /** False if the job ran out of time and should continue next tick. */
  finished: boolean;
  ok: boolean;
  counts?: Record<string, unknown>;
  cursor?: unknown;
  error?: string;
}

export type Handler = (job: Job, deadline: number) => Promise<JobResult>;

const handlers = new Map<JobKind, Handler>();
const definers: Array<() => Promise<Array<{ key: string; kind: JobKind; interval_seconds: number }>>> = [];

export function registerHandler(kind: JobKind, handler: Handler): void {
  handlers.set(kind, handler);
}

/** Registers a function that lists the jobs that should exist (e.g. one per import source). */
export function registerJobs(
  define: () => Promise<Array<{ key: string; kind: JobKind; interval_seconds: number }>>,
): void {
  definers.push(define);
}

/** Makes sure every job that should exist does, and removes import jobs for sources that are gone or off. */
export async function ensureJobs(): Promise<void> {
  const wanted = (await Promise.all(definers.map((d) => d()))).flat();
  if (wanted.length) {
    unwrap(
      await db().from('jobs').upsert(wanted, { onConflict: 'key', ignoreDuplicates: true }).select('key'),
      'supabase',
      'creating jobs',
    );
  }
  const importKeys = wanted.filter((w) => w.kind === 'import').map((w) => w.key);
  let stale = db().from('jobs').delete().eq('kind', 'import');
  if (importKeys.length) stale = stale.not('key', 'in', `(${importKeys.map((k) => `"${k}"`).join(',')})`);
  const removed = await stale.select('key');
  if (removed.error) throw new ServiceError('supabase', `removing old jobs: ${removed.error.message}`);
}

export const LEASE_SECONDS = 120;
/** Leave this much of the budget for saving results. */
const SAFETY_MS = 3_000;
/** How soon a job that threw is tried again. */
const RETRY_AFTER_ERROR_SECONDS = 15 * 60;

export interface TickSummary {
  ran: Array<{ key: string; ok: boolean; finished: boolean; error?: string; counts?: Record<string, unknown> }>;
}

async function runOne(job: Job, deadline: number): Promise<TickSummary['ran'][number]> {
  const started = unwrap(
    await db().from('job_runs').insert({ job_key: job.key }).select('id').single(),
    'supabase',
    'recording job start',
  ) as { id: number };
  let result: JobResult;
  try {
    const handler = handlers.get(job.kind);
    if (!handler) throw new Error(`No handler for jobs of kind "${job.kind}"`);
    result = await handler(job, deadline);
  } catch (error) {
    result = { finished: true, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const now = Date.now();
  const nextRun = !result.finished
    ? now
    : result.ok
      ? now + job.interval_seconds * 1000
      : now + Math.min(job.interval_seconds, RETRY_AFTER_ERROR_SECONDS) * 1000;
  unwrap(
    await db()
      .from('jobs')
      .update({
        lease_until: null,
        cursor: result.finished ? null : (result.cursor ?? job.cursor ?? null),
        run_after: new Date(nextRun).toISOString(),
        attempts: result.ok ? 0 : job.attempts,
        ...(result.ok && result.finished ? { last_success_at: new Date(now).toISOString(), last_error: null } : {}),
        ...(!result.ok ? { last_error: (result.error ?? 'Failed').slice(0, 2000) } : {}),
      })
      .eq('key', job.key)
      .select('key'),
    'supabase',
    'saving job result',
  );
  unwrap(
    await db()
      .from('job_runs')
      .update({
        finished_at: new Date(now).toISOString(),
        ok: result.ok,
        finished_job: result.finished,
        error: result.error ?? null,
        counts: result.counts ?? {},
      })
      .eq('id', started.id)
      .select('id'),
    'supabase',
    'recording job end',
  );
  return {
    key: job.key,
    ok: result.ok,
    finished: result.finished,
    ...(result.error && { error: result.error }),
    ...(result.counts && { counts: result.counts }),
  };
}

/** Runs due jobs until the budget is used up. With `onlyKey`, runs just that job now. */
export async function runTick(options: { budgetMs?: number; onlyKey?: string } = {}): Promise<TickSummary> {
  const deadline = Date.now() + (options.budgetMs ?? 45_000) - SAFETY_MS;
  await ensureJobs();
  const ran: TickSummary['ran'] = [];
  if (options.onlyKey) {
    const [job] = unwrap(
      await db().rpc('claim_job_by_key', { p_key: options.onlyKey, p_lease_seconds: LEASE_SECONDS }),
      'supabase',
      'claiming job',
    ) as Job[];
    if (job) ran.push(await runOne(job, deadline));
    return { ran };
  }
  while (Date.now() < deadline) {
    const [job] = unwrap(
      await db().rpc('claim_job', { p_lease_seconds: LEASE_SECONDS }),
      'supabase',
      'claiming job',
    ) as Job[];
    if (!job) break;
    ran.push(await runOne(job, deadline));
  }
  return { ran };
}
