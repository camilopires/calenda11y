import { expect, expectNoAxeViolations, expectValidHtml, test } from '../a11y/fixtures.ts';
import { clearOutbox, fillEventForm, ownIp, sentEmails, service, uniq } from './support.ts';

test.describe('adding an event', () => {
  test.beforeEach(async ({ page }) => {
    await ownIp(page);
    clearOutbox();
  });

  test('works start to finish without JavaScript, including changing an answer', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: baseURL! });
    const page = await context.newPage();
    await ownIp(page);
    const title = `No JS meetup ${uniq()}`;
    await page.goto('/submit');
    await fillEventForm(page, { title: `${title} typo` });
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Check your answers' })).toBeVisible();
    await expect(page.getByText(`${title} typo`)).toBeVisible();
    await page.getByRole('button', { name: 'Change event name' }).click();
    await expect(page).toHaveURL(/\/submit#f-title$/);
    await page.getByLabel('Event name').fill(title);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Send for review' }).click();

    await expect(page).toHaveURL(/\/submit\/done$/);
    await expect(page.getByRole('heading', { name: 'Event sent for review' })).toBeVisible();
    await context.close();

    const { data } = await service()
      .from('events')
      .select('status, flags, starts_at, country_code')
      .eq('title', title)
      .single();
    expect(data).toMatchObject({
      status: 'pending',
      country_code: 'PT',
      starts_at: expect.stringMatching(/T17:30:00|T18:30:00/),
    });
    // Without JavaScript the spam check can't run, so the event is flagged for a closer look.
    expect(data!.flags).toContain('captcha_unverified');
    const email = sentEmails().find((m) => m.subject === `We've got your event: ${title}`);
    expect(email?.to).toBe('organiser@example.test');
  });

  test('sending the same answers twice creates one event', async ({ page }) => {
    const title = `Twice ${uniq()}`;
    await page.goto('/submit');
    await fillEventForm(page, { title });
    await page.getByRole('button', { name: 'Continue' }).click();
    const payload = await page.locator('input[name="payload"]').inputValue();
    await page.getByRole('button', { name: 'Send for review' }).click();
    await expect(page).toHaveURL(/\/submit\/done$/);
    const again = await page.request.post('/submit', {
      form: { step: 'confirm', payload },
      headers: { origin: new URL(page.url()).origin },
      maxRedirects: 0,
    });
    expect(again.status()).toBe(303);
    expect(again.headers().location).toBe('/submit/done?already=1');
    const { count } = await service().from('events').select('id', { count: 'exact', head: true }).eq('title', title);
    expect(count).toBe(1);
  });

  test('shows an error summary that takes focus and links to each field', async ({ page }) => {
    await page.goto('/submit');
    await page.getByLabel('Event website').fill('http://not-secure.example');
    await page.getByRole('button', { name: 'Continue' }).click();
    const summary = page.locator('.error-summary');
    await expect(summary).toBeFocused();
    expect(await summary.getByRole('link').count()).toBeGreaterThanOrEqual(9);
    await summary.getByRole('link', { name: 'Enter the website address in full, starting with https://' }).click();
    await expect(page.getByLabel('Event website')).toBeFocused();
    // What was typed is kept.
    await expect(page.getByLabel('Event website')).toHaveValue('http://not-secure.example');
    await expect(page.getByLabel('Event website')).toHaveAttribute('aria-invalid', 'true');
  });

  test('a tampered check page is refused', async ({ page }) => {
    await page.goto('/submit');
    const res = await page.request.post('/submit', {
      form: { step: 'confirm', payload: 'eyJmYWtlIjoxfQ.bad' },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(await res.text()).toContain('Something went wrong with your answers');
  });

  test('the form, errors, check page and done page pass axe', async ({ page }) => {
    await page.goto('/submit');
    await expectNoAxeViolations(page, 'submit form');
    await expectValidHtml(page, '/submit');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expectNoAxeViolations(page, 'submit errors');
    await fillEventForm(page, { title: `Axe ${uniq()}`, online: true });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Check your answers' })).toBeFocused();
    await expectNoAxeViolations(page, 'check answers');
    await page.getByRole('button', { name: 'Send for review' }).click();
    await expectNoAxeViolations(page, 'done');
  });
});

test.describe('reporting a problem', () => {
  test('can be done with the keyboard alone', async ({ page }) => {
    await ownIp(page);
    clearOutbox();
    await page.goto('/report/lisbon-inclusive-design-meetup');
    await expectNoAxeViolations(page, 'report form');
    // Tab to the first reason and choose "The event has been cancelled or moved".
    const first = page.getByRole('radio').first();
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /cancelled or moved/ })).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/Details/)).toBeFocused();
    await page.keyboard.type('It moved to next week.');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Check your report' })).toBeFocused();
    await expectNoAxeViolations(page, 'report check');
    await page.getByRole('button', { name: 'Send report' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Report sent' })).toBeVisible();
    const { data } = await service()
      .from('event_reports')
      .select('reason, details')
      .eq('details', 'It moved to next week.')
      .limit(1)
      .single();
    expect(data!.reason).toBe('cancelled');
  });
});
