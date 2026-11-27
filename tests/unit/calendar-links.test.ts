import { describe, expect, it } from 'vitest';
import { googleCalendarUrl, office365Url, outlookComUrl, webcalUrl } from '../../src/lib/calendar/links.ts';
import { buildRss } from '../../src/lib/calendar/rss.ts';
import { makeEvent } from '../support/factories.ts';

const SITE = 'https://calenda11y.org';

describe('calendar links', () => {
  it('builds a Google Calendar link in UTC with the event time zone', () => {
    const url = new URL(googleCalendarUrl(makeEvent({ title: 'A & B' }), SITE));
    expect(url.origin).toBe('https://calendar.google.com');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('A & B');
    expect(url.searchParams.get('dates')).toBe('20261201T183000Z/20261201T203000Z');
    expect(url.searchParams.get('ctz')).toBe('Europe/Lisbon');
    expect(url.searchParams.get('location')).toBe('Rua das Flores 12, Lisbon, Portugal');
  });

  it('uses date ranges for all-day events', () => {
    const e = makeEvent({
      all_day: true,
      starts_at: null,
      ends_at: null,
      start_date: '2026-12-10',
      end_date: '2026-12-11',
    });
    expect(new URL(googleCalendarUrl(e, SITE)).searchParams.get('dates')).toBe('20261210/20261211');
    const outlook = new URL(outlookComUrl(e, SITE));
    expect(outlook.searchParams.get('allday')).toBe('true');
    expect(outlook.searchParams.get('startdt')).toBe('2026-12-10');
  });

  it('builds Outlook.com and Microsoft 365 links', () => {
    expect(new URL(outlookComUrl(makeEvent(), SITE)).host).toBe('outlook.live.com');
    const o365 = new URL(office365Url(makeEvent(), SITE));
    expect(o365.host).toBe('outlook.office.com');
    expect(o365.searchParams.get('startdt')).toBe('2026-12-01T18:30:00.000Z');
    expect(o365.searchParams.get('subject')).toBe('Lisbon Meetup');
  });

  it('keeps long descriptions short in links', () => {
    const url = new URL(googleCalendarUrl(makeEvent({ description: 'x'.repeat(5000) }), SITE));
    expect(url.searchParams.get('details')!.length).toBeLessThanOrEqual(1500);
  });

  it('turns feed URLs into webcal URLs', () => {
    expect(webcalUrl('https://calenda11y.org/feeds/all.ics')).toBe('webcal://calenda11y.org/feeds/all.ics');
  });
});

describe('buildRss', () => {
  it('escapes text and lists each event', () => {
    const xml = buildRss([makeEvent({ title: '<Tags> & "quotes"' })], {
      title: 'calenda11y',
      description: 'Events',
      siteUrl: SITE,
      selfUrl: `${SITE}/feeds/events.rss`,
    });
    expect(xml).toContain('<title>&lt;Tags&gt; &amp; &quot;quotes&quot;</title>');
    expect(xml).toContain('<guid isPermaLink="true">https://calenda11y.org/events/lisbon-meetup</guid>');
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
  });
});

describe('event types in RSS', () => {
  it('adds a category for each type', () => {
    const xml = buildRss([makeEvent({ types: ['workshop', 'training'] })], {
      title: 'calenda11y',
      description: 'Events',
      siteUrl: SITE,
      selfUrl: `${SITE}/feeds/events.rss`,
    });
    expect(xml).toContain('<category>Workshop</category>');
    expect(xml).toContain('<category>Training course</category>');
  });
});
