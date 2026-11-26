import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { buildCalendar, escapeText, foldLine, utcStamp } from '../../src/lib/calendar/ics.ts';
import { makeEvent } from '../support/factories.ts';

const SITE = 'https://calenda11y.org';
const cal = (events = [makeEvent()]) => buildCalendar(events, { name: 'calenda11y', siteUrl: SITE });

describe('escapeText', () => {
  it('escapes backslashes, semicolons, commas and newlines', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });
});

describe('foldLine', () => {
  it('leaves short lines alone', () => {
    expect(foldLine('SUMMARY:Short')).toBe('SUMMARY:Short');
  });

  it('folds at 75 octets with a leading space on continuation lines', () => {
    const folded = foldLine(`DESCRIPTION:${'x'.repeat(200)}`);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    for (const l of lines.slice(1)) expect(l.startsWith(' ')).toBe(true);
    expect(lines.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(`DESCRIPTION:${'x'.repeat(200)}`);
  });

  it('never splits a multi-byte character', () => {
    const value = `SUMMARY:${'ウェブ'.repeat(30)}`;
    const lines = foldLine(value).split('\r\n');
    for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(lines.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(value);
  });
});

describe('buildCalendar', () => {
  it('has the required calendar and event properties, with CRLF line endings', () => {
    const text = cal();
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
    for (const prop of [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:',
      'BEGIN:VEVENT',
      'DTSTAMP:',
      'UID:',
      'END:VCALENDAR',
    ]) {
      expect(text).toContain(prop);
    }
    expect(text).toContain('UID:00000000-0000-4000-8000-000000000001@calenda11y.org');
    expect(text).toContain('DTSTART:20261201T183000Z');
    expect(text).toContain('DTEND:20261201T203000Z');
    expect(text).toContain('STATUS:CONFIRMED');
    expect(text).toContain('URL:https://calenda11y.org/events/lisbon-meetup');
  });

  it('writes all-day events as dates with an exclusive end', () => {
    const text = cal([
      makeEvent({ all_day: true, starts_at: null, ends_at: null, start_date: '2026-12-31', end_date: '2027-01-02' }),
    ]);
    expect(text).toContain('DTSTART;VALUE=DATE:20261231');
    expect(text).toContain('DTEND;VALUE=DATE:20270102');
  });

  it('marks cancelled events and carries the sequence', () => {
    const text = cal([makeEvent({ status: 'cancelled', sequence: 3 })]);
    expect(text).toContain('STATUS:CANCELLED');
    expect(text).toContain('SEQUENCE:3');
    expect(text).toContain('SUMMARY;LANGUAGE=en:Cancelled: Lisbon Meetup');
  });

  it('round-trips through ical.js', () => {
    const e = makeEvent({ title: 'Commas, semicolons; and\nnew lines', description: `${'Long text. '.repeat(40)}` });
    const comp = new ICAL.Component(ICAL.parse(cal([e])));
    const vevent = comp.getFirstSubcomponent('vevent')!;
    const ev = new ICAL.Event(vevent);
    expect(ev.summary).toBe('Commas, semicolons; and\nnew lines');
    expect(ev.uid).toBe(`${e.id}@calenda11y.org`);
    expect(ev.startDate.toJSDate().toISOString()).toBe('2026-12-01T18:30:00.000Z');
    expect(ev.endDate.toJSDate().toISOString()).toBe('2026-12-01T20:30:00.000Z');
    expect(String(vevent.getFirstPropertyValue('description'))).toContain('Times are for Lisbon (Europe/Lisbon).');
    expect(ev.location).toBe('Rua das Flores 12, Lisbon, Portugal');
  });

  it('formats UTC stamps', () => {
    expect(utcStamp('2026-12-01T18:30:00.123Z')).toBe('20261201T183000Z');
  });
});
