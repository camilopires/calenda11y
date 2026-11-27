/**
 * Saves one imported event, following the moderation rules:
 *  - new → added as pending, checked for duplicates;
 *  - still pending → updated straight away (nothing public yet);
 *  - published → any change to a public field goes into pending_changes for
 *    a person to accept, and the event is flagged "changed"; the public
 *    version stays as it was until then;
 *  - an event the source cancels (published or still pending) is flagged "cancel_requested";
 *  - rejected → only the record of what the source said is updated.
 *
 * Changes are detected against what the source said last time
 * (source_snapshot), so an admin's own edits aren't reported as changes.
 */
import { db } from '../db.ts';
import { newSlug } from '../forms/event.ts';
import { ServiceError, unwrap, unwrapMaybe } from '../result.ts';
import { randomToken } from '../security/tokens.ts';
import type { ImportedEvent, SourceType } from './types.ts';

export type UpsertOutcome = 'created' | 'updated' | 'changed' | 'unchanged' | 'ignored_cancelled' | 'ignored_rejected';

type Fields = ImportedEvent['fields'];
const FIELD_KEYS = [
  'title',
  'summary',
  'description',
  'lang',
  'organiser',
  'url',
  'all_day',
  'starts_at',
  'ends_at',
  'start_date',
  'end_date',
  'timezone',
  'format',
  'country_code',
  'city',
  'venue',
  'price',
] as const satisfies ReadonlyArray<keyof Fields>;
const INSTANTS = new Set(['starts_at', 'ends_at']);

function same(key: string, a: unknown, b: unknown): boolean {
  const na = a === undefined || a === '' ? null : a;
  const nb = b === undefined || b === '' ? null : b;
  if (na === null || nb === null) return na === nb;
  if (INSTANTS.has(key)) return Date.parse(String(na)) === Date.parse(String(nb));
  return String(na).trim() === String(nb).trim();
}

/** The fields in `next` that differ from `current`. */
export function diffFields(current: Partial<Record<string, unknown>> | null, next: Fields): Partial<Fields> {
  const out: Partial<Record<string, unknown>> = {};
  for (const k of FIELD_KEYS) if (!current || !same(k, current[k], next[k])) out[k] = next[k];
  return out as Partial<Fields>;
}

const addFlag = (flags: string[], flag: string) => (flags.includes(flag) ? flags : [...flags, flag]);

interface Existing extends Partial<Record<string, unknown>> {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  version: number;
  flags: string[];
  source_snapshot: Fields | null;
  pending_changes: Partial<Fields> | null;
}

const SELECT = `id,status,version,flags,source_snapshot,pending_changes,${FIELD_KEYS.join(',')}`;
const shortId = () =>
  randomToken(6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 6)
    .padEnd(6, '0');

