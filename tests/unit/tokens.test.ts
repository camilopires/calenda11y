import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../src/lib/a11y/contrast.ts';
import { parseThemes } from '../../src/lib/a11y/tokens.ts';

const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
const themes = parseThemes(css);

// [foreground, background, minimum ratio]
const TEXT = 7; // 1.4.6 Contrast (Enhanced)
const UI = 3; // 1.4.11 Non-text Contrast, 2.4.13 Focus Appearance
const PAIRS: Array<[string, string, number]> = [
  ['--c-text', '--c-bg', TEXT],
  ['--c-text', '--c-surface', TEXT],
  ['--c-text-muted', '--c-bg', TEXT],
  ['--c-text-muted', '--c-surface', TEXT],
  ['--c-link', '--c-bg', TEXT],
  ['--c-link', '--c-surface', TEXT],
  ['--c-link-visited', '--c-bg', TEXT],
  ['--c-link-visited', '--c-surface', TEXT],
  ['--c-error', '--c-bg', TEXT],
  ['--c-error', '--c-surface', TEXT],
  ['--c-success', '--c-bg', TEXT],
  ['--c-success', '--c-surface', TEXT],
  ['--c-on-accent', '--c-accent', TEXT],
  ['--c-on-highlight', '--c-highlight', TEXT],
  ['--c-surface', '--c-error', TEXT], // text on .button--danger
  ['--c-border', '--c-bg', UI],
  ['--c-border', '--c-surface', UI],
  ['--c-focus-ring', '--c-bg', UI],
  ['--c-focus-ring', '--c-surface', UI],
  ['--c-accent', '--c-bg', UI],
  ['--c-accent', '--c-surface', UI],
];

describe('design tokens', () => {
  it('defines all four themes with the same tokens', () => {
    const keys = Object.keys(themes.light).sort();
    for (const palette of Object.values(themes)) {
      expect(Object.keys(palette).sort()).toEqual(keys);
    }
  });

  for (const [name, palette] of Object.entries(themes)) {
    describe(`${name} theme`, () => {
      it.each(PAIRS)('%s on %s reaches %s:1', (fg, bg, min) => {
        const a = palette[fg];
        const b = palette[bg];
        expect(a, `${fg} missing`).toBeDefined();
        expect(b, `${bg} missing`).toBeDefined();
        expect(contrastRatio(a!, b!)).toBeGreaterThanOrEqual(min);
      });
    });
  }
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});
