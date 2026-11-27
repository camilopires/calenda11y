import type { APIRoute } from 'astro';
import { badFeedRequest, icsResponse, parseFeedFilters } from '../../lib/calendar/feeds';

/** Every event, or any filters given: /feeds/all.ics?topic=testing */
export const GET: APIRoute = ({ url }) => {
  const { filters, errors } = parseFeedFilters(url.searchParams);
  if (Object.keys(errors).length) return badFeedRequest(errors);
  return icsResponse(filters);
};
