import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, displayAttributes, parseDisplay, serializeDisplay } from '../../src/lib/display.ts';

describe('display settings', () => {
  it('defaults when the cookie is missing or junk', () => {
    expect(parseDisplay(undefined)).toEqual(DEFAULT_DISPLAY);
    expect(parseDisplay('theme=<script>&size=9000&spacing=x')).toEqual(DEFAULT_DISPLAY);
  });

  it('round-trips valid settings', () => {
    const s = { theme: 'hc-dark', textSize: '175', spacing: 'wide' } as const;
    expect(parseDisplay(serializeDisplay(s))).toEqual(s);
  });

  it('omits attributes for defaults', () => {
    expect(displayAttributes(DEFAULT_DISPLAY)).toEqual({
      'data-theme': undefined,
      'data-text-size': undefined,
      'data-spacing': undefined,
    });
    expect(displayAttributes({ theme: 'dark', textSize: '150', spacing: 'wide' })).toEqual({
      'data-theme': 'dark',
      'data-text-size': '150',
      'data-spacing': 'wide',
    });
  });
});
