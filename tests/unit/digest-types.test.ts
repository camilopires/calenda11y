import { describe, expect, it } from 'vitest';
import { preferencesToValues, readPreferences, validatePreferences } from '../../src/lib/digest/form.ts';
import { digestListUrl } from '../../src/lib/digest/send.ts';
import { describePreferences } from '../../src/lib/digest/subscribers.ts';

describe('digest preferences: types', () => {
  it('reads and validates types, keeping the list order', () => {
    const fd = new FormData();
    fd.set('cadence', 'weekly');
    fd.append('type', 'workshop');
    fd.append('type', 'conference');
    const r = validatePreferences(readPreferences(fd));
    expect(r.ok && r.prefs.types).toEqual(['conference', 'workshop']);
  });

  it('refuses unknown types', () => {
    const r = validatePreferences({ cadence: 'weekly', country: '', online: false, formats: [], types: ['party'] });
    expect(!r.ok && r.errors.type).toBe('Choose types from the list');
  });

  it('puts saved types back on the form, so changing something else keeps them', () => {
    const v = preferencesToValues({ cadence: 'monthly', countries: [], formats: [], types: ['talk'] });
    expect(v.types).toEqual(['talk']);
  });

  it('is described in plain words', () => {
    expect(
      describePreferences({ cadence: 'weekly', countries: ['PT'], formats: [], types: ['conference', 'workshop'] }),
    ).toBe('a weekly email of conferences or workshops in Portugal');
    expect(describePreferences({ cadence: 'monthly', countries: [], formats: ['online'], types: ['talk'] })).toBe(
      'a monthly email of online talks and webinars',
    );
  });

  it('links to the same types on the site', () => {
    const url = digestListUrl(
      { countries: [], formats: [], types: ['meetup'] },
      { start: '2031-03-03', end: '2031-03-09' },
      '2031-03-03',
    );
    expect(new URL(url).searchParams.getAll('type')).toEqual(['meetup']);
  });
});
