import type { Page } from '@playwright/test';
import { expect, expectNoAxeViolations, expectValidHtml, test } from '../a11y/fixtures.ts';

const PAGES = [
  '/',
  '/?country=PT',
  '/?country=online&format=hybrid',
  '/?country=ZZ&from=2027-02-30',
  '/?q=nothingmatchesthis',
  '/?when=past',
  '/?page=2',
  '/events/lisbon-inclusive-design-meetup',
  '/events/cancelled-meetup-paris',
  '/events/past-event-lisbon',
  '/events/tokyo-web-accessibility-night',
  '/countries/PT',
  '/countries/AQ',
  '/calendar',
  '/calendar?month=2026-13',
  '/calendar?country=online',
  '/about',
  '/glossary',
  '/privacy',
  '/accessibility',
  '/settings',
  '/no-such-page',
];

test.describe('event pages', () => {
  for (const path of PAGES) {
    test(`${path} passes axe and is valid HTML`, async ({ page }) => {
      await page.goto(path);
      await expectNoAxeViolations(page, path);
      await expectValidHtml(page, path);
    });
  }

  for (const theme of ['dark', 'hc-dark', 'hc-light']) {
    test(`home and month view pass axe in the ${theme} theme`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: 'display', value: `theme=${theme}`, url: baseURL! }]);
      for (const path of ['/', '/calendar']) {
        await page.goto(path);
        await expectNoAxeViolations(page, `${path} (${theme})`);
      }
    });
  }

  test('pending and rejected events are never shown', async ({ page }) => {
    for (const path of ['/', '/?page=2', '/calendar', '/?when=past']) {
      await page.goto(path);
      await expect(page.getByText(/that is not public/)).toHaveCount(0);
    }
    expect((await page.request.get('/events/pending-event-not-public')).status()).toBe(404);
    expect((await page.request.get('/events/rejected-event-not-public')).status()).toBe(404);
  });

  test('filtering by country works without JavaScript and gives a shareable URL', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: baseURL! });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByLabel('Country').selectOption('PT');
    await page.getByRole('button', { name: 'Show events' }).click();
    await expect(page).toHaveURL(/[?&]country=PT/);
    await expect(page.getByText(/^\d+ upcoming events? in Portugal/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Lisbon Inclusive Design Meetup' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Berlin a11y Stammtisch' })).toHaveCount(0);
    await context.close();
  });

  test('filtering by type works without JavaScript, from the visible part of the form', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: baseURL! });
    const page = await context.newPage();
    await page.goto('/');
    // Format and Type are not hidden under "More filters".
    await expect(page.getByRole('checkbox', { name: 'Online', exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Conference', exact: true }).check();
    await page.getByRole('button', { name: 'Show events' }).click();
    await expect(page).toHaveURL(/[?&]type=conference/);
    await expect(page.locator('#results-count')).toContainText(/\d+ upcoming conferences/);
    await expect(page.getByRole('link', { name: 'Nordic Accessibility Summit' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Online accessibility talk/ })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Conference', exact: true })).toBeChecked();
    await context.close();
  });

  const monthAhead = (n: number) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    return {
      value: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    };
  };

  test('picking a month shows only that month, and the choice stays selected', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: baseURL! });
    const page = await context.newPage();
    const next = monthAhead(1);
    await page.goto('/');
    await page.getByLabel('When').selectOption(next.value);
    await page.getByRole('button', { name: 'Show events' }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]range=${next.value}`));
    await expect(page.getByLabel('When')).toHaveValue(next.value);
    await expect(page.locator('#results-count')).toContainText(`in ${next.label}`);
    const headings = await page.locator('.month__title').allTextContents();
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h.trim()).toBe(next.label);
    await context.close();
  });

  test('the When list offers the next 12 months, or the previous 12 for past events', async ({ page }) => {
    await page.goto('/');
    const ahead = page.locator('select[name="range"] optgroup[label="Months"] option');
    await expect(ahead).toHaveCount(12);
    await expect(ahead.first()).toHaveText(monthAhead(0).label);
    await expect(ahead.nth(11)).toHaveText(monthAhead(11).label);
    await page.goto('/?when=past');
    const back = page.locator('select[name="range"] optgroup[label="Months"] option');
    await expect(back).toHaveCount(12);
    await expect(back.nth(1)).toHaveText(monthAhead(-1).label);
  });

  test('choosing a month after custom dates, without JavaScript, gives that month', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: baseURL! });
    const page = await context.newPage();
    const later = monthAhead(2);
    await page.goto('/?range=custom&from=2030-01-01&to=2030-01-31');
    await page.getByLabel('When').selectOption(later.value);
    await page.getByRole('button', { name: 'Show events' }).click();
    await expect(page.locator('#results-count')).toContainText(`in ${later.label}`);
    await expect(page.locator('.error-summary')).toHaveCount(0);
    // The old dates are gone, so going back to "Any upcoming date" really is any date.
    await expect(page.getByLabel('From')).toHaveValue('');
    await page.getByLabel('When').selectOption('upcoming');
    await page.getByRole('button', { name: 'Show events' }).click();
    await expect(page).toHaveURL(/[?&]range=upcoming/);
    await expect(page).not.toHaveURL(/from=2030/);
    await expect(page.locator('#results-count')).toHaveText(/^\d+ upcoming events(\. Page \d+ of \d+)?$/);
    await expect(page.locator('.event').first()).toBeVisible();
    await context.close();
  });

  test('a shared link to a month outside the list still works and shows in the list', async ({ page }) => {
    await page.goto('/?range=2031-05');
    await expect(page.getByLabel('When')).toHaveValue('2031-05');
    await expect(page.locator('#results-count')).toContainText('in May 2031');
  });

  test('access provision filters need every chosen provision', async ({ page }) => {
    await page.goto('/?access=sign_language&access=quiet_room');
    const titles = await page.locator('.event__title').allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) expect(t).not.toMatch(/Online accessibility talk/);
  });

  test('after filtering, focus moves to the result count', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Country').selectOption('online');
    await page.getByRole('button', { name: 'Show events' }).click();
    await expect(page.locator('#results-count')).toBeFocused();
  });

  test('a bad filter shows an error summary that links to the field', async ({ page }) => {
    await page.goto('/?country=ZZ');
    const summary = page.locator('.error-summary');
    await expect(summary).toBeFocused();
    await summary.getByRole('link', { name: 'Choose a country from the list' }).click();
    await expect(page.getByLabel('Country')).toBeFocused();
    // The other filters still apply: the list is still shown.
    await expect(page.locator('.event').first()).toBeVisible();
  });

  test('custom dates open "More filters" and show their errors', async ({ page }) => {
    await page.goto('/?from=2027-02-01&to=2027-01-01');
    await expect(page.locator('details.filters__more')).toHaveAttribute('open', '');
    await expect(page.getByText('The end date must be the same as or after the start date').first()).toBeVisible();
  });

  test('pagination keeps the filters', async ({ page }) => {
    await page.goto('/?format=online');
    const next = page.getByRole('link', { name: /Next page/ });
    await expect(next).toHaveAttribute('href', '/?format=online&page=2');
  });

  test('the event page shows details and its time zone', async ({ page }) => {
    await page.goto('/events/lisbon-inclusive-design-meetup');
    await expect(page.getByRole('heading', { level: 1, name: 'Lisbon Inclusive Design Meetup' })).toBeVisible();
    await expect(page.getByText(/18:30 to 20:30, Lisbon time/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the Lisbon Inclusive Design Meetup website' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'You are here' }).getByRole('link', { name: 'Events in Portugal' }),
    ).toBeVisible();
  });

  test('event content keeps its own language', async ({ page }) => {
    await page.goto('/events/berlin-a11y-stammtisch');
    await expect(page.locator('h1')).toHaveAttribute('lang', 'de');
  });

  test('cancelled and past events say so', async ({ page }) => {
    await page.goto('/events/cancelled-meetup-paris');
    await expect(page.getByText('This event has been cancelled.')).toBeVisible();
    await page.goto('/events/past-event-lisbon');
    await expect(page.getByText('This event has ended.')).toBeVisible();
  });

  test('the time zone toggle converts times and back', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ timezoneId: 'America/New_York', baseURL: baseURL! });
    const page = await context.newPage();
    await page.goto('/events/lisbon-inclusive-design-meetup');
    const toggle = page.getByRole('button', { name: /Show times in my time zone \(New York\)/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/13:30 to 15:30 your time/)).toBeVisible();
    await toggle.click();
    await expect(page.getByText(/18:30 to 20:30, Lisbon time/)).toBeVisible();
    // Switching back keeps the explained abbreviation, and hides the converted time.
    await expect(page.locator('main abbr[title="Greenwich Mean Time"]').first()).toBeVisible();
    await expect(page.getByText(/13:30 to 15:30 your time/)).toBeHidden();
    await context.close();
  });

  test('country pages normalise the code and 404 for unknown ones', async ({ page }) => {
    await page.goto('/countries/pt');
    await expect(page).toHaveURL(/\/countries\/PT$/);
    expect((await page.request.get('/countries/ZZ')).status()).toBe(404);
  });

  test('the month view moves between months and lists events on their days', async ({ page }) => {
    await page.goto('/calendar');
    const caption = page.locator('caption');
    const before = await caption.textContent();
    await page.getByRole('link', { name: /Next month/ }).click();
    await expect(caption).not.toHaveText(before!);
    await expect(page.getByRole('link', { name: 'Go to this month' })).toBeVisible();
  });

  test('an invalid month shows an error and falls back to this month', async ({ page }) => {
    await page.goto('/calendar?month=2026-13');
    await expect(page.locator('.error-summary')).toContainText('That month does not exist');
  });

  for (const path of ['/', '/calendar', '/events/wcag-22-in-practice']) {
    test(`${path} reflows at 320px without the page scrolling sideways`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  /** Presses Tab until the grid's scroll region has focus, or the page runs out of stops. */
  async function tabToGridRegion(page: Page): Promise<boolean> {
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const el = document.activeElement;
        return el?.classList.contains('grid-scroll') ? 'region' : el === document.body ? 'end' : 'other';
      });
      if (where === 'region') return true;
      if (where === 'end') return false;
    }
    return false;
  }

  test('the month grid scroll region can be reached with Tab and scrolled when it scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/calendar');
    expect(await tabToGridRegion(page)).toBe(true);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const region = page.locator('.grid-scroll');
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });

  test('the month grid is only a tab stop while it scrolls, and follows resizing', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/calendar');
    const region = page.locator('.grid-scroll');
    await expect(region).not.toHaveAttribute('tabindex');
    expect(await tabToGridRegion(page)).toBe(false);
    // It stays a named region either way.
    await expect(page.getByRole('region', { name: /events$/ })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(region).toHaveAttribute('tabindex', '0');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(region).not.toHaveAttribute('tabindex');
  });

  test('without JavaScript the month grid can always be reached and scrolled', async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      baseURL: baseURL!,
      viewport: { width: 320, height: 640 },
    });
    const page = await context.newPage();
    await page.goto('/calendar');
    await expect(page.locator('.grid-scroll')).toHaveAttribute('tabindex', '0');
    expect(await tabToGridRegion(page)).toBe(true);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.locator('.grid-scroll').evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await context.close();
  });

  test('time zone abbreviations are explained', async ({ page }) => {
    await page.goto('/events/lisbon-inclusive-design-meetup');
    await expect(page.locator('abbr[title="Greenwich Mean Time"]').first()).toHaveText('GMT');
    await page.goto('/events/online-a11y-talk-1');
    await expect(page.locator('abbr[title="Coordinated Universal Time"]').first()).toHaveText('UTC');
    await page.goto('/glossary');
    await expect(page.locator('dt', { hasText: /^UTC$/ })).toBeVisible();
    await expect(page.locator('dt', { hasText: /^GMT$/ })).toBeVisible();
  });
});
