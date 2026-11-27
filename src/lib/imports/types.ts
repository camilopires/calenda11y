/** Shared types for import adapters. */
import type { Format, Price } from '../events/model.ts';

export type SourceType = 'ics' | 'rss' | 'luma' | 'eventbrite' | 'meetup';

/** What an admin configures for a source. Each adapter reads the fields it needs. */
export interface SourceConfig {
  url?: string;
  /** Used when a feed gives times without a time zone ("floating" times). */
  default_timezone?: string;
  /** Used for in-person events when the feed doesn't say which country. */
  default_country?: string;
  lang?: string;
  organisation_id?: string;
  token?: string;
  calendar_id?: string;
  query?: string;
  access_token?: string;
  refresh_token?: string;
  access_token_expires_at?: string;
}

export interface ImportSource {
  id: string;
  type: SourceType;
  name: string;
  config: SourceConfig;
  enabled: boolean;
}

/** One event as a source describes it, before checks. */
export interface RawEvent {
  source_uid: string;
  title: string;
  description?: string | null;
  url?: string | null;
  organiser?: string | null;
  all_day: boolean;
  /** UTC instants for timed events. */
  starts_at?: string | null;
  ends_at?: string | null;
  /** Dates for all-day events; end exclusive. */
  start_date?: string | null;
  end_date?: string | null;
  timezone?: string | null;
  location?: string | null;
  city?: string | null;
  country_code?: string | null;
  online?: boolean | null;
  free?: boolean | null;
  cancelled?: boolean;
}

/** A checked event, ready for import_upsert. */
export interface ImportedEvent {
  source_uid: string;
  cancelled: boolean;
  fields: {
    title: string;
    summary: string;
    description: string | null;
    lang: string;
    organiser: string | null;
    url: string | null;
    all_day: boolean;
    starts_at: string | null;
    ends_at: string | null;
    start_date: string | null;
    end_date: string | null;
    timezone: string;
    format: Format;
    country_code: string | null;
    city: string | null;
    venue: string | null;
    price: Price;
  };
}

export interface Skipped {
  uid: string;
  reason: string;
}

export interface FetchPage {
  items: RawEvent[];
  skipped: Skipped[];
  /** Set when there are more pages to fetch. */
  next?: unknown;
  /** New credentials to save on the source (e.g. a refreshed OAuth token). */
  configUpdate?: Partial<SourceConfig>;
}

export interface AdapterContext {
  now: Date;
  /** Fetches text from a URL, safely (see fetch.ts). Injected so tests can use fixtures. */
  fetchText: (
    url: string,
    init?: { headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string },
  ) => Promise<{ status: number; body: string; contentType: string }>;
  env: {
    LUMA_API_KEY?: string | undefined;
    MEETUP_CLIENT_ID?: string | undefined;
    MEETUP_CLIENT_SECRET?: string | undefined;
  };
}

export class SourceUnavailable extends Error {
  readonly credentials: 'missing' | 'expired' | 'unavailable';
  constructor(message: string, credentials: 'missing' | 'expired' | 'unavailable') {
    super(message);
    this.name = 'SourceUnavailable';
    this.credentials = credentials;
  }
}

export interface Adapter {
  fetchPage(source: ImportSource, cursor: unknown, ctx: AdapterContext): Promise<FetchPage>;
}

/** Limits that keep one feed from using unbounded time or space. */
export const IMPORT_LIMITS = {
  maxItemsPerRun: 5000,
  maxOccurrencesPerSeries: 200,
  horizonDays: 366,
  /** Only events that end after this many days ago are imported. */
  keepEndedDays: 1,
} as const;
