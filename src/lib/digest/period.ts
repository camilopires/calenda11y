/**
 * Digest periods. Weekly digests go out on Mondays and cover that Monday to
 * Sunday; monthly digests go out on the 1st and cover the whole month. A
 * period is fixed when its run starts, so a late or retried run covers the
 * same days.
 */
import { addDays, endOfMonth, startOfMonth, todayUtc, weekdayIndex } from '../events/dates.ts';

export type Cadence = 'weekly' | 'monthly';

export const SEND_HOUR_UTC = 8;

export interface Period {
  cadence: Cadence;
  start: string;
  end: string;
  /** The digest isn't sent before this instant. */
  sendAfter: Date;
}

export function currentPeriod(cadence: Cadence, now: Date): Period {
  const today = todayUtc(now);
  const start = cadence === 'weekly' ? addDays(today, -weekdayIndex(today)) : startOfMonth(today);
  const end = cadence === 'weekly' ? addDays(start, 6) : endOfMonth(start);
  return { cadence, start, end, sendAfter: new Date(`${start}T${String(SEND_HOUR_UTC).padStart(2, '0')}:00:00Z`) };
}

export const isDue = (p: Period, now: Date) => now.getTime() >= p.sendAfter.getTime();

/** "8 to 14 March 2027" / "March 2027" */
export function describePeriod(p: { cadence: Cadence; start: string; end: string }): string {
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(`${d}T12:00:00Z`));
  if (p.cadence === 'monthly') return fmt(p.start, { month: 'long', year: 'numeric' });
  const sameMonth = p.start.slice(0, 7) === p.end.slice(0, 7);
  return `${fmt(p.start, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'long' })} to ${fmt(p.end, { day: 'numeric', month: 'long', year: 'numeric' })}`;
}
