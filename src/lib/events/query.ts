/** Reading published events. Only ever reads the public_* views. */
import { db } from '../db.ts';
import { unwrap, unwrapMaybe } from '../result.ts';
import { todayUtc } from './dates.ts';
import { PUBLIC_EVENT_COLUMNS, type EventTopic, type PublicEvent } from './model.ts';
import { applyFilters, type Filters } from './predicates.ts';

export const PAGE_SIZE = 30;
/** Rows fetched per request when reading a complete result set. */
export const CHUNK_SIZE = 1000;
/** A hard ceiling for complete result sets (feeds, grid), well above realistic sizes. */
export const MAX_COMPLETE_ROWS = 20_000;

export interface Clock {
  now: string;
  today: string;
}

export function clock(at: Date = new Date()): Clock {
  return { now: at.toISOString(), today: todayUtc(at) };
}

export interface EventPage {
  events: PublicEvent[];
  total: number;
  page: number;
  pages: number;
}

function baseQuery(filters: Filters, c: Clock, count = false) {
  const q = db()
    .from('public_events')
    .select(PUBLIC_EVENT_COLUMNS, count ? { count: 'exact' } : undefined);
  return applyFilters(q, filters, c.now, c.today);
}

const ascending = (filters: Filters) => filters.when !== 'past';

/** One page of events matching the filters. */
export async function listEvents(filters: Filters, c: Clock = clock()): Promise<EventPage> {
  const from = (filters.page - 1) * PAGE_SIZE;
  const result = await baseQuery(filters, c, true)
    .order('start_instant', { ascending: ascending(filters) })
    .order('id', { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  // PostgREST answers 416 when the page is past the end; treat that as an empty page.
  if (result.error && result.status === 416) {
    return { events: [], total: result.count ?? 0, page: filters.page, pages: 0 };
  }
  const events = unwrap(result, 'supabase', 'listing events') as unknown as PublicEvent[];
  const total = result.count ?? events.length;
  return { events, total, page: filters.page, pages: Math.ceil(total / PAGE_SIZE) };
}

/**
 * Every event matching the filters, read in chunks so nothing is cut off by
 * the API's row limit. Ordered by start time, then id, so chunks never overlap.
 */
export async function listAllEvents(filters: Filters, c: Clock = clock()): Promise<PublicEvent[]> {
  const out: PublicEvent[] = [];
  for (let offset = 0; offset < MAX_COMPLETE_ROWS; offset += CHUNK_SIZE) {
    const rows = unwrap(
      await baseQuery(filters, c)
        .order('start_instant', { ascending: ascending(filters) })
        .order('id', { ascending: true })
        .range(offset, offset + CHUNK_SIZE - 1),
      'supabase',
      'reading all events',
    ) as unknown as PublicEvent[];
    out.push(...rows);
    if (rows.length < CHUNK_SIZE) return out;
  }
  throw new Error(`More than ${MAX_COMPLETE_ROWS} events matched; refusing to return a truncated list`);
}

export async function getEventBySlug(slug: string): Promise<PublicEvent | null> {
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) return null;
  return unwrapMaybe(
    await db().from('public_events').select(PUBLIC_EVENT_COLUMNS).eq('slug', slug).maybeSingle(),
    'supabase',
    'reading event',
  ) as unknown as PublicEvent | null;
}

export interface CountryCount {
  country_code: string;
  upcoming: number;
}

export async function countryCounts(): Promise<CountryCount[]> {
  return unwrap(
    await db().from('public_country_counts').select('country_code,upcoming').order('country_code'),
    'supabase',
    'counting countries',
  ) as CountryCount[];
}

export interface TopicCount {
  topic: EventTopic;
  upcoming: number;
}

/** Upcoming events per topic (published and cancelled, as topic pages list them). */
export async function topicCounts(): Promise<Map<EventTopic, number>> {
  const rows = unwrap(
    await db().from('public_topic_counts').select('topic,upcoming'),
    'supabase',
    'counting topics',
  ) as TopicCount[];
  return new Map(rows.map((r) => [r.topic, r.upcoming]));
}
