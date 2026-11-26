import { describe, expect, it } from 'vitest';
import { buildMonthGrid } from '../../src/lib/events/grid.ts';

const ev = (id: string, from: string, to = from) => ({ id, local_start_date: from, local_end_date: to });

describe('buildMonthGrid', () => {
  it('starts weeks on Monday and covers whole weeks', () => {
    const grid = buildMonthGrid('2026-12', [], '2026-12-15');
    expect(grid.weeks[0]![0]!.date).toBe('2026-11-30');
    expect(grid.weeks.at(-1)!.at(-1)!.date).toBe('2027-01-03');
    expect(grid.weeks.every((w) => w.length === 7)).toBe(true);
    expect(grid.weeks[0]![0]!.inMonth).toBe(false);
    expect(grid.weeks[0]![1]!.inMonth).toBe(true);
  });

  it('marks today', () => {
    const grid = buildMonthGrid('2026-12', [], '2026-12-15');
    const days = grid.weeks.flat().filter((d) => d.isToday);
    expect(days.map((d) => d.date)).toEqual(['2026-12-15']);
  });

  it('puts a multi-day event on every day it covers, including across the month end', () => {
    const grid = buildMonthGrid('2026-12', [ev('a', '2026-12-31', '2027-01-02')], '2026-12-01');
    const withEvent = grid.weeks
      .flat()
      .filter((d) => d.events.length)
      .map((d) => d.date);
    expect(withEvent).toEqual(['2026-12-31', '2027-01-01', '2027-01-02']);
    expect(grid.eventCount).toBe(1);
  });

  it('ignores events outside the grid and counts only events that touch the month', () => {
    const grid = buildMonthGrid('2026-12', [ev('x', '2027-02-01'), ev('y', '2027-01-02')], '2026-12-01');
    expect(
      grid.weeks
        .flat()
        .filter((d) => d.events.length)
        .map((d) => d.date),
    ).toEqual(['2027-01-02']);
    expect(grid.eventCount).toBe(0);
  });

  it('caps events per day and reports the rest', () => {
    const many = ['1', '2', '3', '4', '5'].map((id) => ev(id, '2026-12-10'));
    const day = buildMonthGrid('2026-12', many, '2026-12-01', 3)
      .weeks.flat()
      .find((d) => d.date === '2026-12-10')!;
    expect(day.events.map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(day.more).toBe(2);
  });
});
