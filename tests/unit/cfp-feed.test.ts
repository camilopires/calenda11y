import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { buildCfpCalendar } from '../../src/lib/calendar/cfpFeed.ts';
import { buildCalendar } from '../../src/lib/calendar/ics.ts';
import { buildRss } from '../../src/lib/calendar/rss.ts';
import { makeEvent } from '../support/factories.ts';

const SITE = 'https://calenda11y.org';
const call = (over: Parameters<typeof makeEvent>[0] = {}) =>
  makeEvent({
    id: '00000000-0000-4000-8000-0000000000c1',
    title: 'Summit; with, commas',
    sequence: 3,
    cfp_url: 'https://cfp.example/apply',
    cfp_closes_on: '2027-03-15',
    cfp_closes_at: '2027-03-16T00:00:00.000Z',
    cfp_last_day: '2027-03-15',
    cfp_capped: false,
    ...over,
  });

const parse = (text: string) =>
  new ICAL.Component(ICAL.parse(text)).getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));

describe('buildCfpCalendar', () => {
  it('puts each deadline in as an all-day entry on its last day', () => {
    const text = buildCfpCalendar([call()], { name: 'calenda11y: calls for speakers', siteUrl: SITE });
    expect(text).toContain('UID:cfp-00000000-0000-4000-8000-0000000000c1@calenda11y.org\r\n');
    expect(text).toContain('DTSTART;VALUE=DATE:20270315\r\n');
    expect(text).toContain('DTEND;VALUE=DATE:20270316\r\n');
    expect(text).toContain('SEQUENCE:3\r\n');
    expect(text).toContain(String.raw`SUMMARY;LANGUAGE=en:Call for speakers closes: Summit\; with\, commas` + '\r\n');
    expect(text).toContain('URL:https://cfp.example/apply\r\n');
    const [e] = parse(text);
    expect(e!.summary).toBe('Call for speakers closes: Summit; with, commas');
    expect(e!.startDate.isDate).toBe(true);
    expect(e!.description).toContain('https://calenda11y.org/events/lisbon-meetup');
  });

  it('a call with no date is on the day the event starts, and says so', () => {
    const text = buildCfpCalendar([call({ cfp_closes_on: null, cfp_capped: true, cfp_last_day: '2026-12-01' })], {
      name: 'c',
      siteUrl: SITE,
    });
    const [e] = parse(text);
    expect(e!.summary).toBe('Call for speakers closes when the event starts: Summit; with, commas');
    expect(e!.startDate.toString()).toBe('2026-12-01');
  });

  it('leaves out events without a call', () => {
    expect(buildCfpCalendar([makeEvent()], { name: 'c', siteUrl: SITE })).not.toContain('BEGIN:VEVENT');
  });
});

describe('calls for speakers in event feeds', () => {
  it('the ICS description says when to apply by, and links to the call', () => {
    const [e] = parse(buildCalendar([call()], { name: 'c', siteUrl: SITE }));
    expect(e!.description).toContain('Call for speakers: apply by Monday 15 March 2027: https://cfp.example/apply');
  });

  it('the RSS description does too, escaped', () => {
    const xml = buildRss([call({ cfp_url: 'https://cfp.example/apply?a=1&b=2' })], {
      title: 'c',
      description: 'd',
      siteUrl: SITE,
      selfUrl: `${SITE}/feeds/events.rss`,
    });
    expect(xml).toContain('Call for speakers: apply by Monday 15 March 2027: https://cfp.example/apply?a=1&amp;b=2');
  });
});
