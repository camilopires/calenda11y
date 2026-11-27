import type { APIRoute } from 'astro';
import { buildChangesRss, newFeedEntries } from '../../lib/alerts/feed';
import { FEED_CACHE, badFeedRequest, feedTitle, parseFeedFilters } from '../../lib/calendar/feeds';
import { env } from '../../lib/env';

/** Events added or changed in the last 30 days: /feeds/new.rss?country=GB&topic=testing */
export const GET: APIRoute = async ({ url }) => {
  const { filters, errors } = parseFeedFilters(url.searchParams);
  if (Object.keys(errors).length) return badFeedRequest(errors);
  const body = buildChangesRss(await newFeedEntries(filters), {
    title: `${feedTitle(filters)} (added and changed)`,
    description: 'Accessibility events added or changed on calenda11y in the last 30 days.',
    siteUrl: env().SITE_URL,
    selfUrl: url.href,
  });
  return new Response(body, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': FEED_CACHE },
  });
};
