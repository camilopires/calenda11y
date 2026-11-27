import { describe, expect, it } from 'vitest';
import { guessTypes } from '../../src/lib/imports/normalise.ts';

describe('guessTypes', () => {
  it('treats everything from a Meetup group as a meetup', () => {
    expect(guessTypes('Monthly drinks', 'meetup')).toEqual(['meetup']);
  });

  it.each([
    ['Nordic A11y Summit 2027', ['conference']],
    ['Accessibility Conference', ['conference']],
    ['A11yConf', []],
    ['CSUN Conf', ['conference']],
    ['Workshop: accessible forms', ['workshop']],
    ['Webinar on captions', ['talk']],
    ['Lunchtime talk: ARIA', ['talk']],
    ['Guest lecture', ['talk']],
    ['WCAG training course', ['training']],
    ['Accessibility bootcamp', ['training']],
    ['London a11y meet-up', ['meetup']],
    ['Summit with workshops', ['conference', 'workshop']],
  ])('"%s" → %j', (title, expected) => {
    expect(guessTypes(title, 'ics')).toEqual(expected);
  });

  it('matches whole words only, in any case', () => {
    expect(guessTypes('Contour mapping, talkative crowds, coursework', 'ics')).toEqual([]);
    expect(guessTypes('WORKSHOP', 'rss')).toEqual(['workshop']);
  });

  it('guesses nothing when nothing matches', () => {
    expect(guessTypes('Accessibility evening', 'luma')).toEqual([]);
  });
});