export async function upsertImported(sourceId: string, type: SourceType, item: ImportedEvent): Promise<UpsertOutcome> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = unwrapMaybe(
      await db()
        .from('events')
        .select(SELECT)
        .eq('source_id', sourceId)
        .eq('source_uid', item.source_uid)
        .maybeSingle(),
      'supabase',
      'finding imported event',
    ) as unknown as Existing | null;

    if (!existing) {
      if (item.cancelled) return 'ignored_cancelled';
      const { data, error } = await db()
        .from('events')
        .insert({
          ...item.fields,
          slug: newSlug(item.fields.title, shortId),
          status: 'pending',
          source: type,
          source_id: sourceId,
          source_uid: item.source_uid,
          source_snapshot: item.fields,
        })
        .select('id')
        .single();
      // Another run added it at the same moment: go round again and update it.
      if (error?.code === '23505') continue;
      if (error || !data)
        throw new ServiceError('supabase', `adding imported event: ${error?.message ?? 'no data'}`, error?.code);
      unwrap(await db().rpc('find_duplicates', { p_event_id: data.id }), 'supabase', 'checking duplicates');
      return 'created';
    }

    // Only what the source itself changed since last time. Fields an admin
    // edited, and the source didn't touch, are left alone.
    const sourceChanges = diffFields(existing.source_snapshot, item.fields);
    const sourceChanged = Object.keys(sourceChanges).length > 0;
    const published = existing.status === 'approved' || existing.status === 'cancelled';
    const newlyCancelled =
      item.cancelled &&
      (existing.status === 'approved' || existing.status === 'pending') &&
      !existing.flags.includes('cancel_requested');
    if (!sourceChanged && !newlyCancelled) return 'unchanged';

    let update: Record<string, unknown>;
    let outcome: UpsertOutcome;
    if (existing.status === 'rejected') {
      update = { source_snapshot: item.fields };
      outcome = 'ignored_rejected';
    } else if (!published) {
      // Not public yet, so apply it directly; if the source cancelled it, flag that for the reviewer.
      update = {
        ...sourceChanges,
        source_snapshot: item.fields,
        ...(item.cancelled &&
          !existing.flags.includes('cancel_requested') && { flags: addFlag(existing.flags, 'cancel_requested') }),
      };
      outcome = 'updated';
    } else {
      // Of the source's changes, those that differ from what's published now
      // (merged with any changes still waiting from earlier runs).
      const merged: Partial<Record<string, unknown>> = { ...(existing.pending_changes ?? {}), ...sourceChanges };
      // Drop anything that now matches what's published.
      const changes = Object.fromEntries(
        Object.entries(merged).filter(([k, v]) => !same(k, existing[k], v)),
      ) as Partial<Fields>;
      let flags = existing.flags;
      if (Object.keys(changes).length) flags = addFlag(flags, 'changed');
      if (newlyCancelled) flags = addFlag(flags, 'cancel_requested');
      update = {
        pending_changes: Object.keys(changes).length ? changes : null,
        flags,
        source_snapshot: item.fields,
      };
      outcome = 'changed';
    }

    const saved = unwrapMaybe(
      await db()
        .from('events')
        .update(update)
        .eq('id', existing.id)
        .eq('version', existing.version)
        .select('id')
        .maybeSingle(),
      'supabase',
      'updating imported event',
    );
    if (saved) return outcome;
    // Someone edited it at the same time; read it again and retry.
  }
  throw new ServiceError('supabase', `the imported event ${item.source_uid} kept changing while saving`);
}

/** Applies a published event's pending changes (an admin accepted them). */
export async function acceptPendingChanges(eventId: string, version: number): Promise<boolean> {
  const row = unwrapMaybe(
    await db().from('events').select('pending_changes,flags').eq('id', eventId).eq('version', version).maybeSingle(),
    'supabase',
    'reading pending changes',
  ) as { pending_changes: Partial<Fields> | null; flags: string[] } | null;
  if (!row) return false;
  const saved = unwrapMaybe(
    await db()
      .from('events')
      .update({
        ...(row.pending_changes ?? {}),
        pending_changes: null,
        flags: row.flags.filter((f) => f !== 'changed'),
      })
      .eq('id', eventId)
      .eq('version', version)
      .select('id')
      .maybeSingle(),
    'supabase',
    'applying pending changes',
  );
  return saved !== null;
}

export async function discardPendingChanges(eventId: string, version: number): Promise<boolean> {
  const row = unwrapMaybe(
    await db().from('events').select('flags').eq('id', eventId).eq('version', version).maybeSingle(),
    'supabase',
    'reading event',
  ) as { flags: string[] } | null;
  if (!row) return false;
  const saved = unwrapMaybe(
    await db()
      .from('events')
      .update({ pending_changes: null, flags: row.flags.filter((f) => f !== 'changed' && f !== 'cancel_requested') })
      .eq('id', eventId)
      .eq('version', version)
      .select('id')
      .maybeSingle(),
    'supabase',
    'discarding pending changes',
  );
  return saved !== null;
}
