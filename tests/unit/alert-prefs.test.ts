import { describe, expect, it } from 'vitest';
import { readPreferences, validatePreferences } from '../../src/lib/digest/form.ts';
import { describePreferences, type Preferences } from '../../src/lib/digest/subscribers.ts';

const prefs = (over: Partial<Preferences> = {}): Preferences => ({
  cadence: 'weekly',
  countries: [],
  formats: [],
  types: [],
  topics: [],
  include_cfp: false,
  ...over,
});

describe('alert cadences', () => {
  it.each(['weekly', 'monthly', 'daily', 'instant'])('accepts %s', (cadence) => {
    const fd = new FormData();
    fd.set('cadence', cadence);
    const r = validatePreferences(readPreferences(fd));
    expect(r.ok && r.prefs.cadence).toBe(cadence);
  });

  it('refuses anything else', () => {
    const fd = new FormData();
    fd.set('cadence', 'hourly');
    expect(validatePreferences(readPreferences(fd)).ok).toBe(false);
  });

  it('describes daily and instant alerts in plain words', () => {
    expect(describePreferences(prefs({ cadence: 'daily', countries: ['PT'] }))).toBe(
      'a daily email of new and changed events in Portugal',
    );
    expect(describePreferences(prefs({ cadence: 'instant', topics: ['law'], include_cfp: true }))).toBe(
      'an email as soon as events about law and compliance are added or changed, plus calls for speakers',
    );
  });
});
