import { describe, expect, it } from 'vitest';
import { splitAbbreviations, zoneNote } from '../../src/lib/text/abbr.ts';

describe('splitAbbreviations', () => {
  it('marks GMT inside an offset', () => {
    expect(splitAbbreviations('18:30 to 20:30, Lisbon time (GMT+1)')).toEqual([
      { text: '18:30 to 20:30, Lisbon time (' },
      { text: 'GMT', title: 'Greenwich Mean Time' },
      { text: '+1)' },
    ]);
  });

  it('marks UTC at the end', () => {
    expect(splitAbbreviations('17:00 to 18:00, UTC')).toEqual([
      { text: '17:00 to 18:00, ' },
      { text: 'UTC', title: 'Coordinated Universal Time' },
    ]);
  });

  it('leaves other text alone', () => {
    expect(splitAbbreviations('All day')).toEqual([{ text: 'All day' }]);
    expect(splitAbbreviations('UTCX and XGMT')).toEqual([{ text: 'UTCX and XGMT' }]);
  });
});

describe('zoneNote', () => {
  it('explains only the abbreviations that appear', () => {
    // GMT's note must not bring in UTC unexplained.
    expect(zoneNote(['18:30, Lisbon time (GMT)'])).toBe(
      'GMT means Greenwich Mean Time, the same as Coordinated Universal Time.',
    );
    expect(zoneNote(['17:00, UTC'])).toBe('UTC means Coordinated Universal Time.');
    expect(zoneNote(['17:00, UTC', '18:00 (GMT+1)'])).toBe(
      'UTC means Coordinated Universal Time. GMT means Greenwich Mean Time, the same as Coordinated Universal Time.',
    );
  });

  it('returns nothing when there is nothing to explain', () => {
    expect(zoneNote(['All day'])).toBeNull();
    expect(zoneNote([])).toBeNull();
  });
});
