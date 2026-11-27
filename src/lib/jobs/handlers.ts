/** The jobs calenda11y runs, and how often. Imported once by the tick endpoint. */
import { db } from '../db.ts';
import { sendOutbox } from '../email/outbox.ts';
import { runImport } from '../imports/run.ts';
import type { ImportSource } from '../imports/types.ts';
import { unwrap, unwrapMaybe } from '../result.ts';
import { registerHandler, registerJobs } from './queue.ts';

const HOUR = 3600;

registerJobs(async () => {
  const sources = unwrap(
    await db().from('import_sources').select('id').eq('enabled', true),
    'supabase',
    'listing sources',
  ) as Array<{ id: string }>;
  return [
    { key: 'outbox', kind: 'outbox' as const, interval_seconds: 300 },
    { key: 'cleanup', kind: 'cleanup' as const, interval_seconds: 24 * HOUR },
    ...sources.map((s) => ({ key: `import:${s.id}`, kind: 'import' as const, interval_seconds: 6 * HOUR })),
  ];
});

registerHandler('import', async (job, deadline) => {
  const id = job.key.slice('import:'.length);
  const source = unwrapMaybe(
    await db().from('import_sources').select('id,type,name,config,enabled').eq('id', id).maybeSingle(),
    'supabase',
    'reading source',
  ) as ImportSource | null;
  if (!source || !source.enabled) return { finished: true, ok: true, counts: { skipped: 'source is off or removed' } };
  const r = await runImport(source, deadline);
  return { finished: r.finished, ok: r.ok, counts: r.counts, ...(r.error && { error: r.error }) };
});

registerHandler('outbox', async () => {
  const s = await sendOutbox({ limit: 100 });
  return {
    finished: true,
    ok: s.failed === 0,
    counts: { ...s },
    ...(s.failed ? { error: `${s.failed} emails failed` } : {}),
  };
});

registerHandler('cleanup', async () => {
  const counts = unwrap(await db().rpc('run_cleanup'), 'supabase', 'cleaning up') as Record<string, number>;
  return { finished: true, ok: true, counts };
});
