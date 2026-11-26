import type { APIRoute } from 'astro';
import { badFeedRequest, icsResponse, parseFeedFilters } from '../../lib/calendar/feeds';

/** /feeds/PT.ics, /feeds/online.ics */
export const GET: APIRoute = ({ params }) => {
  const { filters, errors } = parseFeedFilters(new URLSearchParams({ country: params.country ?? '' }));
  if (Object.keys(errors).length || !filters.country) return badFeedRequest(errors);
  return icsResponse(filters);
};
