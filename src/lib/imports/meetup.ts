/**
 * Meetup. Needs API access from Meetup (normally via Meetup Pro) and an OAuth
 * token. Until then the source shows as unavailable; public Meetup groups
 * can be added as iCalendar sources instead.
 *
 * Meetup's GraphQL schema changes over time. If a run fails with a GraphQL
 * error, compare SEARCH_QUERY with the schema (https://www.meetup.com/api/schema).
 * GraphQL errors are treated as failures even when the HTTP status is 200.
 */
import { SourceUnavailable, type Adapter, type RawEvent, type SourceConfig } from './types.ts';

export const MEETUP_GQL = 'https://api.meetup.com/gql-ext';
export const MEETUP_TOKEN_URL = 'https://secure.meetup.com/oauth2/access';

export const SEARCH_QUERY = `query Search($query: String!, $after: String) {
  eventSearch(filter: { query: $query }, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { id title description eventUrl dateTime endTime status eventType venue { city country address } group { name } } }
  }
}`;

interface MeetupNode {
  id: string;
  title?: string;
  description?: string;
  eventUrl?: string;
  dateTime?: string;
  endTime?: string;
  status?: string;
  eventType?: string;
  venue?: { city?: string; country?: string; address?: string } | null;
  group?: { name?: string } | null;
}

export function meetupToRaw(n: MeetupNode): RawEvent | null {
  if (!n.dateTime) return null;
  const starts = new Date(n.dateTime).toISOString();
  return {
    source_uid: n.id,
    title: n.title ?? '',
    description: n.description ?? null,
    url: n.eventUrl ?? null,
    organiser: n.group?.name ?? null,
    all_day: false,
    starts_at: starts,
    ends_at: n.endTime ? new Date(n.endTime).toISOString() : new Date(Date.parse(starts) + 2 * 3600_000).toISOString(),
    location: n.venue?.address ?? null,
    city: n.venue?.city ?? null,
    country_code: n.venue?.country ?? null,
    online: n.eventType === 'ONLINE' ? true : n.eventType === 'PHYSICAL' ? false : null,
    cancelled: n.status === 'CANCELLED',
  };
}

async function freshToken(
  config: SourceConfig,
  ctx: Parameters<Adapter['fetchPage']>[2],
): Promise<{ token: string; update?: Partial<SourceConfig> }> {
  const expires = config.access_token_expires_at ? Date.parse(config.access_token_expires_at) : 0;
  if (config.access_token && expires > ctx.now.getTime() + 60_000) return { token: config.access_token };
  if (!config.refresh_token || !ctx.env.MEETUP_CLIENT_ID || !ctx.env.MEETUP_CLIENT_SECRET) {
    if (config.access_token && !config.access_token_expires_at) return { token: config.access_token };
    throw new SourceUnavailable(
      'Meetup needs API access: add an OAuth refresh token and set MEETUP_CLIENT_ID and MEETUP_CLIENT_SECRET',
      'missing',
    );
  }
  const res = await ctx.fetchText(MEETUP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ctx.env.MEETUP_CLIENT_ID,
      client_secret: ctx.env.MEETUP_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: config.refresh_token,
    }).toString(),
  });
  if (res.status !== 200)
    throw new SourceUnavailable(
      `Meetup would not refresh the token (HTTP ${res.status}). Connect the account again`,
      'expired',
    );
  const body = JSON.parse(res.body) as { access_token: string; refresh_token?: string; expires_in?: number };
  const update: Partial<SourceConfig> = {
    access_token: body.access_token,
    access_token_expires_at: new Date(ctx.now.getTime() + (body.expires_in ?? 3600) * 1000).toISOString(),
    ...(body.refresh_token && { refresh_token: body.refresh_token }),
  };
  return { token: body.access_token, update };
}

export const meetupAdapter: Adapter = {
  async fetchPage(source, cursor, ctx) {
    const { token, update } = await freshToken(source.config, ctx);
    const res = await ctx.fetchText(MEETUP_GQL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { query: source.config.query ?? 'accessibility', after: typeof cursor === 'string' ? cursor : null },
      }),
    });
    if (res.status === 401 || res.status === 403) throw new SourceUnavailable('Meetup refused the token', 'expired');
    if (res.status !== 200) throw new Error(`Meetup answered with HTTP ${res.status}`);
    const body = JSON.parse(res.body) as {
      data?: {
        eventSearch?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; edges?: Array<{ node: MeetupNode }> };
      };
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) throw new Error(`Meetup GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
    const search = body.data?.eventSearch;
    if (!search) throw new Error('Meetup returned no eventSearch result');
    const items: RawEvent[] = [];
    const skipped = [];
    for (const { node } of search.edges ?? []) {
      const r = meetupToRaw(node);
      if (r) items.push(r);
      else skipped.push({ uid: node.id, reason: 'It has no start time' });
    }
    return {
      items,
      skipped,
      ...(search.pageInfo?.hasNextPage && search.pageInfo.endCursor ? { next: search.pageInfo.endCursor } : {}),
      ...(update && { configUpdate: update }),
    };
  },
};
