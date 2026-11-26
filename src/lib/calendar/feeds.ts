/** Shared logic for the ICS and RSS feeds. */
import { env } from '../env.ts';
import type { PublicEvent } from '../events/model.ts';
import { describeFilters, parseFilters, type Filters } from '../events/predicates.ts';
import { clock, listAllEvents, type Clock } from '../events/query.ts';
import { buildCalendar } from './ics.ts';

const DAY = 86_400_000;
/** Keep events that ended recently, so subscribed calendars don't drop them as soon as they finish. */
export const KEEP_ENDED_DAYS = 30;
/** Cancelled events stay in feeds this long, so calendars that subscribed see the cancellation. */
export const KEEP_CANCELLED_DAYS = 30;

export const FEED_CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

export async function feedEvents(filters: Filters, c: Clock = clock()): Promise<PublicEvent[]> {
  const nowMs = Date.parse(c.now);
  const since = new Date(nowMs - KEEP_ENDED_DAYS * DAY).toISOString();
  const events = await listAllEvents({ ...filters, when: 'any', since, page: 1 }, c);
  const cancelledCutoff = nowMs - KEEP_CANCELLED_DAYS * DAY;
  return events.filter(
    (e) => e.status !== 'cancelled' || (e.cancelled_at && Date.parse(e.cancelled_at) > cancelledCutoff),
  );
}

export function feedTitle(filters: Filters): string {
  const d = describeFilters(filters);
  return d === 'all events' ? 'calenda11y: accessibility events' : `calenda11y: ${d}`;
}

export async function icsResponse(filters: Filters): Promise<Response> {
  const events = await feedEvents(filters);
  const body = buildCalendar(events, {
    name: feedTitle(filters),
    description: 'Accessibility events from calenda11y. Event data is licensed CC BY 4.0.',
    siteUrl: env().SITE_URL,
  });
  return new Response(body, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': FEED_CACHE },
  });
}

export function badFeedRequest(errors: Record<string, string>): Response {
  return new Response(`This feed address has a problem:\n${Object.values(errors).join('\n')}\n`, {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Parses feed filters; pagination doesn't apply to feeds. */
export function parseFeedFilters(params: URLSearchParams) {
  const p = new URLSearchParams(params);
  p.delete('page');
  p.delete('when');
  return parseFilters(p);
}
