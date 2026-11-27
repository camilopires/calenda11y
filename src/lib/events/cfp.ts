/**
 * Calls for speakers: whether one is open, and how to describe it.
 *
 * The database works out the real deadline (cfp_closes_at): the end of the
 * chosen day in the event's time zone, or the event's start if that's
 * sooner or there's no date. cfpClosesAt repeats that rule for the check
 * page, before anything is saved; an integration test keeps the two equal.
 */
import { addDays, formatLongDate } from './dates.ts';
import type { PublicEvent } from './model.ts';
import { zonedTimeToUtc } from './tz.ts';

const SOON_MS = 7 * 86_400_000;

export interface CfpStatus {
  state: 'open' | 'soon' | 'closed';
  /** The local day the call really ends. */
  lastDay: string;
  /** It closes when the event starts, not at the end of a chosen day. */
  capped: boolean;
}

type CfpEvent = Pick<
  PublicEvent,
  'status' | 'end_instant' | 'cfp_url' | 'cfp_closes_at' | 'cfp_last_day' | 'cfp_capped'
>;

/** Null when there's no call, the event has ended, or it was cancelled. */
export function cfpStatus(e: CfpEvent, now: Date): CfpStatus | null {
  if (!e.cfp_url || !e.cfp_closes_at || !e.cfp_last_day) return null;
  if (e.status === 'cancelled' || Date.parse(e.end_instant) <= now.getTime()) return null;
  const left = Date.parse(e.cfp_closes_at) - now.getTime();
  const state = left <= 0 ? 'closed' : left <= SOON_MS ? 'soon' : 'open';
  return { state, lastDay: e.cfp_last_day, capped: !!e.cfp_capped };
}

const shortDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const short = (date: string) => shortDay.format(new Date(`${date}T12:00:00Z`));

/** The badge text on event cards. */
export function cfpBadge(s: CfpStatus): string {
  if (s.state === 'closed') return 'Call for speakers closed';
  if (s.capped) return s.state === 'soon' ? 'Call for speakers closes soon' : 'Call for speakers open until the event';
  return s.state === 'soon'
    ? `Call for speakers closes soon: ${short(s.lastDay)}`
    : `Call for speakers open until ${short(s.lastDay)}`;
}

/** The sentence on the event page, with the date written in full. */
export function cfpSentence(e: CfpEvent, now: Date): string | null {
  const s = cfpStatus(e, now);
  if (!s) return null;
  if (s.state === 'closed') return `The call for speakers closed on ${formatLongDate(s.lastDay)}.`;
  return s.capped
    ? 'The call for speakers is open until the event starts.'
    : `The call for speakers is open until the end of ${formatLongDate(s.lastDay)}.`;
}

/** Wording for feeds and emails: it never changes by itself as days pass. */
export function cfpDeadline(e: Pick<PublicEvent, 'cfp_url' | 'cfp_last_day' | 'cfp_capped'>): string | null {
  if (!e.cfp_url) return null;
  if (e.cfp_capped || !e.cfp_last_day) return 'Call for speakers: apply before the event starts';
  return `Call for speakers: apply by ${formatLongDate(e.cfp_last_day)}`;
}

/** Local midnight in a zone; a midnight skipped by a clock change moves to the next valid hour, as Postgres does. */
function startOfLocalDay(date: string, timeZone: string): number {
  for (const time of ['00:00', '01:00', '02:00']) {
    const r = zonedTimeToUtc(date, time, timeZone);
    if (r.ok) return Date.parse(r.instant);
  }
  throw new Error(`No valid start of ${date} in ${timeZone}`);
}

export interface CfpDeadline {
  at: string;
  lastDay: string;
  capped: boolean;
}

/** The database's deadline rule, for an event that hasn't been saved yet. */
export function cfpClosesAt(r: {
  cfp_url: string | null;
  cfp_closes_on: string | null;
  timezone: string;
  all_day: boolean;
  starts_at: string | null;
  start_date: string | null;
}): CfpDeadline | null {
  if (!r.cfp_url) return null;
  const start = r.all_day ? startOfLocalDay(r.start_date!, r.timezone) : Date.parse(r.starts_at!);
  const end = r.cfp_closes_on ? startOfLocalDay(addDays(r.cfp_closes_on, 1), r.timezone) : start;
  const at = Math.min(end, start);
  const lastDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: r.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at - 1));
  // Capped only when the start really cuts the call short (or there's no date).
  return { at: new Date(at).toISOString(), lastDay, capped: end > start || !r.cfp_closes_on };
}
