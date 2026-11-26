/**
 * Parses colour tokens out of src/styles/tokens.css into one palette per
 * theme. The format is documented at the top of tokens.css.
 */

export type Palette = Record<string, string>;
export type Themes = Record<'light' | 'dark' | 'hc-dark' | 'hc-light', Palette>;

const BLOCK = /\/\* theme:([a-z+-]+) \*\/([\s\S]*?)\/\* \/theme \*\//g;
const DECL = /(--c-[a-z-]+):\s*([^;]+);/g;
const LIGHT_DARK = /^light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)$/i;
const HEX = /^#[0-9a-f]{6}$/i;

export function parseThemes(css: string): Themes {
  const themes: Partial<Themes> = {};
  for (const [, name, body] of css.matchAll(BLOCK)) {
    if (!name || body === undefined) continue;
    const decls = [...body.matchAll(DECL)].map(([, k, v]) => [k ?? '', (v ?? '').trim()] as const);
    if (name === 'light+dark') {
      const light: Palette = {};
      const dark: Palette = {};
      for (const [key, value] of decls) {
        const m = LIGHT_DARK.exec(value);
        if (!m?.[1] || !m[2]) throw new Error(`${key} must use light-dark(#hex, #hex), got "${value}"`);
        light[key] = m[1].toLowerCase();
        dark[key] = m[2].toLowerCase();
      }
      themes.light = light;
      themes.dark = dark;
    } else if (name === 'hc-dark' || name === 'hc-light') {
      const palette: Palette = {};
      for (const [key, value] of decls) {
        if (!HEX.test(value)) throw new Error(`${name} ${key} must be #rrggbb, got "${value}"`);
        palette[key] = value.toLowerCase();
      }
      themes[name] = palette;
    } else {
      throw new Error(`Unknown theme block "${name}"`);
    }
  }
  for (const t of ['light', 'dark', 'hc-dark', 'hc-light'] as const) {
    if (!themes[t]) throw new Error(`Missing theme block for ${t}`);
  }
  return themes as Themes;
}
