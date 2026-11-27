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
import { withinNear } from '../geo/distance.ts';

const DAYS = 30;
/** Entries in the feed, at most. */
const MAX_ITEMS = 500;
/** Changes read at a time, and how many pages at most. */
const PAGE = 500;
const MAX_PAGES = 20;
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
  const out: Array<{ change: FeedChange; event: PublicEvent }> = [];
  // Filter as we go, page by page, so unrelated changes can't push matching
  // ones out of the feed. Bounded, so a busy month can't make it slow.
  let before: number | null = null;
  for (let page = 0; page < MAX_PAGES && out.length < MAX_ITEMS; page++) {
    let q = db()
      .from('event_changes')
      .select('id,event_id,kind,what,before_status,after,created_at')
      .gt('created_at', since)
      .order('id', { ascending: false })
      .limit(PAGE);
    if (before !== null) q = q.lt('id', before);
    const changes = unwrap(await q, 'supabase', 'reading recent changes') as Array<FeedChange & { event_id: string }>;
    if (!changes.length) break;
    before = changes[changes.length - 1]!.id;
    const events = await matchingEvents([...new Set(changes.map((ch) => ch.event_id))], filters, c);
    for (const ch of changes) {
      const event = events.get(ch.event_id);
      if (event && out.length < MAX_ITEMS) out.push({ change: ch, event });
    }
    if (changes.length < PAGE) break;
  }
  return out;
}

/** The public events among these ids that match the filters. */
async function matchingEvents(ids: string[], filters: Filters, c: Clock): Promise<Map<string, PublicEvent>> {
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
    // The database narrows to a box; this is the exact distance.
    for (const e of rows) if (!filters.near || withinNear(e, filters.near)) events.set(e.id, e);
  }
  return events;
}
