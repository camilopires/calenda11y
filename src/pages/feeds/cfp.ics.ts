import type { APIRoute } from 'astro';
import { badFeedRequest, cfpIcsResponse, parseFeedFilters } from '../../lib/calendar/feeds';

/** Calls-for-speakers deadlines: /feeds/cfp.ics?country=GB&type=conference */
export const GET: APIRoute = ({ url }) => {
  const { filters, errors } = parseFeedFilters(url.searchParams);
  if (Object.keys(errors).length) return badFeedRequest(errors);
  return cfpIcsResponse(filters);
};
