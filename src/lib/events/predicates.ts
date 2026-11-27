/**
 * Event filters: parsing them from a query string, and turning them into
 * conditions on the public_events view. Pagination is separate (query.ts), so
 * feeds and the month grid can reuse the same conditions over the full result
 * set.
 */
import type { FieldErrors } from '../forms/errors.ts';
import {
  ACCESS_LABELS,
  ACCESS_PROVISIONS,
  EVENT_TYPES,
  FORMAT_LABELS,
  FORMATS,
  PRICES,
  TYPE_PLURALS,
  countryName,
  type AccessProvision,
  type EventType,
  type Format,
  type Price,
} from './model.ts';
import { addDays, addMonths, endOfMonth, formatMonthYear, isIsoDate, isIsoMonth } from './dates.ts';

/** The named ranges a URL can ask for. A month is given as `range=YYYY-MM`. */
export const RANGES = ['upcoming', 'this-month', '3-months', 'custom'] as const;
/** 'month' is internal: the URL carries the month itself (`range=2027-01`). */
export type Range = (typeof RANGES)[number] | 'month';

export const ONLINE = 'online';

export interface Filters {
  /** ISO 3166-1 alpha-2 code, or "online" for events you can join online. */
  country?: string;
  formats: Format[];
  /** Any of these types (empty: no type filter). */
  types: EventType[];
  /** Only events whose call for speakers is still open. */
  cfp?: true;
  range: Range;
  /** YYYY-MM, only for range = month. */
  month?: string;
  /** Inclusive local dates, only for range = custom. */
  from?: string;
  to?: string;
  price?: Price;
  access: AccessProvision[];
  q?: string;
  /** 'any' is only used internally (the month grid shows past days too). */
  when: 'upcoming' | 'past' | 'any';
  /** Internal: only events that ended after this instant (used by feeds). */
  since?: string;
  page: number;
}

/** What the visitor typed, for putting back into the form. */
export interface FilterValues {
  country: string;
  formats: string[];
  types: string[];
  cfp: boolean;
  range: string;
  from: string;
  to: string;
  price: string;
  access: string[];
  q: string;
}

export interface ParsedFilters {
  filters: Filters;
  values: FilterValues;
  errors: FieldErrors;
  /** True if any filter was given, so the page can move focus to the results. */
  active: boolean;
}

export const MAX_QUERY_LENGTH = 100;
export const MAX_PAGE = 1000;

export function isCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;
  const name = countryName(code);
  return name !== code && name !== 'Unknown Region';
}

