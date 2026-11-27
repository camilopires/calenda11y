/**
 * Eventbrite. There is no public search, so this reads one organisation's
 * events, which the token must be allowed to see (an organisation's own
 * token, or one it has authorised). Cancelled events are included so their
 * cancellation reaches us.
 */
import { SourceUnavailable, type Adapter, type RawEvent, type Skipped } from './types.ts';

interface EbEvent {
  id: string;
  name?: { text?: string };
  summary?: string;
  description?: { text?: string };
  url?: string;
  start?: { timezone?: string; utc?: string };
  end?: { utc?: string };
  online_event?: boolean;
  is_free?: boolean;
  status?: string;
  venue?: { name?: string; address?: { city?: string; country?: string; localized_address_display?: string } } | null;
  organizer?: { name?: string } | null;
}

export function eventbriteToRaw(e: EbEvent): RawEvent | Skipped {
  if (!e.start?.utc || !e.end?.utc) return { uid: e.id, reason: 'It has no start or end time' };
  return {
    source_uid: e.id,
    title: e.name?.text ?? '',
    description: e.description?.text ?? e.summary ?? null,
    url: e.url ?? null,
    organiser: e.organizer?.name ?? null,
    all_day: false,
    starts_at: e.start.utc,
    ends_at: e.end.utc,
    timezone: e.start.timezone ?? null,
    location: [e.venue?.name, e.venue?.address?.localized_address_display].filter(Boolean).join(', ') || null,
    city: e.venue?.address?.city ?? null,
    country_code: e.venue?.address?.country ?? null,
    online: e.online_event ?? null,
    free: e.is_free ?? null,
    cancelled: e.status === 'canceled',
  };
}

export const eventbriteAdapter: Adapter = {
  async fetchPage(source, cursor, ctx) {
    const { organisation_id: org, token } = source.config;
    if (!org || !token)
      throw new SourceUnavailable('Add the organisation id and a token that can read its events', 'missing');
    const u = new URL(`https://www.eventbriteapi.com/v3/organizations/${encodeURIComponent(org)}/events/`);
    u.searchParams.set('status', 'live,started,canceled');
    u.searchParams.set('time_filter', 'current_future');
    u.searchParams.set('expand', 'venue,organizer');
    u.searchParams.set('page_size', '50');
    if (typeof cursor === 'string') u.searchParams.set('continuation', cursor);
    const res = await ctx.fetchText(u.href, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403)
      throw new SourceUnavailable('Eventbrite refused the token, or it cannot see this organisation', 'expired');
    if (res.status !== 200) throw new Error(`Eventbrite answered with HTTP ${res.status}`);
    const body = JSON.parse(res.body) as {
      events?: EbEvent[];
      pagination?: { has_more_items?: boolean; continuation?: string };
    };
    const items: RawEvent[] = [];
    const skipped: Skipped[] = [];
    for (const e of body.events ?? []) {
      const r = eventbriteToRaw(e);
      if ('reason' in r) skipped.push(r);
      else items.push(r);
    }
    const more = body.pagination?.has_more_items && body.pagination.continuation;
    return { items, skipped, ...(more ? { next: body.pagination!.continuation } : {}) };
  },
};
