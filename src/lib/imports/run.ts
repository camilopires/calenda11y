/**
 * Runs an import for one source, in steps that fit inside a time budget:
 *
 *  1. fetching: read every page from the source into import_items (staging);
 *  2. processing: save staged items in batches (upsert.ts);
 *  3. complete: flag published events the source no longer lists.
 *
 * If the budget runs out, the run stays open and the next tick carries on
 * where it stopped. Events are only marked missing after a complete run, so
 * a failed page can never make events look deleted.
 */
import { db } from '../db.ts';
import { env } from '../env.ts';
import { ServiceError, unwrap, unwrapMaybe } from '../result.ts';
import { ADAPTERS } from './adapters.ts';
import { safeFetch } from './fetch.ts';
import { normalise } from './normalise.ts';
import {
  IMPORT_LIMITS,
  SourceUnavailable,
  type AdapterContext,
  type ImportSource,
  type ImportedEvent,
  type Skipped,
} from './types.ts';
import { upsertImported } from './upsert.ts';

const BATCH = 50;
const MAX_STORED_SKIPS = 200;

interface Run {
  id: string;
  status: 'fetching' | 'processing' | 'complete' | 'failed';
  fetch_cursor: unknown;
  counts: Record<string, number>;
  skipped: Skipped[];
}

export interface RunResult {
  finished: boolean;
  ok: boolean;
  counts: Record<string, number>;
  error?: string;
}

export function defaultContext(now = new Date()): AdapterContext {
  const e = env();
  return {
    now,
    env: {
      LUMA_API_KEY: e.LUMA_API_KEY,
      MEETUP_CLIENT_ID: e.MEETUP_CLIENT_ID,
      MEETUP_CLIENT_SECRET: e.MEETUP_CLIENT_SECRET,
    },
    fetchText: async (url, init) => {
      const r = await safeFetch(url, init);
      return { status: r.status, body: r.body, contentType: r.contentType };
    },
  };
}

async function openRun(sourceId: string): Promise<Run> {
  const active = unwrapMaybe(
    await db()
      .from('import_runs')
      .select('id,status,fetch_cursor,counts,skipped')
      .eq('source_id', sourceId)
      .in('status', ['fetching', 'processing'])
      .maybeSingle(),
    'supabase',
    'finding open run',
  ) as Run | null;
  if (active) return active;
  const created = await db()
    .from('import_runs')
    .insert({ source_id: sourceId })
    .select('id,status,fetch_cursor,counts,skipped')
    .single();
  // Another tick started a run for this source at the same moment: use that one.
  if (created.error?.code === '23505') return openRun(sourceId);
  return unwrap(created, 'supabase', 'starting run') as Run;
}

const bump = (counts: Record<string, number>, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};

export async function runImport(
  source: ImportSource,
  deadline: number,
  ctx: AdapterContext = defaultContext(),
): Promise<RunResult> {
  const run = await openRun(source.id);
  const counts = { ...run.counts };
  const skipped = [...run.skipped];
  let status = run.status;
  let cursor = run.fetch_cursor;

  const save = async (extra: Record<string, unknown> = {}) =>
    unwrap(
      await db()
        .from('import_runs')
        .update({ status, fetch_cursor: cursor ?? null, counts, skipped: skipped.slice(0, MAX_STORED_SKIPS), ...extra })
        .eq('id', run.id)
        .select('id'),
      'supabase',
      'saving run',
    );

  try {
    const adapter = ADAPTERS[source.type];
    while (status === 'fetching' && Date.now() < deadline) {
      // Reading a feed stops at the import's own deadline (see parseIcs).
      const page = await adapter.fetchPage(source, cursor ?? undefined, { ...ctx, deadline: ctx.deadline ?? deadline });
      if (page.configUpdate) {
        source.config = { ...source.config, ...page.configUpdate };
        unwrap(
          await db().from('import_sources').update({ config: source.config }).eq('id', source.id).select('id'),
          'supabase',
          'saving new credentials',
        );
      }
      const staged: Array<{ run_id: string; source_uid: string; payload: ImportedEvent }> = [];
      for (const raw of page.items) {
        const n = normalise(raw, source);
        if (n.ok) staged.push({ run_id: run.id, source_uid: n.event.source_uid, payload: n.event });
        else skipped.push({ uid: raw.source_uid, reason: n.reason });
      }
      skipped.push(...page.skipped);
      bump(counts, 'skipped', page.skipped.length + (page.items.length - staged.length));
      if (staged.length) {
        // ignoreDuplicates: a source that lists the same event twice is read once.
        unwrap(
          await db()
            .from('import_items')
            .upsert(staged, { onConflict: 'run_id,source_uid', ignoreDuplicates: true })
            .select('source_uid'),
          'supabase',
          'staging items',
        );
        bump(counts, 'fetched', staged.length);
      }
      const tooMany = (counts.fetched ?? 0) >= IMPORT_LIMITS.maxItemsPerRun;
      if (tooMany) skipped.push({ uid: '(feed)', reason: `Stopped after ${IMPORT_LIMITS.maxItemsPerRun} events` });
      // A partial read is not a full snapshot, so nothing may be marked missing from it.
      const truncated = tooMany || page.truncated === true;
      if (page.next !== undefined && !truncated) cursor = page.next;
      else {
        status = 'processing';
        cursor = null;
      }
      await save(truncated ? { truncated: true } : {});
    }

    while (status === 'processing' && Date.now() < deadline) {
      const batch = unwrap(
        await db()
          .from('import_items')
          .select('source_uid,payload')
          .eq('run_id', run.id)
          .is('processed_at', null)
          .limit(BATCH),
        'supabase',
        'reading staged items',
      ) as Array<{ source_uid: string; payload: ImportedEvent }>;
      if (!batch.length) {
        // Completing the run and flagging missing events happen in one transaction.
        const missing = unwrap(
          await db().rpc('complete_import_run', {
            p_run_id: run.id,
            p_counts: counts,
            p_skipped: skipped.slice(0, MAX_STORED_SKIPS),
          }),
          'supabase',
          'completing run',
        ) as number;
        status = 'complete';
        bump(counts, 'missing_from_source', missing);
        break;
      }
      for (const item of batch) {
        const outcome = await upsertImported(source.id, source.type, item.payload);
        bump(counts, outcome);
        unwrap(
          await db()
            .from('import_items')
            .update({ processed_at: new Date().toISOString(), outcome })
            .eq('run_id', run.id)
            .eq('source_uid', item.source_uid)
            .select('source_uid'),
          'supabase',
          'marking item done',
        );
        if (Date.now() >= deadline) break;
      }
      await save();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status = 'failed';
    await save({ error: message.slice(0, 2000), finished_at: new Date().toISOString() });
    unwrap(
      await db()
        .from('import_sources')
        .update({
          last_run_at: new Date().toISOString(),
          last_error: message.slice(0, 2000),
          last_counts: counts,
          credentials_status: error instanceof SourceUnavailable ? error.credentials : 'ok',
        })
        .eq('id', source.id)
        .select('id'),
      'supabase',
      'recording source failure',
    );
    return { finished: true, ok: false, counts, error: message };
  }

  if (status !== 'complete') return { finished: false, ok: true, counts };
  const now = new Date().toISOString();
  const saved = await db()
    .from('import_sources')
    .update({ last_run_at: now, last_success_at: now, last_error: null, last_counts: counts, credentials_status: 'ok' })
    .eq('id', source.id)
    .select('id');
  if (saved.error) throw new ServiceError('supabase', `recording source success: ${saved.error.message}`);
  return { finished: true, ok: true, counts };
}
