import type { Locator, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { contrastRatio } from '../../src/lib/a11y/contrast.ts';

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

export interface FocusMeasurement {
  /** Pixels whose colour changed by at least 3:1 between unfocused and focused. */
  changedPixels: number;
  /** WCAG 2.4.13 minimum: the area of a 2px-thick perimeter of the unfocused component. */
  requiredPixels: number;
}

/**
 * Measures WCAG 2.4.13 Focus Appearance by comparing the same pixels with
 * and without focus. Screenshots are taken with deviceScaleFactor 1, so one
 * pixel is one CSS pixel.
 */
export async function measureFocus(page: Page, target: Locator, pad = 8): Promise<FocusMeasurement> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  // Make sure nothing is focused and the pointer isn't hovering.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const box = await target.boundingBox();
  if (!box) throw new Error('Target is not visible');
  const clip = {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
  const before = PNG.sync.read(await page.screenshot({ clip }));
  // Focus by keyboard so :focus-visible applies.
  await target.evaluate((el) => (el as HTMLElement).setAttribute('data-focus-probe', ''));
  await page.keyboard.press('Shift'); // keyboard modality, so :focus-visible applies
  await target.focus();
  const after = PNG.sync.read(await page.screenshot({ clip }));
  await target.evaluate((el) => (el as HTMLElement).removeAttribute('data-focus-probe'));

  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const a = hex(before.data[i]!, before.data[i + 1]!, before.data[i + 2]!);
    const b = hex(after.data[i]!, after.data[i + 1]!, after.data[i + 2]!);
    if (a !== b && contrastRatio(a, b) >= 3) changed++;
  }
  const required = Math.round(2 * 2 * (box.width + box.height));
  return { changedPixels: changed, requiredPixels: required };
}