export function parseFilters(params: URLSearchParams): ParsedFilters {
  const errors: FieldErrors = {};
  const values: FilterValues = {
    country: (params.get('country') ?? '').trim(),
    formats: params.getAll('format'),
    types: params.getAll('type'),
    cfp: params.get('cfp') === 'open',
    range: params.get('range') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    price: params.get('price') ?? '',
    access: params.getAll('access'),
    q: (params.get('q') ?? '').trim(),
  };
  const filters: Filters = { formats: [], types: [], range: 'upcoming', access: [], when: 'upcoming', page: 1 };

  if (values.country) {
    const upper = values.country.toUpperCase();
    if (values.country.toLowerCase() === ONLINE) filters.country = ONLINE;
    else if (isCountryCode(upper)) filters.country = upper;
    else errors.country = 'Choose a country from the list';
  }

  for (const f of values.formats) {
    if ((FORMATS as readonly string[]).includes(f)) {
      if (!filters.formats.includes(f as Format)) filters.formats.push(f as Format);
    } else errors.format = 'Choose a format from the list';
  }

  if (values.types.some((t) => !(EVENT_TYPES as readonly string[]).includes(t))) {
    errors.type = 'Choose a type from the list';
  }
  filters.types = EVENT_TYPES.filter((t) => values.types.includes(t));

  const cfp = params.get('cfp');
  if (cfp === 'open') filters.cfp = true;
  else if (cfp !== null && cfp !== '') errors.cfp = 'Choose "Open for speakers" or leave it unticked';

  if (values.range) {
    if ((RANGES as readonly string[]).includes(values.range)) filters.range = values.range as Range;
    else if (isIsoMonth(values.range)) {
      filters.range = 'month';
      filters.month = values.range;
      // Dates left from an earlier search are dropped from the form too, so
      // they can't come back later from inside the closed "More filters".
      values.from = '';
      values.to = '';
    } else errors.range = 'Choose when from the list';
  }

  // A chosen month wins over dates left in the form from an earlier search
  // (without JavaScript, the date fields are always sent).
  if (filters.range !== 'month' && (filters.range === 'custom' || values.from || values.to)) {
    let from: string | undefined;
    let to: string | undefined;
    if (values.from) {
      if (isIsoDate(values.from)) from = values.from;
      else errors.from = 'Enter the start date as a real date, for example 2027-03-14';
    }
    if (values.to) {
      if (isIsoDate(values.to)) to = values.to;
      else errors.to = 'Enter the end date as a real date, for example 2027-03-28';
    }
    if (from && to && from > to) {
      errors.to = 'The end date must be the same as or after the start date';
      to = undefined;
    }
    if (from || to) {
      filters.range = 'custom';
      if (from) filters.from = from;
      if (to) filters.to = to;
    } else if (filters.range === 'custom' && !errors.from && !errors.to) {
      errors.from = 'Enter a start date, an end date, or both';
    }
  }

  if (values.price) {
    if ((PRICES as readonly string[]).includes(values.price)) filters.price = values.price as Price;
    else errors.price = 'Choose free or paid';
  }

  for (const a of values.access) {
    if ((ACCESS_PROVISIONS as readonly string[]).includes(a)) {
      if (!filters.access.includes(a as AccessProvision)) filters.access.push(a as AccessProvision);
    } else errors.access = 'Choose access provisions from the list';
  }

  if (values.q) {
    if (values.q.length > MAX_QUERY_LENGTH) errors.q = `Search for ${MAX_QUERY_LENGTH} characters or fewer`;
    else filters.q = values.q;
  }

  const when = params.get('when');
  if (when === 'past') filters.when = 'past';
  // Past and upcoming together, for a chosen day or days (the month grid's "more" links).
  else if (when === 'any' && filters.range === 'custom') filters.when = 'any';

  const page = params.get('page');
  if (page) {
    const n = Number(page);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_PAGE) filters.page = n;
    else errors.page = 'That page number does not exist';
  }

  const active = ['country', 'format', 'type', 'cfp', 'range', 'from', 'to', 'price', 'access', 'q'].some((k) =>
    params.has(k),
  );
  return { filters, values, errors, active };
}

/** The inclusive local-date window a filter covers, if it has one. */
export function dateWindow(filters: Filters, today: string): { from?: string; to?: string } {
  switch (filters.range) {
    case 'this-month':
      return { from: today, to: endOfMonth(today) };
    case '3-months':
      return { from: today, to: addDays(addMonths(today, 3), -1) };
    case 'month':
      return filters.month ? { from: `${filters.month}-01`, to: endOfMonth(`${filters.month}-01`) } : {};
    case 'custom':
      return { ...(filters.from && { from: filters.from }), ...(filters.to && { to: filters.to }) };
    default:
      return {};
  }
}

/** The subset of the Supabase query builder the predicates use. */
export interface FilterableQuery {
  eq(column: string, value: unknown): this;
  in(column: string, values: readonly unknown[]): this;
  gte(column: string, value: unknown): this;
  lte(column: string, value: unknown): this;
  gt(column: string, value: unknown): this;
  lt(column: string, value: unknown): this;
  overlaps(column: string, values: readonly unknown[]): this;
  textSearch(column: string, query: string, options: { type: 'websearch'; config: string }): this;
}

