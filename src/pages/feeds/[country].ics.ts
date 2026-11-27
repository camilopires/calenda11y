import type { APIRoute } from 'astro';
import { badFeedRequest, icsResponse, parseFeedFilters } from '../../lib/calendar/feeds';

/** /feeds/PT.ics, /feeds/online.ics, with any other filters (?topic=testing). The country always comes from the address. */
export const GET: APIRoute = ({ params, url }) => {
  const query = new URLSearchParams(url.searchParams);
  query.set('country', params.country ?? '');
  const { filters, errors } = parseFeedFilters(query);
  if (Object.keys(errors).length || !filters.country) return badFeedRequest(errors);
  return icsResponse(filters);
};
