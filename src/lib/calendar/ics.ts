/**
 * An RFC 5545 iCalendar writer for published events.
 *
 * - Timed events are written in UTC (…Z), so no VTIMEZONE is needed; calendar
 *   apps show them in the viewer's time zone. The event's own time zone is
 *   named in the description.
 * - All-day events use VALUE=DATE with an exclusive DTEND.
 * - UID is stable for the life of an event, and SEQUENCE goes up whenever a
 *   published event changes (a database trigger does that), so subscribed
 *   calendars update instead of duplicating.
 * - Lines end in CRLF and are folded at 75 octets without splitting a UTF-8
 *   character.
 */
import { TYPE_LABELS, countryName, type PublicEvent } from '../events/model.ts';
import { zoneCity } from '../events/dates.ts';
import { cfpDeadline } from '../events/cfp.ts';

export const UID_DOMAIN = 'calenda11y.org';
export const PRODID = '-//calenda11y//calenda11y.org//EN';
const CRLF = '\r\n';
const MAX_OCTETS = 75;

/** Escapes a TEXT value (RFC 5545 §3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const encoder = new TextEncoder();

/** Folds a content line to at most 75 octets per line (RFC 5545 §3.1). */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line;
  const out: string[] = [];
  let current = '';
  let octets = 0;
  // Continuation lines start with a space, which counts towards their 75 octets.
  let limit = MAX_OCTETS;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > limit) {
      out.push(current);
      current = ' ';
      octets = 1;
      limit = MAX_OCTETS;
    }
    current += char;
    octets += size;
  }
  out.push(current);
  return out.join(CRLF);
}

/** 2026-12-01T15:00:00.000Z → 20261201T150000Z */
export function utcStamp(instant: string): string {
  return new Date(instant)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** 2026-12-01 → 20261201 */
export function dateStamp(date: string): string {
  return date.replace(/-/g, '');
}

export function eventLocation(e: Pick<PublicEvent, 'format' | 'venue' | 'city' | 'country_code'>): string {
  if (e.format === 'online') return 'Online';
  const place = [e.venue, e.city, e.country_code ? countryName(e.country_code) : null].filter(Boolean).join(', ');
  return e.format === 'hybrid' ? `${place} (and online)` : place;
}

export function eventPageUrl(siteUrl: string, slug: string): string {
  return new URL(`/events/${slug}`, siteUrl).href;
}

export function eventDescription(e: PublicEvent, siteUrl: string): string {
  const parts = [e.summary];
  if (e.description) parts.push(e.description);
  if (!e.all_day) parts.push(`Times are for ${zoneCity(e.timezone)} (${e.timezone}).`);
  if (e.url) parts.push(`Event website: ${e.url}`);
  const cfp = cfpDeadline(e);
  if (cfp) parts.push(`${cfp}: ${e.cfp_url}`);
  parts.push(`Details on calenda11y: ${eventPageUrl(siteUrl, e.slug)}`);
  return parts.join('\n\n');
}

function vevent(e: PublicEvent, siteUrl: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.id}@${UID_DOMAIN}`,
    `DTSTAMP:${utcStamp(e.updated_at)}`,
    `LAST-MODIFIED:${utcStamp(e.updated_at)}`,
    `SEQUENCE:${e.sequence}`,
  ];
  if (e.all_day && e.start_date && e.end_date) {
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.start_date)}`, `DTEND;VALUE=DATE:${dateStamp(e.end_date)}`);
  } else if (e.starts_at && e.ends_at) {
    lines.push(`DTSTART:${utcStamp(e.starts_at)}`, `DTEND:${utcStamp(e.ends_at)}`);
  } else {
    throw new Error(`Event ${e.id} has no usable start and end`);
  }
  lines.push(
    `SUMMARY${e.lang ? `;LANGUAGE=${e.lang}` : ''}:${escapeText(e.status === 'cancelled' ? `Cancelled: ${e.title}` : e.title)}`,
    `DESCRIPTION:${escapeText(eventDescription(e, siteUrl))}`,
    `LOCATION:${escapeText(eventLocation(e))}`,
    `URL:${eventPageUrl(siteUrl, e.slug)}`,
    // Each type is one value; the commas between them are list separators, not text.
    ...(e.types.length ? [`CATEGORIES:${e.types.map((t) => escapeText(TYPE_LABELS[t])).join(',')}`] : []),
    `STATUS:${e.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
  );
  return lines;
}

export interface CalendarOptions {
  name: string;
  description?: string;
  siteUrl: string;
}

export function buildCalendar(events: readonly PublicEvent[], options: CalendarOptions): string {
  return calendarDocument(
    options,
    events.flatMap((e) => vevent(e, options.siteUrl)),
  );
}

/** Wraps VEVENT lines in a complete, folded calendar. */
export function calendarDocument(options: Omit<CalendarOptions, 'siteUrl'>, vevents: string[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.name)}`,
    ...(options.description ? [`X-WR-CALDESC:${escapeText(options.description)}`] : []),
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    ...vevents,
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
