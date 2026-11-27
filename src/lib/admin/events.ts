/** Admin reads and writes for events. Callers must have passed requireAdmin(). */
import { db } from '../db.ts';
import { queued, sendNow } from '../email/outbox.ts';
import { eventApproved, eventRejected } from '../email/templates.ts';
import type { EventRecord } from '../forms/event.ts';
import { ServiceError, unwrap, unwrapMaybe } from '../result.ts';

export const QUEUE_VIEWS = {
  pending: 'Waiting for review',
  changed: 'Changed by their source',
  flagged: 'Flagged',
  approved: 'Published',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
} as const;
export type QueueView = keyof typeof QUEUE_VIEWS;

export interface AdminEvent extends EventRecord {
  id: string;
  slug: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  flags: string[];
  source: string;
  source_id: string | null;
  pending_changes: Record<string, unknown> | null;
  version: number;
  local_start_date: string;
  local_end_date: string;
  start_instant: string;
  end_instant: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

const COLUMNS =
  'id,slug,title,summary,description,lang,organiser,url,all_day,starts_at,ends_at,start_date,end_date,timezone,' +
  'format,country_code,city,venue,price,captions,sign_language,step_free,quiet_room,hearing_loop,remote_attendance,' +
  'access_notes,status,flags,source,source_id,pending_changes,version,local_start_date,local_end_date,start_instant,' +
  'end_instant,created_at,updated_at,approved_at,types,cfp_url,cfp_closes_on,topics';

export const ADMIN_PAGE_SIZE = 50;

export async function listQueue(view: QueueView, page = 1): Promise<{ events: AdminEvent[]; total: number }> {
  let q = db().from('events').select(COLUMNS, { count: 'exact' });
  if (view === 'pending') q = q.eq('status', 'pending');
  else if (view === 'changed') q = q.not('pending_changes', 'is', null);
  else if (view === 'flagged') q = q.neq('flags', '{}').in('status', ['pending', 'approved']);
  else q = q.eq('status', view);
  const from = (page - 1) * ADMIN_PAGE_SIZE;
  const ordered =
    view === 'pending' || view === 'changed' || view === 'flagged'
      ? q.order('created_at', { ascending: true })
      : q.order('start_instant', { ascending: false });
  const result = await ordered.order('id').range(from, from + ADMIN_PAGE_SIZE - 1);
  const events = unwrap(result, 'supabase', 'listing queue') as unknown as AdminEvent[];
  return { events, total: result.count ?? events.length };
}

export async function queueCounts(): Promise<Record<QueueView, number>> {
  const count = async (build: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const r = await build(base());
    if (r.error) throw new ServiceError('supabase', `counting queue: ${r.error.message}`);
    return r.count ?? 0;
  };
  const base = () => db().from('events').select('id', { count: 'exact', head: true });
  const [pending, changed, flagged, approved, cancelled, rejected] = await Promise.all([
    count((q) => q.eq('status', 'pending')),
    count((q) => q.not('pending_changes', 'is', null)),
    count((q) => q.neq('flags', '{}').in('status', ['pending', 'approved'])),
    count((q) => q.eq('status', 'approved')),
    count((q) => q.eq('status', 'cancelled')),
    count((q) => q.eq('status', 'rejected')),
  ]);
  return { pending, changed, flagged, approved, cancelled, rejected };
}

export interface EventDetail {
  event: AdminEvent;
  submitter: { email: string | null; name: string | null; rejection_reason: string | null } | null;
  duplicates: Array<{ id: string; title: string; status: string; local_start_date: string; score: number }>;
  sourceName: string | null;
}

export async function getAdminEvent(id: string): Promise<EventDetail | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const event = unwrapMaybe(
    await db().from('events').select(COLUMNS).eq('id', id).maybeSingle(),
    'supabase',
    'reading event',
  ) as unknown as AdminEvent | null;
  if (!event) return null;
  const [priv, dupes, source] = await Promise.all([
    db()
      .from('events_private')
      .select('submitter_email,submitter_name,rejection_reason')
      .eq('event_id', id)
      .maybeSingle(),
    db()
      .from('event_duplicates')
      .select('score, duplicate:events!event_duplicates_duplicate_id_fkey(id,title,status,local_start_date)')
      .eq('event_id', id),
    event.source_id
      ? db().from('import_sources').select('name').eq('id', event.source_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const p = unwrapMaybe(priv, 'supabase', 'reading private details') as {
    submitter_email: string | null;
    submitter_name: string | null;
    rejection_reason: string | null;
  } | null;
  const d = (
    unwrap(dupes, 'supabase', 'reading duplicates') as unknown as Array<{
      score: number;
      duplicate: { id: string; title: string; status: string; local_start_date: string };
    }>
  ).map((r) => ({ ...r.duplicate, score: r.score }));
  const s = unwrapMaybe(source as { data: { name: string } | null; error: null }, 'supabase', 'reading source');
  return {
    event,
    submitter: p ? { email: p.submitter_email, name: p.submitter_name, rejection_reason: p.rejection_reason } : null,
    duplicates: d,
    sourceName: s?.name ?? null,
  };
}

export class VersionConflict extends Error {
  constructor() {
    super('Someone else changed this event while you were editing it');
    this.name = 'VersionConflict';
  }
}

/** Thrown when publishing an event for the first time without any type. */
export class NeedsTypeError extends Error {
  constructor() {
    super('Add at least one type before publishing');
    this.name = 'NeedsTypeError';
  }
}

/**
 * Whether this action would make an event public (published, or shown as
 * cancelled) for the first time without a type. The database refuses too.
 */
export function blockedForType(e: Pick<AdminEvent, 'approved_at' | 'types'>, action: ModerationAction): boolean {
  const target = TARGET[action];
  return (target === 'approved' || target === 'cancelled') && !e.approved_at && e.types.length === 0;
}

/** Saves edited details. Throws VersionConflict if the event changed since `version` was read. */
export async function saveEvent(id: string, version: number, record: EventRecord): Promise<AdminEvent> {
  const result = await db()
    .from('events')
    .update(record)
    .eq('id', id)
    .eq('version', version)
    .select(COLUMNS)
    .maybeSingle();
  const row = unwrapMaybe(result, 'supabase', 'saving event') as unknown as AdminEvent | null;
  if (!row) throw new VersionConflict();
  return row;
}

export type ModerationAction = 'approve' | 'reject' | 'unpublish' | 'cancel' | 'restore';

const TARGET: Record<ModerationAction, AdminEvent['status']> = {
  approve: 'approved',
  reject: 'rejected',
  unpublish: 'pending',
  cancel: 'cancelled',
  restore: 'approved',
};

/** Changes an event's status, queueing any email to the person who submitted it in the same transaction. */
export async function moderate(
  detail: EventDetail,
  action: ModerationAction,
  version: number,
  reason = '',
): Promise<AdminEvent> {
  const e = detail.event;
  if (blockedForType(e, action)) throw new NeedsTypeError();
  const to = detail.submitter?.email;
  const emails = [];
  // Only email on the first approval, not when an admin republishes.
  if (action === 'approve' && to && !e.approved_at) {
    emails.push(queued('event_approved', `moderation:${e.id}:approved`, to, eventApproved(e)));
  }
  if (action === 'reject' && to) {
    emails.push(queued('event_rejected', `moderation:${e.id}:rejected:${version}`, to, eventRejected(e, reason)));
  }
  const { data, error } = await db().rpc('moderate_event', {
    p_event_id: e.id,
    p_expected_version: version,
    p_status: TARGET[action],
    p_reason: action === 'reject' ? reason : null,
    p_emails: emails,
  });
  if (error?.message === 'version_conflict') throw new VersionConflict();
  if (error?.message === 'needs_type') throw new NeedsTypeError();
  if (error || !data)
    throw new ServiceError('supabase', `moderating event: ${error?.message ?? 'no data'}`, error?.code);
  if (emails.length) {
    try {
      await sendNow(`moderation:${e.id}:`);
    } catch (err) {
      console.error('[moderate] sending email now failed; it will be retried', err);
    }
  }
  return data as AdminEvent;
}
