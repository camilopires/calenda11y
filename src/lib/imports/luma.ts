/**
 * Luma. Public Luma calendars publish an iCalendar feed, which needs no key:
 * set the source's `url` to it. With a Luma Plus API key (LUMA_API_KEY) and a
 * calendar the key belongs to, the API is used instead.
 *
 * The API's entries have moved from `{ event: {...} }` to top-level fields,
 * so both shapes are read.
 */
import { icsAdapter } from './ics.ts';
import { SourceUnavailable, type Adapter, type RawEvent, type Skipped } from './types.ts';

export const LUMA_API = 'https://public-api.luma.com/v1/calendar/list-events';

interface LumaEvent {
  api_id?: string;
  id?: string;
  name?: string;
  description?: string;
  description_md?: string;
  start_at?: string;
  end_at?: string;
  timezone?: string;
  url?: string;
  meeting_url?: string | null;
  geo_address_json?: { city?: string; country_code?: string; full_address?: string } | null;
  status?: string;
}

export function lumaEntry(entry: Record<string, unknown>): LumaEvent {
  return (entry.event as LumaEvent | undefined) ?? (entry as LumaEvent);
}

export const lumaAdapter: Adapter = {
  async fetchPage(source, cursor, ctx) {
    if (!ctx.env.LUMA_API_KEY) {
      if (source.config.url) return icsAdapter.fetchPage(source, cursor, ctx);
      throw new SourceUnavailable(
        "Add the calendar's iCalendar address, or set LUMA_API_KEY (needs Luma Plus)",
        'missing',
      );
    }
    const u = new URL(LUMA_API);
    u.searchParams.set('after', ctx.now.toISOString());
    u.searchParams.set('pagination_limit', '50');
    if (typeof cursor === 'string') u.searchParams.set('pagination_cursor', cursor);
    const res = await ctx.fetchText(u.href, {
      headers: { 'x-luma-api-key': ctx.env.LUMA_API_KEY, accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) throw new SourceUnavailable('Luma refused the API key', 'expired');
    if (res.status !== 200) throw new Error(`Luma answered with HTTP ${res.status}`);
    const body = JSON.parse(res.body) as {
      entries?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string;
    };
    const items: RawEvent[] = [];
    const skipped: Skipped[] = [];
    for (const entry of body.entries ?? []) {
      const e = lumaEntry(entry);
      const uid = e.api_id ?? e.id;
      if (!uid || !e.start_at) {
        skipped.push({ uid: uid ?? '(no id)', reason: 'It has no id or start time' });
        continue;
      }
      items.push({
        source_uid: uid,
        title: e.name ?? '',
        description: e.description_md ?? e.description ?? null,
        url: e.url ?? null,
        all_day: false,
        starts_at: e.start_at,
        ends_at: e.end_at ?? new Date(Date.parse(e.start_at) + 3600_000).toISOString(),
        timezone: e.timezone ?? null,
        location: e.geo_address_json?.full_address ?? null,
        city: e.geo_address_json?.city ?? null,
        country_code: e.geo_address_json?.country_code ?? null,
        online: !e.geo_address_json && !!e.meeting_url ? true : e.geo_address_json ? false : null,
        cancelled: e.status === 'cancelled',
      });
    }
    return { items, skipped, ...(body.has_more && body.next_cursor ? { next: body.next_cursor } : {}) };
  },
};
