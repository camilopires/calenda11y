/**
 * The "calls for speakers" calendar: one all-day entry on the last day to
 * apply for each call. It has its own UIDs, so it can sit next to an event
 * feed without clashing, and SEQUENCE follows the event's, so a changed
 * deadline updates in place. Calls that are removed, or whose event is
 * cancelled, simply leave the feed; subscribed calendars treat that as
 * removal.
 */
import { addDays, formatLongDate } from '../events/dates.ts';
import type { PublicEvent } from '../events/model.ts';
import {
  UID_DOMAIN,
  calendarDocument,
  categoriesLine,
  dateStamp,
  escapeText,
  eventLocation,
  eventPageUrl,
  utcStamp,
  type CalendarOptions,
} from './ics.ts';

function cfpEvent(e: PublicEvent, siteUrl: string): string[] {
  if (!e.cfp_url || !e.cfp_last_day) return [];
  const summary = e.cfp_capped
    ? `Call for speakers closes when the event starts: ${e.title}`
    : `Call for speakers closes: ${e.title}`;
  const description = [
    `Apply to speak at ${e.title}: ${e.cfp_url}`,
    `The event: ${formatLongDate(e.local_start_date)}, ${eventLocation(e)}.`,
    `Details on calenda11y: ${eventPageUrl(siteUrl, e.slug)}`,
  ].join('\n\n');
  return [
    'BEGIN:VEVENT',
    `UID:cfp-${e.id}@${UID_DOMAIN}`,
    `DTSTAMP:${utcStamp(e.updated_at)}`,
    `LAST-MODIFIED:${utcStamp(e.updated_at)}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTART;VALUE=DATE:${dateStamp(e.cfp_last_day)}`,
    `DTEND;VALUE=DATE:${dateStamp(addDays(e.cfp_last_day, 1))}`,
    `SUMMARY${e.lang ? `;LANGUAGE=${e.lang}` : ''}:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    ...categoriesLine(e),
    // A URL value can't be escaped like text, so control characters are removed:
    // a line break would otherwise start a new property.
    `URL:${e.cfp_url.replace(/[\u0000-\u001f\u007f]/g, '')}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
  ];
}

export function buildCfpCalendar(events: readonly PublicEvent[], options: CalendarOptions): string {
  return calendarDocument(
    options,
    events.flatMap((e) => cfpEvent(e, options.siteUrl)),
  );
}
