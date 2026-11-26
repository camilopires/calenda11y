/** Builds the weeks of a month grid (weeks start on Monday) and places events on their days. */
import { addDays, eachDay, endOfMonth, monthOf, weekdayIndex } from './dates.ts';

export interface GridEvent {
  id: string;
  local_start_date: string;
  local_end_date: string;
}

export interface GridDay<E> {
  date: string;
  inMonth: boolean;
  isToday: boolean;
  events: E[];
  /** How many more events there are on this day than are shown. */
  more: number;
}

export interface MonthGrid<E> {
  month: string;
  weeks: GridDay<E>[][];
  /** Distinct events that touch the month. */
  eventCount: number;
}

export const DEFAULT_DAY_CAP = 3;

export function buildMonthGrid<E extends GridEvent>(
  month: string,
  events: readonly E[],
  today: string,
  cap = DEFAULT_DAY_CAP,
): MonthGrid<E> {
  const first = `${month}-01`;
  const last = endOfMonth(first);
  const gridStart = addDays(first, -weekdayIndex(first));
  const gridEnd = addDays(last, 6 - weekdayIndex(last));

  const byDay = new Map<string, E[]>();
  const inMonth = new Set<string>();
  for (const e of events) {
    // An event covers every local date from its first to its last day.
    const from = e.local_start_date > gridStart ? e.local_start_date : gridStart;
    const to = e.local_end_date < gridEnd ? e.local_end_date : gridEnd;
    if (from > to) continue;
    for (const d of eachDay(from, to)) {
      const list = byDay.get(d) ?? [];
      list.push(e);
      byDay.set(d, list);
      if (monthOf(d) === month) inMonth.add(e.id);
    }
  }

  const days = eachDay(gridStart, gridEnd).map((date): GridDay<E> => {
    const all = byDay.get(date) ?? [];
    return {
      date,
      inMonth: monthOf(date) === month,
      isToday: date === today,
      events: all.slice(0, cap),
      more: Math.max(0, all.length - cap),
    };
  });

  const weeks: GridDay<E>[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return { month, weeks, eventCount: inMonth.size };
}