/** The formats to show after combining the format filter with "online". */
export function effectiveFormats(filters: Filters): Format[] | undefined {
  let formats: Format[] | undefined = filters.formats.length ? [...filters.formats] : undefined;
  if (filters.country === ONLINE) {
    const joinable: Format[] = ['online', 'hybrid'];
    formats = (formats ?? joinable).filter((f) => joinable.includes(f));
  }
  return formats;
}

/** Applies the filters to a query on public_events. `now` is an ISO instant; `today` a date. */
export function applyFilters<Q extends FilterableQuery>(query: Q, filters: Filters, now: string, today: string): Q {
  let q = query;
  if (filters.country && filters.country !== ONLINE) q = q.eq('country_code', filters.country);
  const formats = effectiveFormats(filters);
  if (formats) q = q.in('format', formats);
  if (filters.types.length) q = q.overlaps('types', filters.types);
  // Cancelled events are public too, but their calls aren't open.
  if (filters.cfp) q = q.gt('cfp_closes_at', now).eq('status', 'approved');

  if (filters.when === 'past') q = q.lt('end_instant', now);
  else if (filters.when === 'upcoming') q = q.gt('end_instant', now);
  if (filters.since) q = q.gt('end_instant', filters.since);

  const window = dateWindow(filters, today);
  // Overlap: the event's last day is on or after `from`, and its first day is on or before `to`.
  if (window.from) q = q.gte('local_end_date', window.from);
  if (window.to) q = q.lte('local_start_date', window.to);

  if (filters.price) q = q.eq('price', filters.price);
  for (const a of filters.access) q = q.eq(a, true);
  if (filters.q) q = q.textSearch('search', filters.q, { type: 'websearch', config: 'simple' });
  return q;
}

/** Builds a query string for the given filters (used for pagination links and feeds). */
export function filtersToParams(
  filters: Filters,
  overrides: { page?: number; includePage?: boolean } = {},
): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.country) p.set('country', filters.country);
  for (const f of filters.formats) p.append('format', f);
  for (const t of filters.types) p.append('type', t);
  if (filters.cfp) p.set('cfp', 'open');
  if (filters.range === 'month') {
    if (filters.month) p.set('range', filters.month);
  } else if (filters.range !== 'upcoming') p.set('range', filters.range);
  if (filters.range === 'custom') {
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
  }
  if (filters.price) p.set('price', filters.price);
  for (const a of filters.access) p.append('access', a);
  if (filters.q) p.set('q', filters.q);
  if (filters.when === 'past' || filters.when === 'any') p.set('when', filters.when);
  const page = overrides.page ?? filters.page;
  if (overrides.includePage !== false && page > 1) p.set('page', String(page));
  return p;
}

/** A plain-language description of the filters, e.g. "online events with live captions". */
export function describeFilters(filters: Filters): string {
  const parts: string[] = [];
  const formats = filters.formats.map((f) => FORMAT_LABELS[f].toLowerCase());
  const kinds = filters.types.length ? filters.types.map((t) => TYPE_PLURALS[t]).join(' or ') : 'events';
  const subject = filters.price ? `${filters.price} ${kinds}` : kinds;
  let text = formats.length ? `${formats.join(' or ')} ${subject}` : subject;
  if (filters.country === ONLINE) text = `${text} you can join online`;
  else if (filters.country) text = `${text} in ${countryName(filters.country)}`;
  parts.push(text);
  if (filters.access.length)
    parts.push(`with ${filters.access.map((a) => ACCESS_LABELS[a].toLowerCase()).join(' and ')}`);
  if (filters.cfp) parts.push('with an open call for speakers');
  if (filters.q) parts.push(`matching “${filters.q}”`);
  const window =
    filters.range === 'custom'
      ? [filters.from && `from ${filters.from}`, filters.to && `to ${filters.to}`].filter(Boolean).join(' ')
      : filters.range === 'month' && filters.month
        ? `in ${formatMonthYear(filters.month)}`
        : '';
  if (window) parts.push(window);
  const result = parts.join(' ');
  return result === 'events' ? 'all events' : result;
}
