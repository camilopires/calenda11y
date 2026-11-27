import { describe, expect, it } from 'vitest';
import { cfpBadge, cfpClosesAt, cfpDeadline, cfpSentence, cfpStatus } from '../../src/lib/events/cfp.ts';
import { makeEvent } from '../support/factories.ts';

const closesAt = Date.parse('2027-03-16T00:00:00.000Z');
const withCall = (over: Parameters<typeof makeEvent>[0] = {}) =>
  makeEvent({
    starts_at: '2027-04-01T18:00:00.000Z',
    ends_at: '2027-04-01T20:00:00.000Z',
    end_instant: '2027-04-01T20:00:00.000Z',
    cfp_url: 'https://cfp.example/apply',
    cfp_closes_on: '2027-03-15',
    cfp_closes_at: '2027-03-16T00:00:00.000Z',
    cfp_last_day: '2027-03-15',
    cfp_capped: false,
    ...over,
  });
const at = (ms: number) => new Date(ms);
const DAY = 86_400_000;

describe('cfpStatus', () => {
  it.each([
    [8 * DAY, 'open'],
    [7 * DAY, 'soon'],
    [1, 'soon'],
    [0, 'closed'],
    [-1, 'closed'],
  ])('%i ms before closing → %s', (before, state) => {
    expect(cfpStatus(withCall(), at(closesAt - before))?.state).toBe(state);
  });

  it('is null with no call, after the event has ended, and for cancelled events', () => {
    expect(cfpStatus(makeEvent({ cfp_url: null, cfp_closes_at: null }), at(closesAt - DAY))).toBeNull();
    expect(cfpStatus(withCall(), at(Date.parse('2027-04-02T00:00:00Z')))).toBeNull();
    expect(cfpStatus(withCall({ status: 'cancelled' }), at(closesAt - 9 * DAY))).toBeNull();
  });
});

describe('cfp wording', () => {
  it('badges say open, closing soon or closed, with a short date', () => {
    expect(cfpBadge(cfpStatus(withCall(), at(closesAt - 10 * DAY))!)).toBe('Call for speakers open until 15 Mar');
    expect(cfpBadge(cfpStatus(withCall(), at(closesAt - DAY))!)).toBe('Call for speakers closes soon: 15 Mar');
    expect(cfpBadge(cfpStatus(withCall(), at(closesAt + 1))!)).toBe('Call for speakers closed');
    const capped = withCall({
      cfp_closes_on: null,
      cfp_capped: true,
      cfp_last_day: '2027-04-01',
      cfp_closes_at: '2027-04-01T18:00:00.000Z',
    });
    expect(cfpBadge(cfpStatus(capped, at(closesAt))!)).toBe('Call for speakers open until the event');
  });

  it('the page sentence writes dates in full', () => {
    expect(cfpSentence(withCall(), at(closesAt - 10 * DAY))).toBe(
      'The call for speakers is open until the end of Monday 15 March 2027.',
    );
    expect(cfpSentence(withCall(), at(closesAt))).toBe('The call for speakers closed on Monday 15 March 2027.');
    const capped = withCall({
      cfp_closes_on: null,
      cfp_capped: true,
      cfp_last_day: '2027-04-01',
      cfp_closes_at: '2027-04-01T18:00:00.000Z',
    });
    expect(cfpSentence(capped, at(closesAt))).toBe('The call for speakers is open until the event starts.');
  });

  it('feed and email wording never depends on today', () => {
    expect(cfpDeadline(withCall())).toBe('Call for speakers: apply by Monday 15 March 2027');
    expect(cfpDeadline(withCall({ cfp_capped: true }))).toBe('Call for speakers: apply before the event starts');
    expect(cfpDeadline(makeEvent({ cfp_url: null }))).toBeNull();
  });
});

describe('cfpClosesAt (the same rule as the database)', () => {
  const base = { cfp_url: 'https://cfp.example', all_day: false, start_date: null };
  it('closes at the end of the day in the event time zone', () => {
    expect(
      cfpClosesAt({
        ...base,
        timezone: 'Europe/Lisbon',
        starts_at: '2032-06-10T18:00:00Z',
        cfp_closes_on: '2032-05-15',
      }),
    ).toEqual({ at: '2032-05-15T23:00:00.000Z', lastDay: '2032-05-15', capped: false });
  });

  it('with no date, or a date on the start day of a timed event, closes when it starts', () => {
    expect(cfpClosesAt({ ...base, timezone: 'UTC', starts_at: '2032-06-10T18:00:00Z', cfp_closes_on: null })).toEqual({
      at: '2032-06-10T18:00:00.000Z',
      lastDay: '2032-06-10',
      capped: true,
    });
    expect(
      cfpClosesAt({ ...base, timezone: 'UTC', starts_at: '2032-06-10T18:00:00Z', cfp_closes_on: '2032-06-10' })?.capped,
    ).toBe(true);
  });

  it('all-day events start at midnight in their zone', () => {
    expect(
      cfpClosesAt({
        ...base,
        all_day: true,
        timezone: 'Europe/Berlin',
        starts_at: null,
        start_date: '2032-06-01',
        cfp_closes_on: '2032-05-31',
      }),
    ).toEqual({ at: '2032-05-31T22:00:00.000Z', lastDay: '2032-05-31', capped: false });
  });

  it('when midnight happens twice (clocks going back), uses the later one, as PostgreSQL does', () => {
    // Cuba's clocks go back from 01:00 to 00:00 on 7 November 2027.
    expect(
      cfpClosesAt({
        ...base,
        timezone: 'America/Havana',
        starts_at: '2027-12-01T18:00:00Z',
        cfp_closes_on: '2027-11-06',
      }),
    ).toEqual({ at: '2027-11-07T05:00:00.000Z', lastDay: '2027-11-07', capped: false });
  });

  it('is null without a link', () => {
    expect(
      cfpClosesAt({ ...base, cfp_url: null, timezone: 'UTC', starts_at: '2032-06-10T18:00:00Z', cfp_closes_on: null }),
    ).toBeNull();
  });
});
