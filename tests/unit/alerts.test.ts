import { describe, expect, it } from 'vitest';
import { mergeChanges, reasonLines, type ChangeRow } from '../../src/lib/alerts/changes.ts';
import { judgeableUpTo, matchesPrefs, wantsChange } from '../../src/lib/alerts/match.ts';
import { makeEvent } from '../support/factories.ts';

const NOW = new Date('2026-11-27T12:00:00Z');
let seq = 0;
const row = (
  kind: 'new' | 'updated',
  what: string[] = [],
  before: ChangeRow['before_status'] = 'approved',
): ChangeRow => ({
  seq: ++seq,
  event_id: 'e1',
  kind,
  what: what as ChangeRow['what'],
  before_status: before,
});
const one = (rows: ChangeRow[]) => mergeChanges(rows).get('e1')!;
const ev = (over: Parameters<typeof makeEvent>[0] = {}) =>
  makeEvent({ id: 'e1', end_instant: '2026-12-01T20:30:00.000Z', ...over });

describe('mergeChanges and the net status', () => {
  it('a "new" in the batch wins, and reasons are combined', () => {
    const m = one([row('new', [], 'pending'), row('updated', ['time']), row('updated', ['place', 'time'])]);
    expect(m.isNew).toBe(true);
    expect([...m.what].sort()).toEqual(['place', 'time']);
  });

  it('cancelled then restored says nothing about status', () => {
    const m = one([row('updated', ['cancelled'], 'approved'), row('updated', ['restored'], 'cancelled')]);
    expect(reasonLines(ev({ status: 'approved' }), m)).toEqual([]);
  });

  it('net status compares before the first change with now', () => {
    const m = one([row('updated', ['restored'], 'cancelled'), row('updated', ['cancelled'], 'approved')]);
    expect(reasonLines(ev({ status: 'cancelled' }), m)).toEqual([]);
    const m2 = one([
      row('updated', ['cancelled'], 'approved'),
      row('updated', ['restored'], 'cancelled'),
      row('updated', ['cancelled'], 'approved'),
    ]);
    expect(reasonLines(ev({ status: 'cancelled' }), m2)).toEqual(['Cancelled']);
  });

  it('a new event cancelled before sending shows as cancelled', () => {
    const m = one([row('new', [], 'pending'), row('updated', ['cancelled'], 'approved')]);
    expect(reasonLines(ev({ status: 'cancelled' }), m)).toEqual(['Cancelled']);
  });

  it('restored says "No longer cancelled"', () => {
    expect(reasonLines(ev(), one([row('updated', ['restored'], 'cancelled')]))).toEqual(['No longer cancelled']);
  });
});

describe('reason wording', () => {
  it('time, with the date and time in full', () => {
    expect(reasonLines(ev(), one([row('updated', ['time'])]))[0]).toMatch(
      /^New date or time: Tuesday 1 December 2026, 18:30 to 20:30, Lisbon time/,
    );
  });

  it('place names the venue, or says online', () => {
    expect(reasonLines(ev(), one([row('updated', ['place'])]))).toEqual([
      'Moved to: Rua das Flores 12, Lisbon, Portugal',
    ]);
    expect(
      reasonLines(
        ev({ format: 'online', country_code: null, city: null, venue: null }),
        one([row('updated', ['place'])]),
      ),
    ).toEqual(['Now online']);
    expect(reasonLines(ev({ format: 'hybrid' }), one([row('updated', ['place'])]))).toEqual([
      'Now in person and online: Rua das Flores 12, Lisbon, Portugal',
    ]);
  });

  it('call for speakers added, changed or removed', () => {
    const withCall = ev({ cfp_url: 'https://cfp.example', cfp_last_day: '2026-11-30', cfp_capped: false });
    expect(reasonLines(withCall, one([row('updated', ['cfp'])]))).toEqual([
      'Call for speakers: apply by Monday 30 November 2026',
    ]);
    expect(reasonLines(ev({ cfp_url: null }), one([row('updated', ['cfp'])]))).toEqual(['Call for speakers removed']);
  });

  it('access lists what there is now', () => {
    expect(reasonLines(ev({ captions: true, step_free: true }), one([row('updated', ['access'])]))).toEqual([
      'Access changed: now has live captions, step-free venue',
    ]);
    expect(reasonLines(ev({ captions: false, step_free: false }), one([row('updated', ['access'])]))).toEqual([
      'Access changed: no access provisions listed now',
    ]);
  });
});

