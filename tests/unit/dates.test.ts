import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dateBlockParts,
  describeWhen,
  eachDay,
  endOfMonth,
  formatMonthYear,
  isIsoDate,
  isIsoMonth,
  shiftMonth,
  utcOffsetLabel,
  weekdayIndex,
  zoneCity,
} from '../../src/lib/events/dates.ts';

describe('date arithmetic', () => {
  it('validates real dates only', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-1-1')).toBe(false);
    expect(isIsoDate('')).toBe(false);
    expect(isIsoMonth('2026-12')).toBe(true);
    expect(isIsoMonth('2026-00')).toBe(false);
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('clamps when adding months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2027-01', -1)).toBe('2026-12');
  });

  it('finds the end of the month', () => {
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(endOfMonth('2026-12-01')).toBe('2026-12-31');
  });

  it('numbers weekdays from Monday', () => {
    expect(weekdayIndex('2026-11-30')).toBe(0); // Monday
    expect(weekdayIndex('2026-12-06')).toBe(6); // Sunday
  });

  it('lists every day in a range', () => {
    expect(eachDay('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(eachDay('2026-12-02', '2026-12-01')).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats months and date blocks', () => {
    expect(formatMonthYear('2026-12')).toBe('December 2026');
    expect(dateBlockParts('2026-12-03')).toEqual({ weekday: 'Thu', day: '3', month: 'Dec' });
  });

  it('names time zones by city', () => {
    expect(zoneCity('Europe/Lisbon')).toBe('Lisbon');
    expect(zoneCity('America/Sao_Paulo')).toBe('Sao Paulo');
    expect(zoneCity('UTC')).toBe('UTC');
  });

  it('labels the UTC offset in effect at that instant (daylight saving)', () => {
    expect(utcOffsetLabel('2026-01-15T12:00:00Z', 'Europe/London')).toBe('GMT');
    expect(utcOffsetLabel('2026-07-15T12:00:00Z', 'Europe/London')).toBe('GMT+1');
    expect(utcOffsetLabel('2026-07-15T12:00:00Z', 'Asia/Kolkata')).toBe('GMT+5:30');
  });

  it('describes a timed event in its own time zone', () => {
    expect(
      describeWhen({
        all_day: false,
        starts_at: '2026-07-02T17:30:00Z',
        ends_at: '2026-07-02T19:30:00Z',
        local_start_date: '2026-07-02',
        local_end_date: '2026-07-02',
        timezone: 'Europe/Lisbon',
      }),
    ).toEqual({ date: 'Thursday 2 July 2026', time: '18:30 to 20:30, Lisbon time (GMT+1)' });
  });

  it('describes a UTC event without repeating the zone', () => {
    expect(
      describeWhen({
        all_day: false,
        starts_at: '2026-12-01T15:00:00Z',
        ends_at: '2026-12-01T16:30:00Z',
        local_start_date: '2026-12-01',
        local_end_date: '2026-12-01',
        timezone: 'UTC',
      }).time,
    ).toBe('15:00 to 16:30, UTC');
  });

  it('describes multi-day and all-day events', () => {
    expect(
      describeWhen({
        all_day: true,
        starts_at: null,
        ends_at: null,
        local_start_date: '2026-12-31',
        local_end_date: '2027-01-01',
        timezone: 'Europe/Stockholm',
      }),
    ).toEqual({ date: 'Thursday 31 December 2026 to Friday 1 January 2027', time: 'All days' });
  });
});
