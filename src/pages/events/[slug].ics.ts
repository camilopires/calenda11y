import type { APIRoute } from 'astro';
import { FEED_CACHE } from '../../lib/calendar/feeds';
import { buildCalendar } from '../../lib/calendar/ics';
import { env } from '../../lib/env';
import { getEventBySlug } from '../../lib/events/query';

/** A single event as an .ics file, for Apple Calendar and anything else that opens .ics files. */
export const GET: APIRoute = async ({ params }) => {
  const event = await getEventBySlug(params.slug ?? '');
  if (!event) return new Response('Event not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  const body = buildCalendar([event], { name: event.title, siteUrl: env().SITE_URL });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${event.slug}.ics"`,
      'Cache-Control': FEED_CACHE,
    },
  });
};
