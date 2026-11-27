import { expect, expectNoAxeViolations, test } from '../a11y/fixtures.ts';
import { fleschKincaid } from '../../src/lib/text/readability.ts';

const SITE_COPY = [
  '/',
  '/about',
  '/accessibility',
  '/privacy',
  '/glossary',
  '/sponsor',
  '/subscribe',
  '/subscribe/email',
  '/submit',
  '/settings',
  '/calendar',
];
const KEY_PAGES = ['/', '/calendar', '/events/wcag-22-in-practice', '/submit', '/subscribe', '/sponsor'];

test.describe('launch checks', () => {
  for (const path of SITE_COPY) {
    test(`${path}: our own words read at grade 9 or below (3.1.5)`, async ({ page }) => {
      await page.goto(path);
      // Only our interface text: not event content (written by organisers, often
      // in other languages), not long lists of options, and not tables.
      const text = await page.evaluate(() =>
        [...document.querySelectorAll('main :is(h1,h2,h3,p,li,label,legend,dt,dd,summary,button)')]
          .filter((el) => !el.closest('select, table, .event, [lang]:not([lang="en"])') && !el.querySelector('.event'))
          .map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' '))
          .filter(Boolean)
          .map((t) => (/[.!?:]$/.test(t) ? t : `${t}.`))
          .join('\n'),
      );
      expect(fleschKincaid(text).grade).toBeLessThanOrEqual(9);
    });
  }

  for (const path of KEY_PAGES) {
    test(`${path}: nothing is cut off with WCAG text spacing applied (1.4.12)`, async ({ page }) => {
      await page.goto(path);
      // Applied through the CSSOM, the way a user style or extension would:
      // our CSP rightly blocks injected <style> tags.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>('*')) {
          el.style.setProperty('line-height', '1.5', 'important');
          el.style.setProperty('letter-spacing', '0.12em', 'important');
          el.style.setProperty('word-spacing', '0.16em', 'important');
          if (el.tagName === 'P') el.style.setProperty('margin-bottom', '2em', 'important');
        }
      });
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('main *')]
          .filter((el) => {
            const cs = getComputedStyle(el);
            if (cs.overflow !== 'hidden' && cs.overflowX !== 'hidden' && cs.overflowY !== 'hidden') return false;
            if (el.closest('.visually-hidden, .honeypot')) return false;
            return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
          })
          .map((el) => el.outerHTML.slice(0, 80)),
      );
      expect(clipped).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(
        0,
      );
    });

    test(`${path}: works at 400% zoom (1280px wide shown at 320px)`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 256 });
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(
        0,
      );
    });

    test(`${path}: passes axe with Windows forced colours`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await page.goto(path);
      await expectNoAxeViolations(page, `${path} forced colours`);
      await page.screenshot({
        path: `test-results/forced-colours${path.replace(/\//g, '_') || '_home'}.png`,
        fullPage: true,
      });
    });
  }

  test('respects the system dark mode when no theme is chosen', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(13, 23, 48)');
    await expectNoAxeViolations(page, 'dark mode');
  });

  test('nothing moves on its own', async ({ page }) => {
    await page.goto('/');
    const animated = await page.evaluate(
      () =>
        [...document.querySelectorAll('*')].filter((el) => {
          const cs = getComputedStyle(el);
          return cs.animationName !== 'none' || (cs.transitionDuration !== '0s' && cs.transitionProperty !== 'none');
        }).length,
    );
    expect(animated).toBe(0);
  });

  test('admin and test-only pages are never indexed or cached', async ({ request }) => {
    const res = await request.get('/admin/login');
    expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });
});
