import { describe, expect, it } from 'vitest';
import { isValidTimeZone, offsetMinutes, timeZones, zonedTimeToUtc } from '../../src/lib/events/tz.ts';

describe('zonedTimeToUtc', () => {
  it('converts ordinary times', () => {
    expect(zonedTimeToUtc('2026-12-01', '18:30', 'Europe/Lisbon')).toEqual({
      ok: true,
      instant: '2026-12-01T18:30:00.000Z',
    });
    expect(zonedTimeToUtc('2026-07-01', '18:30', 'Europe/Lisbon')).toEqual({
      ok: true,
      instant: '2026-07-01T17:30:00.000Z',
    });
    expect(zonedTimeToUtc('2026-12-01', '09:00', 'Asia/Kolkata')).toEqual({
      ok: true,
      instant: '2026-12-01T03:30:00.000Z',
    });
    expect(zonedTimeToUtc('2026-12-01', '09:00', 'UTC')).toEqual({ ok: true, instant: '2026-12-01T09:00:00.000Z' });
  });

  it('handles the southern hemisphere and the date line', () => {
    expect(zonedTimeToUtc('2027-01-15', '10:00', 'Australia/Sydney')).toEqual({
      ok: true,
      instant: '2027-01-14T23:00:00.000Z',
    });
    expect(zonedTimeToUtc('2027-01-01', '00:30', 'Pacific/Kiritimati')).toEqual({
      ok: true,
      instant: '2026-12-31T10:30:00.000Z',
    });
  });

  it('reports times skipped when the clocks go forward', () => {
    expect(zonedTimeToUtc('2027-03-28', '01:30', 'Europe/London')).toEqual({ ok: false, reason: 'nonexistent' });
    expect(zonedTimeToUtc('2027-03-14', '02:30', 'America/New_York')).toEqual({ ok: false, reason: 'nonexistent' });
  });

  it('uses the earlier time when the clocks go back and an hour repeats', () => {
    expect(zonedTimeToUtc('2027-10-31', '01:30', 'Europe/London')).toEqual({
      ok: true,
      instant: '2027-10-31T00:30:00.000Z',
    });
    expect(zonedTimeToUtc('2027-11-07', '01:30', 'America/New_York')).toEqual({
      ok: true,
      instant: '2027-11-07T05:30:00.000Z',
    });
  });

  it('handles times next to a change', () => {
    expect(zonedTimeToUtc('2027-03-28', '02:00', 'Europe/London')).toEqual({
      ok: true,
      instant: '2027-03-28T01:00:00.000Z',
    });
    expect(zonedTimeToUtc('2027-03-28', '00:59', 'Europe/London')).toEqual({
      ok: true,
      instant: '2027-03-28T00:59:00.000Z',
    });
  });
});

describe('time zones', () => {
  it('knows valid and invalid zones', () => {
    expect(isValidTimeZone('Europe/Lisbon')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('EST5EDT;drop')).toBe(false);
  });

  it('measures offsets', () => {
    expect(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'Europe/London')).toBe(60);
    expect(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'America/St_Johns')).toBe(-150);
  });

  it('lists zones including UTC', () => {
    const zones = timeZones();
    expect(zones).toContain('UTC');
    expect(zones).toContain('Europe/Lisbon');
  });
});
