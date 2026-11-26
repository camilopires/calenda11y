/** "Add to calendar" links for Google Calendar and Outlook. Apple and others use the .ics file. */
import type { PublicEvent } from '../events/model.ts';
import { dateStamp, eventDescription, eventLocation, utcStamp } from './ics.ts';

/** Keeps URLs a sensible length; the full description is in the .ics file. */
const MAX_DETAILS = 1500;

function details(e: PublicEvent, siteUrl: string): string {
  const text = eventDescription(e, siteUrl);
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS - 1)}…` : text;
}

export function googleCalendarUrl(e: PublicEvent, siteUrl: string): string {
  const dates =
    e.all_day && e.start_date && e.end_date
      ? `${dateStamp(e.start_date)}/${dateStamp(e.end_date)}`
      : `${utcStamp(e.starts_at!)}/${utcStamp(e.ends_at!)}`;
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates,
    details: details(e, siteUrl),
    location: eventLocation(e),
  });
  if (!e.all_day) p.set('ctz', e.timezone);
  return `https://calendar.google.com/calendar/render?${p}`;
}

function outlookUrl(host: string, e: PublicEvent, siteUrl: string): string {
  const p = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: e.title,
    body: details(e, siteUrl),
    location: eventLocation(e),
  });
  if (e.all_day && e.start_date && e.end_date) {
    p.set('startdt', e.start_date);
    p.set('enddt', e.end_date);
    p.set('allday', 'true');
  } else {
    p.set('startdt', new Date(e.starts_at!).toISOString());
    p.set('enddt', new Date(e.ends_at!).toISOString());
    p.set('allday', 'false');
  }
  return `https://${host}/calendar/0/action/compose?${p}`;
}

/** Outlook.com and Hotmail (personal Microsoft accounts). */
export function outlookComUrl(e: PublicEvent, siteUrl: string): string {
  return outlookUrl('outlook.live.com', e, siteUrl);
}

/** Microsoft 365 (work and school accounts). */
export function office365Url(e: PublicEvent, siteUrl: string): string {
  return outlookUrl('outlook.office.com', e, siteUrl);
}

/** Turns an https feed URL into a webcal:// URL, which opens calendar apps directly. */
export function webcalUrl(httpsUrl: string): string {
  return httpsUrl.replace(/^https?:\/\//, 'webcal://');
}
