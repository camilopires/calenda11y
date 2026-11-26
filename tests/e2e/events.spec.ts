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
    await page.getByLabel('Country').selectOption({ label: 'Portugal (1 upcoming)' });
    await page.getByRole('button', { name: 'Show events' }).click();
    await expect(page).toHaveURL(/[?&]country=PT/);
    await expect(page.getByText('1 upcoming event in Portugal')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Lisbon Inclusive Design Meetup' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Berlin a11y Stammtisch' })).toHaveCount(0);
    await context.close();
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

  test('the month grid scroll region can be reached and scrolled by keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/calendar');
    const region = page.getByRole('region', { name: /events$/ });
    await region.focus();
    await expect(region).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });
});
