import type { APIRoute } from 'astro';
import { badFeedRequest, icsResponse, parseFeedFilters } from '../../lib/calendar/feeds';

/** A feed for any filters: /feeds/events.ics?country=GB&format=online */
export const GET: APIRoute = ({ url }) => {
  const { filters, errors } = parseFeedFilters(url.searchParams);
  if (Object.keys(errors).length) return badFeedRequest(errors);
  return icsResponse(filters);
};
