/**
 * The "just added" feed (/feeds/new.rss): events published or changed in
 * the last 30 days, newest first. Each entry is described from the snapshot
 * stored with its change, so an older entry ("moved to Tuesday") stays true
 * after later changes. Only events that are still public, and that match
 * the feed's filters, are included.
 */
import { db } from '../db.ts';
import { eventPageUrl } from '../calendar/ics.ts';
import { escapeXml, rssDocument, type FeedOptions } from '../calendar/rss.ts';
import { PUBLIC_EVENT_COLUMNS, type PublicEvent } from '../events/model.ts';
import { applyFilters, type Filters } from '../events/predicates.ts';
import { clock, type Clock } from '../events/query.ts';
import { unwrap } from '../result.ts';
import { reasonLines, type ChangeReason } from './changes.ts';

const DAYS = 30;
const MAX_ITEMS = 500;
/** Event ids per lookup (more makes the request address too long). */
const CHUNK = 80;

export interface FeedChange {
  id: number;
  kind: 'new' | 'updated';
  what: ChangeReason[];
  before_status: 'pending' | 'approved' | 'rejected' | 'cancelled' | null;
  after: Record<string, unknown>;
  created_at: string;
}

const SHORT: Record<ChangeReason, string> = {
  cancelled: 'cancelled',
  restored: 'no longer cancelled',
  time: 'new date or time',
  place: 'new place',
  cfp: 'call for speakers',
  access: 'access',
};

export function buildChangesRss(entries: Array<{ change: FeedChange; event: PublicEvent }>, o: FeedOptions): string {
  const items = entries.map(({ change, event }) => {
    // The event as it was right after this change.
    const then = { ...event, ...change.after } as PublicEvent;
    const isNew = change.kind === 'new';
    const reasons = reasonLines(then, {
      isNew,
      what: new Set(change.what.filter((w) => w !== 'cancelled' && w !== 'restored')) as never,
      statusBefore: change.before_status,
    });
    const title = isNew
      ? `New: ${event.title}`
      : `Updated (${change.what.map((w) => SHORT[w]).join(', ')}): ${event.title}`;
    const link = eventPageUrl(o.siteUrl, event.slug);
    const description = [...reasons, event.summary].join('. ');
    return [
      '    <item>',
      `      <title>${escapeXml(title)}</title>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <guid isPermaLink="false">change-${change.id}@calenda11y.org</guid>`,
      `      <description>${escapeXml(description)}</description>`,
      `      <pubDate>${new Date(change.created_at).toUTCString()}</pubDate>`,
      '    </item>',
    ].join('\n');
  });
  return rssDocument(o, items);
}

/** Recent changes whose events are public and match the filters, newest first. */
export async function newFeedEntries(
  filters: Filters,
  c: Clock = clock(),
): Promise<Array<{ change: FeedChange; event: PublicEvent }>> {
  const since = new Date(Date.parse(c.now) - DAYS * 86_400_000).toISOString();
  const changes = unwrap(
    await db()
      .from('event_changes')
      .select('id,event_id,kind,what,before_status,after,created_at')
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(MAX_ITEMS),
    'supabase',
    'reading recent changes',
  ) as Array<FeedChange & { event_id: string }>;
  const ids = [...new Set(changes.map((ch) => ch.event_id))];
  const events = new Map<string, PublicEvent>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const q = db()
      .from('public_events')
      .select(PUBLIC_EVENT_COLUMNS)
      .in('id', ids.slice(i, i + CHUNK));
    const rows = unwrap(
      await applyFilters(q, { ...filters, when: 'any', page: 1 }, c.now, c.today),
      'supabase',
      'reading recent events',
    ) as unknown as PublicEvent[];
    for (const e of rows) events.set(e.id, e);
  }
  return changes.filter((ch) => events.has(ch.event_id)).map((ch) => ({ change: ch, event: events.get(ch.event_id)! }));
}
