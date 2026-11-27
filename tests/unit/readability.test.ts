import { describe, expect, it } from 'vitest';
import { fleschKincaid, syllables } from '../../src/lib/text/readability.ts';

describe('readability', () => {
  it('counts syllables roughly', () => {
    expect(syllables('cat')).toBe(1);
    expect(syllables('table')).toBe(2);
    expect(syllables('accessibility')).toBeGreaterThanOrEqual(5);
  });

  it('scores simple text low and dense text high', () => {
    expect(fleschKincaid('The cat sat on the mat. It was warm. The sun was out.').grade).toBeLessThan(3);
    const dense =
      'Notwithstanding considerable organisational heterogeneity, interoperability considerations necessitate comprehensive standardisation methodologies.';
    expect(fleschKincaid(dense).grade).toBeGreaterThan(15);
  });

  it('ignores URLs and email addresses', () => {
    expect(
      fleschKincaid('Email hello@calenda11y.org. Go to https://calenda11y.org/about-the-accessibility-statement.')
        .words,
    ).toBe(3);
  });
});
