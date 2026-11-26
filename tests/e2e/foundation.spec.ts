import { expect, expectNoAxeViolations, expectValidHtml, test } from '../a11y/fixtures.ts';
import { measureFocus } from '../a11y/focus.ts';

const THEMES = ['light', 'dark', 'hc-dark', 'hc-light'] as const;

test.describe('foundation', () => {
  for (const theme of THEMES) {
    test(`styleguide passes axe in the ${theme} theme`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: 'display', value: `theme=${theme}`, url: baseURL! }]);
      await page.goto('/styleguide?errors=1');
      await expectNoAxeViolations(page, `styleguide (${theme})`);
    });
  }

  test('styleguide and settings are valid HTML', async ({ page }) => {
    await expectValidHtml(page, '/styleguide?errors=1');
    await expectValidHtml(page, '/settings');
  });

  test('error summary takes focus and links to its fields', async ({ page }) => {
    await page.goto('/styleguide?errors=1');
    await expect(page.locator('.error-summary')).toBeFocused();
    await page.getByRole('link', { name: 'Enter the event name' }).click();
    await expect(page.locator('#f-title')).toBeFocused();
  });

  test('the first Tab reaches the skip link, which moves to main', async ({ page }) => {
    await page.goto('/styleguide');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });

  for (const theme of THEMES) {
    test(`focus indicators meet 2.4.13 in the ${theme} theme`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: 'display', value: `theme=${theme}`, url: baseURL! }]);
      await page.goto('/styleguide');
      const targets = [
        page.getByRole('link', { name: 'link to the about page' }),
        page.getByRole('button', { name: 'Primary action' }),
        page.getByRole('button', { name: 'Secondary action' }),
        page.getByRole('textbox', { name: 'Event name' }),
        page.getByRole('combobox', { name: /Format/ }),
        page.getByRole('checkbox', { name: 'Live captions' }),
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Events' }),
      ];
      for (const target of targets) {
        const m = await measureFocus(page, target);
        expect(m.changedPixels, `${await target.textContent()} focus area`).toBeGreaterThanOrEqual(m.requiredPixels);
      }
    });
  }

  test('display settings save and apply without JavaScript', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: baseURL! });
    const page = await context.newPage();
    await page.goto('/settings');
    await page.getByRole('radio', { name: /High contrast, dark/ }).check();
    await page.getByRole('radio', { name: '150%' }).check();
    await page.getByRole('radio', { name: /Wide/ }).check();
    await page.getByRole('button', { name: 'Save display settings' }).click();
    await expect(page).toHaveURL(/\/settings\?saved=1$/);
    await expect(page.getByText('Your display settings are saved.')).toBeVisible();
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'hc-dark');
    await expect(html).toHaveAttribute('data-text-size', '150');
    await expect(html).toHaveAttribute('data-spacing', 'wide');
    await context.close();
  });

  test('cross-site form posts are blocked', async ({ request }) => {
    const res = await request.post('/settings', {
      headers: { origin: 'https://evil.example' },
      form: { theme: 'dark' },
    });
    expect(res.status()).toBe(403);
  });

  test('security headers are present', async ({ request }) => {
    const res = await request.get('/settings');
    const csp = res.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src [^;]*'sha256-/);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('reflows at 320px without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/styleguide?errors=1');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
