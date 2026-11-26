import type { APIRoute } from 'astro';
import { icsResponse } from '../../lib/calendar/feeds';
import { parseFilters } from '../../lib/events/predicates';

export const GET: APIRoute = () => icsResponse(parseFilters(new URLSearchParams()).filters);
