import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseIcs } from '../../src/lib/imports/ics.ts';
import { normalise } from '../../src/lib/imports/normalise.ts';
import { IMPORT_LIMITS } from '../../src/lib/imports/types.ts';
import type { ImportSource, RawEvent } from '../../src/lib/imports/types.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/ics/${name}`, import.meta.url), 'utf8');
const source: ImportSource = {
  id: 's1',
  type: 'ics',
  name: 'Test feed',
  enabled: true,
  config: { url: 'https://example.org/feed.ics', default_timezone: 'Europe/Lisbon', default_country: 'PT' },
};
const NOW = new Date('2027-01-15T00:00:00Z');
const byUid = (items: RawEvent[]) => Object.fromEntries(items.map((i) => [i.source_uid, i]));

describe('parseIcs', () => {
  const page = parseIcs(fixture('basic.ics'), source, NOW);
  const items = byUid(page.items);

  it('reads UTC times', () => {
    expect(items['utc-1@example.org']).toMatchObject({
      starts_at: '2027-03-10T18:00:00.000Z',
      ends_at: '2027-03-10T20:00:00.000Z',
      organiser: 'A11y Group',
    });
  });

  it('converts an IANA TZID with no VTIMEZONE, including summer time', () => {
    expect(items['london-1@example.org']).toMatchObject({
      starts_at: '2027-06-10T17:30:00.000Z',
      timezone: 'Europe/London',
    });
  });

  it('uses the source time zone for floating times', () => {
    expect(items['floating-1@example.org']).toMatchObject({
      starts_at: '2027-04-15T08:00:00.000Z',
      timezone: 'Europe/Lisbon',
    });
  });

  it('reads all-day events with an exclusive end', () => {
    expect(items['allday-1@example.org']).toMatchObject({
      all_day: true,
      start_date: '2027-05-20',
      end_date: '2027-05-22',
    });
  });

  it('leaves out past events and reports what it skipped', () => {
    expect(items['past-1@example.org']).toBeUndefined();
    expect(page.skipped).toEqual(
      expect.arrayContaining([
        { uid: '(no UID)', reason: 'It has no UID, so it cannot be tracked' },
        { uid: 'badzone-1@example.org', reason: 'Unknown time zone "Mars/Olympus"' },
      ]),
    );
  });

  it('uses a VTIMEZONE from the feed (Outlook-style names)', () => {
    const [ev] = parseIcs(fixture('outlook-vtimezone.ics'), source, NOW).items;
    expect(ev).toMatchObject({ starts_at: '2027-07-01T12:00:00.000Z', ends_at: '2027-07-01T13:00:00.000Z' });
  });

  it('refuses something that is not iCalendar', () => {
    expect(() => parseIcs('<html>nope</html>', source, NOW)).toThrow(/not valid iCalendar/);
  });
});

describe('recurring events', () => {
  const page = parseIcs(fixture('recurring.ics'), source, NOW);
  const weekly = page.items.filter((i) => i.source_uid.startsWith('weekly@'));

  it('expands occurrences, skips EXDATEs, and follows the clocks changing', () => {
    expect(weekly.map((w) => w.starts_at)).toEqual([
      '2027-10-20T22:00:00.000Z', // EDT (UTC-4)
      // 27 October is excluded by EXDATE.
      '2027-11-04T22:00:00.000Z', // moved occurrence, still EDT
      '2027-11-10T23:00:00.000Z', // EST (UTC-5) after 7 November
      '2027-11-17T23:00:00.000Z',
    ]);
  });

  it('keeps an occurrence identity through a move, using RECURRENCE-ID', () => {
    const moved = weekly.find((w) => w.title?.includes('moved'));
    expect(moved?.source_uid).toBe('weekly@example.org#20271103T220000Z');
  });

  it('marks a cancelled occurrence as cancelled', () => {
    expect(weekly.find((w) => w.starts_at === '2027-11-10T23:00:00.000Z')?.cancelled).toBe(true);
  });

  it('caps endless series, and says the feed was not read in full', () => {
    expect(page.truncated).toBe(true);
    const daily = page.items.filter((i) => i.source_uid.startsWith('daily-forever@'));
    expect(daily.length).toBeLessThanOrEqual(200);
    expect(page.skipped.some((s) => s.uid === 'daily-forever@example.org' && /more than 200/.test(s.reason))).toBe(
      true,
    );
  });
});

