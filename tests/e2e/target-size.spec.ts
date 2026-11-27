import { expect, test } from '../a11y/fixtures.ts';
import { ensureAdmin, signIn } from './support.ts';

/**
 * WCAG 2.5.5 Target Size (Enhanced): targets are at least 44 × 44 CSS px,
 * except links inside a sentence or block of text. axe's target-size rule
 * only checks the AA 24px minimum, so this measures real sizes.
 */
async function smallTargets(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const MIN = 44;
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.closest('.visually-hidden, .honeypot, [hidden]');
    };
    for (const el of document.querySelectorAll(
      'a[href], button, select, input:not([type=hidden]), textarea, summary',
    )) {
      if (!visible(el)) continue;
      const input = el as HTMLInputElement;
      // A checkbox or radio's target includes its label row.
      const box =
        (input.type === 'checkbox' || input.type === 'radio' ? el.closest('.choice, .checkbox-target') : null) ?? el;
      const r = box.getBoundingClientRect();
      if (r.height >= MIN - 0.5 && r.width >= MIN - 0.5) continue;
      if (el.tagName === 'A') {
        // Inline exception: the link sits in a sentence with other text.
        const block = el.closest('p, li, dd, td, th, h1, h2, h3, figcaption, label, .hint');
        const own = (el.textContent ?? '').trim().length;
        if (block && (block.textContent ?? '').trim().length > own + 3) continue;
      }
      out.push(
        `${el.tagName.toLowerCase()} "${(el.textContent ?? (el as HTMLInputElement).name ?? '').trim().slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
      );
    }
    return out;
  });
}

test.describe('target size', () => {
  for (const path of [
    '/',
    '/calendar',
    '/events/lisbon-inclusive-design-meetup',
    '/submit',
    '/subscribe',
    '/subscribe/email',
    '/sponsor',
    '/settings',
    '/about',
    '/glossary',
    '/privacy',
    '/accessibility',
    '/countries/PT',
  ]) {
    test(`${path}: every target is at least 44 × 44`, async ({ page }) => {
      await page.goto(path);
      expect(await smallTargets(page)).toEqual([]);
    });
  }

  test('admin pages: every target is at least 44 × 44', async ({ page }) => {
    await signIn(page, await ensureAdmin());
    for (const path of [
      '/admin',
      '/admin/sources',
      '/admin/reports',
      '/admin/jobs',
      '/admin/email-outbox',
      '/admin/sponsors',
    ]) {
      await page.goto(path);
      expect(await smallTargets(page), path).toEqual([]);
    }
  });
});
