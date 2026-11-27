import { describe, expect, it } from 'vitest';
import { preferencesToValues, readPreferences, validatePreferences } from '../../src/lib/digest/form.ts';
import { digestListUrl } from '../../src/lib/digest/send.ts';
import { describePreferences, type Preferences } from '../../src/lib/digest/subscribers.ts';

const prefs = (over: Partial<Preferences> = {}): Preferences => ({
  cadence: 'weekly',
  countries: [],
  formats: [],
  types: [],
  topics: [],
  include_cfp: false,
  near: null,
  ...over,
});

describe('digest preferences: topics', () => {
  it('the form uses URL names, and saves stored values in list order', () => {
    const fd = new FormData();
    fd.set('cadence', 'weekly');
    fd.append('topic', 'law');
    fd.append('topic', 'assistive-technology');
    const r = validatePreferences(readPreferences(fd));
    expect(r.ok && r.prefs.topics).toEqual(['law', 'assistive_tech']);
  });

  it('refuses unknown topics', () => {
    const fd = new FormData();
    fd.set('cadence', 'weekly');
    fd.append('topic', 'cooking');
    const r = validatePreferences(readPreferences(fd));
    expect(!r.ok && r.errors.topic).toBe('Choose topics from the list');
  });

  it('puts saved topics back as URL names, so the boxes are ticked', () => {
    expect(preferencesToValues(prefs({ topics: ['assistive_tech'] })).topics).toEqual(['assistive-technology']);
  });

  it('is described in plain words', () => {
    expect(describePreferences(prefs({ countries: ['PT'], topics: ['neurodiversity'], near: null }))).toBe(
      'a weekly email of events about neurodiversity and cognitive in Portugal',
    );
  });

  it('links to the same topics on the site, by URL name', () => {
    const url = digestListUrl(
      prefs({ topics: ['assistive_tech'] }),
      { start: '2031-03-03', end: '2031-03-09' },
      '2031-03-03',
    );
    expect(new URL(url).searchParams.getAll('topic')).toEqual(['assistive-technology']);
  });
});