describe('normalise', () => {
  const items = byUid(parseIcs(fixture('basic.ics'), source, NOW).items);

  it('strips markup and builds a summary', () => {
    const r = normalise(items['utc-1@example.org']!, source);
    expect(r.ok && r.event.fields).toMatchObject({
      title: 'UTC meetup',
      summary: 'Talks about focus styles.',
      description: 'Talks about focus styles.\n\nSecond paragraph.',
      format: 'online',
      country_code: null,
      url: 'https://example.org/utc',
    });
  });

  it('uses the default country for in-person events', () => {
    const r = normalise(items['london-1@example.org']!, source);
    expect(r.ok && r.event.fields).toMatchObject({
      format: 'in_person',
      country_code: 'PT',
      venue: 'Shoreditch Hall, London',
    });
  });

  it('refuses in-person events with no known country', () => {
    const { default_country: _dropped, ...noCountry } = source.config;
    const r = normalise(items['london-1@example.org']!, { ...source, config: noCountry });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/country is not known/) });
  });

  it('refuses events without a name or with impossible times', () => {
    expect(
      normalise(
        {
          source_uid: 'x',
          title: '  ',
          all_day: false,
          starts_at: '2027-01-01T10:00:00Z',
          ends_at: '2027-01-01T11:00:00Z',
        },
        source,
      ).ok,
    ).toBe(false);
    expect(
      normalise(
        {
          source_uid: 'x',
          title: 'T',
          all_day: false,
          starts_at: '2027-01-01T10:00:00Z',
          ends_at: '2027-01-01T09:00:00Z',
        },
        source,
      ).ok,
    ).toBe(false);
  });

  it('drops non-https links', () => {
    const r = normalise(
      {
        source_uid: 'x',
        title: 'T',
        url: 'javascript:alert(1)',
        all_day: false,
        starts_at: '2027-01-01T10:00:00Z',
        ends_at: '2027-01-01T11:00:00Z',
      },
      source,
    );
    expect(r.ok && r.event.fields.url).toBeNull();
  });
});

describe('review regressions', () => {
  const cal = (...lines: string[]) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x', ...lines, 'END:VCALENDAR'].join('\r\n');

  it("still imports this year's occurrences of a weekly series that started years ago", () => {
    const body = cal(
      'BEGIN:VEVENT',
      'UID:old-weekly',
      'DTSTAMP:20200101T000000Z',
      'DTSTART:20200106T180000Z',
      'DTEND:20200106T190000Z',
      'RRULE:FREQ=WEEKLY',
      'SUMMARY:Old weekly',
      'END:VEVENT',
    );
    const page = parseIcs(body, source, NOW);
    expect(page.items.length).toBeGreaterThan(40);
    expect(page.items[0]!.starts_at! >= '2027-01-14').toBe(true);
    expect(page.items[0]!.starts_at).toMatch(/T18:00:00/);
  });

  it('keeps seconds when converting zoned and floating times', () => {
    const body = cal(
      'BEGIN:VEVENT',
      'UID:secs',
      'DTSTAMP:20270101T000000Z',
      'DTSTART;TZID=Europe/London:20270610T183045',
      'DTEND;TZID=Europe/London:20270610T193045',
      'SUMMARY:Seconds',
      'END:VEVENT',
    );
    expect(parseIcs(body, source, NOW).items[0]!.starts_at).toBe('2027-06-10T17:30:45.000Z');
  });

  it('says when a feed was cut short, so nothing is marked missing from it', () => {
    const many = Array.from({ length: 5001 }, (_, i) => [
      'BEGIN:VEVENT',
      `UID:m${i}`,
      'DTSTAMP:20270101T000000Z',
      'DTSTART:20270301T100000Z',
      'DTEND:20270301T110000Z',
      'SUMMARY:M',
      'END:VEVENT',
    ]).flat();
    const page = parseIcs(cal(...many), source, NOW);
    expect(page.items).toHaveLength(5000);
    expect(page.truncated).toBe(true);
  });
});

describe('limits on reading a feed', () => {
  const vcal = (...events: string[][]) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
  // An old series that repeats every minute: lots of work, nothing to import.
  const minutely = (uid: string) => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20270101T000000Z',
    'DTSTART:20000101T000000Z',
    'DTEND:20000101T000100Z',
    'RRULE:FREQ=MINUTELY',
    'SUMMARY:Busy',
    'END:VEVENT',
  ];
  const single = (uid: string) => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20270101T000000Z',
    'DTSTART:20270301T100000Z',
    'DTEND:20270301T110000Z',
    'SUMMARY:One',
    'END:VEVENT',
  ];

  it('marks a feed truncated when one series hits its step limit', () => {
    const page = parseIcs(vcal(minutely('busy@x')), source, NOW);
    expect(page.truncated).toBe(true);
    expect(page.skipped.some((s) => s.uid === 'busy@x')).toBe(true);
  });

  it('shares one step budget across the whole feed, and stays quick', () => {
    const many = Array.from({ length: 20 }, (_, i) => minutely(`busy${i}@x`));
    const started = Date.now();
    const page = parseIcs(vcal(...many, single('after@x')), source, NOW);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(page.truncated).toBe(true);
    // The budget covers a couple of series; the rest, including the event after them, aren't read.
    expect(IMPORT_LIMITS.maxRecurrenceStepsPerFeed / IMPORT_LIMITS.maxRecurrenceSteps).toBeLessThan(20);
    expect(page.skipped.some((s) => /the rest was not read/.test(s.reason))).toBe(true);
    expect(page.items.some((i) => i.source_uid === 'after@x')).toBe(false);
  });

  it('stops at the deadline, before reading anything', () => {
    const page = parseIcs(vcal(single('a@x'), single('b@x')), source, NOW, Date.now() - 1);
    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(true);
  });

  it('reads everything when there is time', () => {
    const page = parseIcs(vcal(single('a@x'), single('b@x')), source, NOW, Date.now() + 60_000);
    expect(page.items).toHaveLength(2);
    expect(page.truncated).toBeUndefined();
  });
});
