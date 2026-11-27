import { describe, expect, it } from 'vitest';
import { guessTopics } from '../../src/lib/imports/normalise.ts';

describe('guessTopics', () => {
  it.each([
    ['Inclusive design meetup', '', ['inclusive_design']],
    ['ADHD and the web', '', ['neurodiversity']],
    ['Autistic-led session', '', ['neurodiversity']],
    ['Building a design system', '', ['design_systems']],
    ['ARIA for front-end developers', '', ['web_development']],
    ['Accessible iOS and Android apps', '', ['mobile']],
    ['Writing in plain English', '', ['content']],
    ['Accessible PDFs clinic', '', ['content']],
    ['WCAG 2.2 audits', '', ['testing']],
    ['What the EAA means for you', '', ['law']],
    ['ADA lawsuits explained', '', ['law']],
    ['Section 508 refresh', '', ['law']],
    ['EN 301 549 in practice', '', ['law']],
    ['Using a screen reader', '', ['assistive_tech']],
    ['NVDA and JAWS compared', '', ['assistive_tech']],
    ['Careers in accessibility', '', ['careers']],
  ])('"%s" → %j', (title, description, expected) => {
    expect(guessTopics(title, description)).toEqual(expected);
  });

  it('reads the description too, and keeps the list order', () => {
    expect(guessTopics('Evening talks', 'Testing with screen readers, and plain language tips.')).toEqual([
      'content',
      'testing',
      'assistive_tech',
    ]);
  });

  it('"ADA" and "EAA" only count in capitals; matches are whole words', () => {
    expect(guessTopics('Ada Lovelace day', '')).toEqual([]);
    expect(guessTopics('Contest night with lawns and mobiles?', '')).toEqual([]);
  });

  it('guesses nothing when nothing matches', () => {
    expect(guessTopics('Accessibility evening', null)).toEqual([]);
  });
});
