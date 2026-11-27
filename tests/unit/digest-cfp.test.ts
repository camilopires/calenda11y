import { describe, expect, it } from 'vitest';
import { preferencesToValues, readPreferences, validatePreferences } from '../../src/lib/digest/form.ts';
import { describePreferences } from '../../src/lib/digest/subscribers.ts';
import { digestEmail, type CfpItem, type DigestItem } from '../../src/lib/email/templates.ts';

const item: DigestItem = {
  title: 'Lisbon meetup',
  url: 'https://x.test/events/lisbon',
  when: 'Monday 1 March 2027, 18:30 to 20:30, Lisbon time (GMT)',
  where: 'Lisbon, Portugal',
  summary: 'Talks.',
  cfp: 'Call for speakers: apply by Monday 15 February 2027',
};
const call: CfpItem = {
  title: 'Nordic Summit',
  url: 'https://cfp.example/apply',
  deadline: 'Apply by Monday 8 March 2027',
  event: 'Monday 10 May 2027, Stockholm, Sweden',
};

describe('calls for speakers in the digest', () => {
  it('adds a "closing soon" section, in the HTML and the text', () => {
    const e = digestEmail('H', [item], 'https://m', 'https://u', { cfp: [call] });
    for (const body of [e.html, e.text]) {
      expect(body).toContain('Calls for speakers closing soon');
      expect(body).toContain('Apply by Monday 8 March 2027');
      expect(body).toContain('https://cfp.example/apply');
    }
    expect(e.html).toMatch(/<h2[^>]*>Calls for speakers closing soon<\/h2>/);
  });

  it('events in the main list say when their call closes', () => {
    const e = digestEmail('H', [item], 'https://m', 'https://u');
    expect(e.text).toContain('Call for speakers: apply by Monday 15 February 2027');
    expect(e.text).not.toContain('Calls for speakers closing soon');
  });

  it('makes sense with calls but no events', () => {
    const e = digestEmail('H', [], 'https://m', 'https://u', { cfp: [call] });
    expect(e.text).toContain('No events in this period match your choices, but these calls for speakers are open.');
    expect(e.text).not.toContain('0 events');
  });

  it('the tick box is read, kept and described', () => {
    const fd = new FormData();
    fd.set('cadence', 'weekly');
    fd.set('include_cfp', 'on');
    const r = validatePreferences(readPreferences(fd));
    expect(r.ok && r.prefs.include_cfp).toBe(true);
    expect(
      preferencesToValues({ cadence: 'weekly', countries: [], formats: [], types: [], include_cfp: true }).include_cfp,
    ).toBe(true);
    expect(
      describePreferences({ cadence: 'weekly', countries: ['PT'], formats: [], types: [], include_cfp: true }),
    ).toBe('a weekly email of events in Portugal, plus calls for speakers');
  });
});
