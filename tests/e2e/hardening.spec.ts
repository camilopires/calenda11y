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
  '/topics',
];
const KEY_PAGES = [
  '/',
  '/calendar',
  '/events/wcag-22-in-practice',
  '/submit',
  '/subscribe',
  '/sponsor',
  '/topics/testing',
  '/?topic=assistive-technology',
];

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

test.describe('long words and big text (1.4.10, 1.4.4)', () => {
  const tag = `${Date.now().toString(36)}`;
  const long = `Supercalifragilisticexpialidocious${tag}Accessibility`;
  const slug = `long-words-${tag}`;
  const soon = new Date(Date.now() + 3_600_000);

  test.beforeAll(async () => {
    const { service } = await import('./support.ts');
    const { error } = await service()
      .from('events')
      .insert({
        slug,
        title: `${long} meetup`,
        summary: `About ${long} and more.`,
        organiser: `${long} Collective`,
        timezone: 'UTC',
        format: 'in_person',
        country_code: 'PT',
        city: 'Lisbon',
        types: ['meetup'],
        topics: ['careers'],
        starts_at: soon.toISOString(),
        ends_at: new Date(soon.getTime() + 3_600_000).toISOString(),
        url: 'https://example.org/long',
        status: 'approved',
      });
    if (error) throw error;
  });

  // A sponsor whose name is one long word, listed in every page's footer.
  // Publishing it from the admin page also clears the cached sponsor list.
  const sponsorName = `${long}Sponsor`;
  test.beforeAll(async ({ browser }) => {
    const { ensureAdmin, service, signIn } = await import('./support.ts');
    const { data: sponsor, error } = await service()
      .from('sponsors')
      .insert({ stripe_customer_id: `cus_long${tag}`, name: sponsorName, profile_status: 'pending' })
      .select('id')
      .single();
    if (error) throw error;
    const { error: planError } = await service()
      .from('sponsorships')
      .insert({
        sponsor_id: sponsor.id,
        kind: 'subscription',
        tier: 'supporter',
        billing_interval: 'month',
        stripe_subscription_id: `sub_long${tag}`,
        stripe_status: 'active',
        updated_from_stripe_at: new Date().toISOString(),
      });
    if (planError) throw planError;
    const page = await browser.newPage();
    await signIn(page, await ensureAdmin(), '/admin/sponsors');
    await page.getByRole('button', { name: new RegExp(`^Publish profile\\s?: ${sponsorName}$`) }).click();
    await expect(page.locator('.notice--success')).toBeVisible();
    await page.close();
  });

  test.afterAll(async () => {
    const { service } = await import('./support.ts');
    await service().from('events').delete().eq('slug', slug);
    await service().from('sponsors').delete().eq('stripe_customer_id', `cus_long${tag}`);
  });

  const cases = [
    { width: 320, display: 'size=100' },
    { width: 320, display: 'size=125&spacing=wide' },
    { width: 320, display: 'size=150' },
    { width: 320, display: 'size=175&spacing=wide' },
    { width: 320, display: 'size=200&spacing=wide' },
    { width: 640, display: 'size=200' },
    { width: 640, display: 'size=200&spacing=wide' },
  ];
  for (const c of cases) {
    test(`no sideways scrolling at ${c.width}px with ${c.display}`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width: c.width, height: 900 });
      await page.context().addCookies([{ name: 'display', value: c.display, url: baseURL! }]);
      for (const path of [
        '/',
        '/topics/careers',
        '/countries/pt',
        '/about',
        '/submit',
        '/subscribe',
        '/sponsor',
        '/settings',
      ]) {
        await page.goto(path);
        // The browser's own date control can't shrink below its digits: at 320px with
        // 175% text or more and wide spacing it is wider than the screen. Shrinking it
        // would cut the date off, which is worse. (WCAG's reflow test uses default text.)
        if (path === '/submit' && c.width === 320 && /size=(175|200)&spacing=wide/.test(c.display)) continue;
        if (['/', '/topics/careers', '/countries/pt'].includes(path))
          await expect(page.getByRole('link', { name: `${long} meetup` })).toBeVisible();
        await expect(page.locator('footer')).toContainText(sponsorName);
        const problem = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          if (document.documentElement.scrollWidth > vw)
            return `page is ${document.documentElement.scrollWidth}px wide`;
          // Nothing sticks out of its card or the screen, even where overflow would hide it.
          for (const el of document.querySelectorAll<HTMLElement>('.event *, .wordmark, .wordmark *')) {
            const r = el.getBoundingClientRect();
            if (r.width && r.right > vw + 0.5) return `${el.tagName}.${el.className} ends at ${r.right}`;
            const card = el.closest('.event');
            if (card && r.width && r.right > card.getBoundingClientRect().right + 0.5)
              return `${el.tagName}.${el.className} sticks out of its card`;
          }
          return null;
        });
        expect(problem, `${path} at ${c.width}px, ${c.display}`).toBeNull();
      }
    });
  }
});

test.describe('focused links stay readable once visited (1.4.3, 1.4.6)', () => {
  const LINKS = [
    { path: '/', selector: '.site-nav a', name: 'nav link' },
    { path: '/', selector: '.site-footer a', name: 'footer link' },
    { path: '/', selector: 'a.wordmark', name: 'wordmark' },
    { path: '/', selector: '.pagination a', name: 'pagination link' },
    { path: '/glossary', selector: '.breadcrumbs a', name: 'breadcrumb' },
    { path: '/styleguide', selector: 'a.button', name: 'button link' },
    { path: '/calendar', selector: 'a.button--secondary', name: 'secondary button link' },
  ];

  /** The highest contrast between the most common colour in a screenshot and any other pixel in it. */
  async function paintedContrast(png: Buffer): Promise<number> {
    const sharp = (await import('sharp')).default;
    const { contrastRatio } = await import('../../src/lib/a11y/contrast.ts');
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const hex = (i: number) =>
      `#${[data[i]!, data[i + 1]!, data[i + 2]!].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    const counts = new Map<string, number>();
    for (let i = 0; i < data.length; i += info.channels) counts.set(hex(i), (counts.get(hex(i)) ?? 0) + 1);
    const background = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    let best = 1;
    for (const colour of counts.keys()) best = Math.max(best, contrastRatio(background, colour));
    return best;
  }

  for (const theme of ['light', 'dark', 'hc-dark', 'hc-light']) {
    test(`in the ${theme} theme`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: 'display', value: `theme=${theme}`, url: baseURL! }]);
      const cdp = await page.context().newCDPSession(page);
      for (const l of LINKS) {
        await page.goto(l.path);
        const link = page.locator(l.selector).first();
        await expect(link, `${l.name} on ${l.path}`).toBeVisible();
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const { root } = await cdp.send('DOM.getDocument');
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: l.selector });
        for (const state of [['focus-visible'], ['visited', 'focus-visible']]) {
          await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state });
          const ratio = await paintedContrast(await link.screenshot({ animations: 'disabled' }));
          expect(ratio, `${l.name} on ${l.path}, ${state.join(' + ')}, ${theme}`).toBeGreaterThanOrEqual(7);
        }
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
      }
    });
  }
});