const prefs = (over = {}) => ({
  countries: [],
  formats: [],
  types: [],
  topics: [],
  include_cfp: false,
  near: null,
  ...over,
});

describe('matching', () => {
  it('follows country, online, format, type and topic choices', () => {
    const e = ev({ topics: ['testing'] });
    expect(matchesPrefs(e, prefs())).toBe(true);
    expect(matchesPrefs(e, prefs({ countries: ['PT'] }))).toBe(true);
    expect(matchesPrefs(e, prefs({ countries: ['GB'] }))).toBe(false);
    expect(matchesPrefs(e, prefs({ countries: ['online'] }))).toBe(false);
    expect(matchesPrefs(ev({ format: 'hybrid' }), prefs({ countries: ['online'] }))).toBe(true);
    expect(matchesPrefs(e, prefs({ formats: ['online'] }))).toBe(false);
    expect(matchesPrefs(e, prefs({ types: ['meetup', 'talk'] }))).toBe(true);
    expect(matchesPrefs(e, prefs({ types: ['conference'] }))).toBe(false);
    expect(matchesPrefs(e, prefs({ topics: ['law'] }))).toBe(false);
  });

  it('calls-for-speakers-only changes go only to people who asked for them', () => {
    const m = one([row('updated', ['cfp'])]);
    expect(wantsChange(ev(), m, prefs(), NOW)).toBe(false);
    expect(wantsChange(ev(), m, prefs({ include_cfp: true }), NOW)).toBe(true);
    expect(wantsChange(ev(), one([row('updated', ['cfp', 'time'])]), prefs(), NOW)).toBe(true);
  });

  it('skips ended events, and changes that cancel each other out', () => {
    expect(
      wantsChange(ev({ end_instant: '2026-11-01T00:00:00Z' }), one([row('new', [], 'pending')]), prefs(), NOW),
    ).toBe(false);
    const net = one([row('updated', ['cancelled'], 'approved'), row('updated', ['restored'], 'cancelled')]);
    expect(wantsChange(ev(), net, prefs(), NOW)).toBe(false);
  });
});

describe('how far an alert for someone with a place can go', () => {
  const at = (s: number, event_id: string, after: Record<string, unknown>, kind: 'new' | 'updated' = 'updated') =>
    ({ seq: s, event_id, kind, what: [], before_status: 'approved', after }) as unknown as ChangeRow;
  const LONDON = { city: 'London', country_code: 'GB', venue: null, format: 'in_person' as const };
  const LISBON = { city: 'Lisbon', country_code: 'PT', venue: null, format: 'in_person' as const };

  it('everything, when every event can be judged', () => {
    const a = makeEvent({ id: 'a', ...LONDON, geo_status: 'found' });
    const rows = new Map([['a', [at(1, 'a', LONDON, 'new')]]]);
    expect(judgeableUpTo(rows, new Map([['a', a]]), 5)).toBe(5);
  });

  it('stops before an event still being placed', () => {
    const a = makeEvent({ id: 'a', ...LONDON, geo_status: 'found' });
    const b = makeEvent({ id: 'b', ...LONDON, geo_status: 'pending' });
    const rows = new Map([
      ['a', [at(1, 'a', LONDON, 'new')]],
      ['b', [at(2, 'b', LONDON, 'new')]],
    ]);
    expect(
      judgeableUpTo(
        rows,
        new Map([
          ['a', a],
          ['b', b],
        ]),
        5,
      ),
    ).toBe(1);
  });

  it("stopping early can't pair an event's old place with its new position", () => {
    // A is published in London (1), B waits for a position (2), A moves to Lisbon and is placed there (3).
    const a = makeEvent({ id: 'a', ...LISBON, lat: 38.72, lng: -9.14, geo_status: 'found' });
    const b = makeEvent({ id: 'b', ...LONDON, geo_status: 'pending' });
    const rows = new Map([
      ['a', [at(1, 'a', LONDON, 'new'), at(3, 'a', LISBON)]],
      ['b', [at(2, 'b', LONDON, 'new')]],
    ]);
    // Stopping at 1 would describe A in London with Lisbon's position, so it stops before A too.
    expect(
      judgeableUpTo(
        rows,
        new Map([
          ['a', a],
          ['b', b],
        ]),
        3,
      ),
    ).toBe(0);
  });
});
