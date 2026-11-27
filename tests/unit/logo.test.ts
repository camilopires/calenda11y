import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processLogo, validateProfile } from '../../src/lib/sponsors/profile.ts';

const png = async (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: '#0f1b3d' } })
    .png()
    .toBuffer();
const file = (buf: Buffer | string, name = 'logo.png', type = 'image/png') =>
  new File([typeof buf === 'string' ? buf : new Uint8Array(buf)], name, { type });

describe('processLogo', () => {
  it('re-encodes a real image as WebP', async () => {
    const r = await processLogo(file(await png(1200, 300)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const meta = await sharp(r.webp).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(800);
  });

  it('refuses something that only pretends to be an image', async () => {
    const r = await processLogo(file('<svg onload="alert(1)"></svg>', 'logo.png', 'image/png'));
    expect(r).toEqual({ ok: false, error: 'The logo must be a PNG, JPEG or WebP image' });
  });

  it('refuses SVG and GIF even when they are real', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    expect((await processLogo(file(svg, 'logo.svg', 'image/svg+xml'))).ok).toBe(false);
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } })
      .gif()
      .toBuffer();
    expect((await processLogo(file(gif, 'logo.gif', 'image/gif'))).ok).toBe(false);
  });

  it('refuses files over 1 MB and images over 2000 pixels', async () => {
    expect((await processLogo(file(Buffer.alloc(1024 * 1024 + 1)))).ok).toBe(false);
    const huge = await processLogo(file(await png(2500, 100)));
    expect(huge).toEqual({ ok: false, error: 'The logo must be at most 2000 × 2000 pixels' });
  });
});

describe('validateProfile', () => {
  it('needs a name, and alt text when there is a logo', () => {
    expect(validateProfile({ name: '', url: '', logo_alt: '', remove_logo: false }, false)).toEqual({
      name: 'Enter the name to show',
    });
    expect(validateProfile({ name: 'Acme', url: '', logo_alt: '', remove_logo: false }, true).logo_alt).toMatch(
      /Describe the logo/,
    );
    expect(
      validateProfile({ name: 'Acme', url: 'http://acme.example', logo_alt: '', remove_logo: false }, false).url,
    ).toMatch(/https/);
  });
});
