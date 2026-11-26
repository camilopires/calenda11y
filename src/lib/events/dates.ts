/**
 * Date helpers. Calendar dates are handled as `YYYY-MM-DD` strings and
 * computed in UTC, so the server's own time zone never matters. Event times
 * are always shown in the event's own time zone.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;

function toUtc(date: string): Date {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2200) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function isIsoMonth(value: string): boolean {
  const m = ISO_MONTH.exec(value);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1900 && Number(m[1]) <= 2200;
}

export function todayUtc(now: Date = new Date()): string {
  return fromUtc(now);
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** Adds months, clamping the day to the end of the target month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const d = toUtc(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fromUtc(d);
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: string): string {
  const d = toUtc(startOfMonth(date));
  return fromUtc(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function shiftMonth(month: string, by: number): string {
  return monthOf(addMonths(`${month}-01`, by));
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date: string): number {
  return (toUtc(date).getUTCDay() + 6) % 7;
}

/** Every date from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const LOCALE = 'en-GB';

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', ...opts });

const longMonth = fmt({ month: 'long' });
const monthYear = fmt({ month: 'long', year: 'numeric' });
const shortWeekday = fmt({ weekday: 'short' });
const shortMonth = fmt({ month: 'short' });
const longWeekday = fmt({ weekday: 'long' });

/** "Thursday 3 December 2026". Built from parts so it doesn't depend on the ICU version. */
export function formatLongDate(date: string): string {
  const d = toUtc(date);
  return `${longWeekday.format(d)} ${d.getUTCDate()} ${longMonth.format(d)} ${d.getUTCFullYear()}`;
}

export function formatMonthYear(dateOrMonth: string): string {
  return monthYear.format(toUtc(dateOrMonth.length === 7 ? `${dateOrMonth}-01` : dateOrMonth));
}

export function dateBlockParts(date: string): { weekday: string; day: string; month: string } {
  const d = toUtc(date);
  return { weekday: shortWeekday.format(d), day: String(d.getUTCDate()), month: shortMonth.format(d) };
}

export function longWeekdayName(index: number): string {
  // 2024-01-01 was a Monday.
  return longWeekday.format(toUtc(addDays('2024-01-01', index)));
}

export function shortWeekdayName(index: number): string {
  return shortWeekday.format(toUtc(addDays('2024-01-01', index)));
}

function timeIn(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(instant),
  );
}

/** "GMT+1", "GMT-5", "GMT+5:30" or "GMT" for the zone at that instant. */
export function utcOffsetLabel(instant: string, timeZone: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(instant))
    .find((p) => p.type === 'timeZoneName');
  const label = part?.value ?? 'GMT';
  return label === 'GMT+0' || label === 'UTC' ? 'GMT' : label;
}

/** "Europe/Lisbon" → "Lisbon", "America/Sao_Paulo" → "Sao Paulo", "UTC" → "UTC". */
export function zoneCity(timeZone: string): string {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 'UTC';
  return (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
}

export interface EventTiming {
  all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  local_start_date: string;
  local_end_date: string;
  timezone: string;
}

export interface WhenLabel {
  /** e.g. "Thursday 3 December 2026" or "Thursday 31 December 2026 to Friday 1 January 2027" */
  date: string;
  /** e.g. "18:30 to 20:30, Lisbon time (GMT)" or "All day" */
  time: string;
}

/** Describes when an event happens, in its own time zone. */
export function describeWhen(e: EventTiming): WhenLabel {
  const sameDay = e.local_start_date === e.local_end_date;
  const date = sameDay
    ? formatLongDate(e.local_start_date)
    : `${formatLongDate(e.local_start_date)} to ${formatLongDate(e.local_end_date)}`;
  if (e.all_day || !e.starts_at || !e.ends_at) {
    return { date, time: sameDay ? 'All day' : 'All days' };
  }
  const city = zoneCity(e.timezone);
  const zone = city === 'UTC' ? 'UTC' : `${city} time (${utcOffsetLabel(e.starts_at, e.timezone)})`;
  return { date, time: `${timeIn(e.starts_at, e.timezone)} to ${timeIn(e.ends_at, e.timezone)}, ${zone}` };
}
