/**
 * Display settings (WCAG 1.4.8 Visual Presentation): theme, text size and
 * spacing, kept in a cookie and applied on the server so they work without
 * JavaScript.
 */

export const THEMES = ['system', 'light', 'dark', 'hc-dark', 'hc-light'] as const;
export const TEXT_SIZES = ['100', '125', '150', '175', '200'] as const;
export const SPACINGS = ['normal', 'wide'] as const;

export type Theme = (typeof THEMES)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type Spacing = (typeof SPACINGS)[number];

export interface DisplaySettings {
  theme: Theme;
  textSize: TextSize;
  spacing: Spacing;
}

export const DEFAULT_DISPLAY: DisplaySettings = { theme: 'system', textSize: '100', spacing: 'normal' };
export const DISPLAY_COOKIE = 'display';

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Parses the cookie value. Unknown or malformed values fall back to the defaults. */
export function parseDisplay(raw: string | undefined): DisplaySettings {
  if (!raw) return DEFAULT_DISPLAY;
  const params = new URLSearchParams(raw);
  return {
    theme: pick(THEMES, params.get('theme'), DEFAULT_DISPLAY.theme),
    textSize: pick(TEXT_SIZES, params.get('size'), DEFAULT_DISPLAY.textSize),
    spacing: pick(SPACINGS, params.get('spacing'), DEFAULT_DISPLAY.spacing),
  };
}

export function serializeDisplay(s: DisplaySettings): string {
  return new URLSearchParams({ theme: s.theme, size: s.textSize, spacing: s.spacing }).toString();
}

/** Attributes for the <html> element. */
export function displayAttributes(s: DisplaySettings): Record<string, string | undefined> {
  return {
    'data-theme': s.theme === 'system' ? undefined : s.theme,
    'data-text-size': s.textSize === '100' ? undefined : s.textSize,
    'data-spacing': s.spacing === 'normal' ? undefined : s.spacing,
  };
}
