import { db } from '../db.ts';
import { unwrap, unwrapMaybe } from '../result.ts';
import type { SourceConfig, SourceType } from '../imports/types.ts';

export interface SourceRow {
  id: string;
  type: SourceType;
  name: string;
  config: SourceConfig;
  enabled: boolean;
  credentials_status: 'ok' | 'missing' | 'expired' | 'unavailable';
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_counts: Record<string, number> | null;
  created_at: string;
}

const COLS =
  'id,type,name,config,enabled,credentials_status,last_run_at,last_success_at,last_error,last_counts,created_at';

export async function listSources(): Promise<SourceRow[]> {
  return unwrap(
    await db().from('import_sources').select(COLS).order('name'),
    'supabase',
    'listing sources',
  ) as unknown as SourceRow[];
}

export async function getSource(id: string): Promise<SourceRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return unwrapMaybe(
    await db().from('import_sources').select(COLS).eq('id', id).maybeSingle(),
    'supabase',
    'reading source',
  ) as unknown as SourceRow | null;
}

export async function recentRuns(sourceId: string) {
  return unwrap(
    await db()
      .from('import_runs')
      .select('id,status,counts,skipped,error,started_at,finished_at')
      .eq('source_id', sourceId)
      .order('started_at', { ascending: false })
      .limit(5),
    'supabase',
    'listing runs',
  ) as Array<{
    id: string;
    status: string;
    counts: Record<string, number>;
    skipped: Array<{ uid: string; reason: string }>;
    error: string | null;
    started_at: string;
    finished_at: string | null;
  }>;
}

/** A short, plain description of a run's counts. */
export function describeCounts(c: Record<string, number> | null | undefined): string {
  if (!c) return 'No runs yet';
  const parts: string[] = [];
  const label: Record<string, string> = {
    fetched: 'read',
    created: 'new',
    updated: 'updated',
    changed: 'changed (waiting for review)',
    unchanged: 'unchanged',
    skipped: 'skipped',
    missing_from_source: 'no longer listed',
  };
  for (const [k, text] of Object.entries(label)) if (c[k]) parts.push(`${c[k]} ${text}`);
  return parts.length ? parts.join(', ') : 'Nothing found';
}
