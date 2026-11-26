import type { APIRoute } from 'astro';
import { FEED_CACHE, badFeedRequest, feedTitle, parseFeedFilters } from '../../lib/calendar/feeds';
import { buildRss } from '../../lib/calendar/rss';
import { env } from '../../lib/env';
import { listAllEvents } from '../../lib/events/query';

export const GET: APIRoute = async ({ url }) => {
  const { filters, errors } = parseFeedFilters(url.searchParams);
  if (Object.keys(errors).length) return badFeedRequest(errors);
  const events = await listAllEvents(filters);
  const body = buildRss(events, {
    title: feedTitle(filters),
    description: 'Upcoming accessibility events from calenda11y.',
    siteUrl: env().SITE_URL,
    selfUrl: url.href,
  });
  return new Response(body, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': FEED_CACHE },
  });
};
