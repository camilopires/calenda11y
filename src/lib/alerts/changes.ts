/**
 * Turning a batch of event_changes rows into what an alert says about each
 * event. An email describes the net change since the person's last one:
 * status compares the status before the first change in the batch with the
 * event's status now (so cancelled then restored says nothing), and the
 * other reasons describe the event as it is now.
 */
import { cfpDeadline } from '../events/cfp.ts';
import { describeWhen } from '../events/dates.ts';
import { ACCESS_LABELS, accessProvisions, countryName, type PublicEvent } from '../events/model.ts';

export const CHANGE_REASONS = ['cancelled', 'restored', 'time', 'place', 'cfp', 'access'] as const;
export type ChangeReason = (typeof CHANGE_REASONS)[number];
type Status = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ChangeRow {
  seq: number;
  event_id: string;
  kind: 'new' | 'updated';
  what: ChangeReason[];
  before_status: Status | null;
}

export interface MergedChange {
  isNew: boolean;
  /** Reasons other than status, combined across the batch. */
  what: Set<Exclude<ChangeReason, 'cancelled' | 'restored'>>;
  /** The status before the first change in the batch. */
  statusBefore: Status | null;
}

/** One entry per event, in the order each event first appears. */
export function mergeChanges(rows: readonly ChangeRow[]): Map<string, MergedChange> {
  const out = new Map<string, MergedChange>();
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    let m = out.get(r.event_id);
    if (!m) {
      m = { isNew: false, what: new Set(), statusBefore: r.before_status };
      out.set(r.event_id, m);
    }
    if (r.kind === 'new') m.isNew = true;
    for (const w of r.what) if (w !== 'cancelled' && w !== 'restored') m.what.add(w);
  }
  return out;
}

/** The status line, if the status really changed over the batch. */
function statusLine(e: Pick<PublicEvent, 'status'>, m: MergedChange): string | null {
  if (m.isNew) return e.status === 'cancelled' ? 'Cancelled' : null;
  if (m.statusBefore === 'approved' && e.status === 'cancelled') return 'Cancelled';
  if (m.statusBefore === 'cancelled' && e.status === 'approved') return 'No longer cancelled';
  return null;
}

function place(e: PublicEvent): string {
  return [e.venue, e.city, e.country_code ? countryName(e.country_code) : null].filter(Boolean).join(', ');
}

/** What changed, in words, for an updated (or new but cancelled) event. */
export function reasonLines(e: PublicEvent, m: MergedChange): string[] {
  const lines: string[] = [];
  const status = statusLine(e, m);
  if (status) lines.push(status);
  if (m.isNew) return lines;
  if (m.what.has('time')) {
    const w = describeWhen(e);
    lines.push(`New date or time: ${w.date}, ${w.time}`);
  }
  if (m.what.has('place')) {
    if (e.format === 'online') lines.push('Now online');
    else if (e.format === 'hybrid') lines.push(`Now in person and online: ${place(e)}`);
    else lines.push(`Moved to: ${place(e)}`);
  }
  if (m.what.has('cfp')) lines.push(cfpDeadline(e) ?? 'Call for speakers removed');
  if (m.what.has('access')) {
    const now = accessProvisions(e);
    lines.push(
      now.length
        ? `Access changed: now has ${now.map((a) => ACCESS_LABELS[a].toLowerCase()).join(', ')}`
        : 'Access changed: no access provisions listed now',
    );
  }
  return lines;
}

/** Whether anything is left to say once status changes that cancel out are dropped. */
export function hasNetChange(e: PublicEvent, m: MergedChange): boolean {
  return m.isNew || m.what.size > 0 || statusLine(e, m) !== null;
}
