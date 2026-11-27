import { describe, expect, it } from 'vitest';
import { readSubscriberToken, subscriberToken, unsubscribeHeaders } from '../../src/lib/digest/links.ts';
import { currentPeriod, describePeriod, isDue } from '../../src/lib/digest/period.ts';

describe('digest periods', () => {
  it('weekly covers Monday to Sunday and is due from 08:00 UTC on Monday', () => {
    const sunday = new Date('2027-03-14T23:00:00Z');
    expect(currentPeriod('weekly', sunday)).toMatchObject({ start: '2027-03-08', end: '2027-03-14' });
    const mondayEarly = new Date('2027-03-15T07:59:00Z');
    const p = currentPeriod('weekly', mondayEarly);
    expect(p).toMatchObject({ start: '2027-03-15', end: '2027-03-21' });
    expect(isDue(p, mondayEarly)).toBe(false);
    expect(isDue(p, new Date('2027-03-15T08:00:00Z'))).toBe(true);
  });

  it('monthly covers the whole current month', () => {
    expect(currentPeriod('monthly', new Date('2028-02-01T09:00:00Z'))).toMatchObject({
      start: '2028-02-01',
      end: '2028-02-29',
    });
    // A late run in the same month covers the same days.
    expect(currentPeriod('monthly', new Date('2028-02-20T09:00:00Z'))).toMatchObject({
      start: '2028-02-01',
      end: '2028-02-29',
    });
  });

  it('describes periods', () => {
    expect(describePeriod({ cadence: 'weekly', start: '2027-03-08', end: '2027-03-14' })).toBe('8 to 14 March 2027');
    expect(describePeriod({ cadence: 'weekly', start: '2027-03-29', end: '2027-04-04' })).toBe(
      '29 March to 4 April 2027',
    );
    expect(describePeriod({ cadence: 'monthly', start: '2027-03-01', end: '2027-03-31' })).toBe('March 2027');
  });
});

describe('subscriber links', () => {
  const id = '6f1c2b3a-1234-4abc-9def-0123456789ab';

  it('round-trips and is tied to its kind', () => {
    const t = subscriberToken('unsubscribe', id, 3);
    expect(readSubscriberToken('unsubscribe', t)).toEqual({ id, version: 3 });
    expect(readSubscriberToken('manage', t)).toBeNull();
  });

  it('rejects tampering', () => {
    const t = subscriberToken('manage', id, 1);
    expect(readSubscriberToken('manage', t.replace('.1.', '.2.'))).toBeNull();
    expect(readSubscriberToken('manage', 'nonsense')).toBeNull();
  });

  it('builds RFC 8058 headers', () => {
    const h = unsubscribeHeaders(id, 1);
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(h['List-Unsubscribe']).toMatch(/^<http.*\/api\/unsubscribe\?token=.+>$/);
  });
});
