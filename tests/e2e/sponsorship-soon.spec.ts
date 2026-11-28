/**
 * With SPONSORSHIP=soon (the production default), the site takes no payments:
 * /sponsor says sponsorship opens soon, and every payment page and endpoint
 * is switched off, for viewing and for sending forms. Runs against a second
 * server started with SPONSORSHIP=soon (see playwright.config.ts).
 */
import Stripe from 'stripe';
import { expect, expectNoAxeViolations, expectValidHtml, test } from '../a11y/fixtures.ts';
import { sha256 } from '../../src/lib/security/tokens.ts';
import { clearOutbox, ownIp, sentEmails, service, uniq } from './support.ts';

const CONTACT = 'hello@calenda11y.org';

async function sponsorWithToken(purpose: 'sponsor_profile' | 'sponsor_portal') {
  const { data: sponsor, error } = await service()
    .from('sponsors')
    .insert({ stripe_customer_id: `cus_soon${uniq()}`, contact_email: `soon-${uniq()}@example.test`, name: 'Soon Co' })
    .select('id,contact_email')
    .single();
  if (error) throw error;
  const token = `soon${uniq()}${'x'.repeat(24)}`.replace(/[^A-Za-z0-9_-]/g, '');
  const { error: tokenError } = await service()
    .from('tokens')
    .insert({
      purpose,
      subject_id: sponsor.id,
      hash: sha256(token),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  if (tokenError) throw tokenError;
  return { sponsor, token };
}

const tokenUsed = async (token: string) =>
  (await service().from('tokens').select('used_at').eq('hash', sha256(token)).single()).data!.used_at !== null;

test.describe('sponsorship coming soon', () => {
  test.beforeEach(async ({ page }) => {
    await ownIp(page);
    clearOutbox();
  });

  test('the sponsor page says sponsorship opens soon, with no way to pay', async ({ page }) => {
    for (const path of ['/sponsor', '/sponsor?error=choice', '/sponsor?cancelled=1']) {
      await page.goto(path);
      await expect(page).toHaveTitle(/^Sponsor calenda11y/);
      await expect(page.getByRole('heading', { level: 1, name: 'Sponsor calenda11y' })).toBeVisible();
      await expect(page.getByText('Sponsorship opens soon.')).toBeVisible();
      await expect(page.getByRole('link', { name: CONTACT })).toHaveAttribute('href', `mailto:${CONTACT}`);
      await expect(page.locator('main form')).toHaveCount(0);
      await expect(page.locator('main button')).toHaveCount(0);
      await expect(page.locator('.notice')).toHaveCount(0);
    }
    await page.goto('/sponsor');
    await expectNoAxeViolations(page, '/sponsor (soon)');
    await expectValidHtml(page, '/sponsor');
  });

  test('the menu and footer still link to the sponsor page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('header nav a[href="/sponsor"]')).toHaveCount(1);
    await expect(page.locator('footer a[href="/sponsor"]')).toHaveCount(1);
  });

  test('payment pages are not found', async ({ request }) => {
    for (const path of [
      '/sponsor/manage',
      '/sponsor/profile',
      '/sponsor/thanks?session_id=cs_test_x',
      '/sponsor/portal?token=x',
      '/sponsor/test-checkout?session=cs_test_x',
      '/api/sponsor/portal?token=x',
      '/api/test/stripe?session=cs_test_x',
    ]) {
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(404);
    }
    // The fake checkout is switched off, not just missing this session: with
    // sponsorship open, an unknown session gets a short "Unknown session".
    const fake = await request.get('/sponsor/test-checkout?session=cs_test_x');
    expect(await fake.text()).not.toContain('Unknown session');
  });

  test('payment forms and endpoints are not found, and do nothing', async ({ page, baseURL }) => {
    const origin = { origin: baseURL! };
    const post = (path: string, form: Record<string, string> = {}) =>
      page.request.post(path, { headers: origin, form, maxRedirects: 0 });

    expect((await post('/api/sponsor/checkout', { tier: 'bronze', interval: 'month' })).status()).toBe(404);
    expect((await post('/api/sponsor/checkout', { tier: 'donation' })).status()).toBe(404);
    const fakePay = await post('/sponsor/test-checkout?session=cs_test_x', { outcome: 'paid' });
    expect(fakePay.status()).toBe(404);
    expect(await fakePay.text()).not.toContain('Unknown session');
    expect(
      (
        await page.request.post('/api/test/stripe', { headers: origin, data: { session: { id: 'cs_test_soon' } } })
      ).status(),
    ).toBe(404);

    // Asking for sponsor links sends nothing.
    const { sponsor } = await sponsorWithToken('sponsor_portal');
    expect((await post('/sponsor/manage', { email: sponsor.contact_email! })).status()).toBe(404);
    expect(sentEmails().filter((m) => m.to === sponsor.contact_email)).toEqual([]);

    // One-time links aren't used up.
    const profile = await sponsorWithToken('sponsor_profile');
    expect((await post(`/sponsor/profile?token=${profile.token}`)).status()).toBe(404);
    expect(await tokenUsed(profile.token)).toBe(false);
    const portal = await sponsorWithToken('sponsor_portal');
    expect((await post(`/api/sponsor/portal?token=${portal.token}`)).status()).toBe(404);
    expect(await tokenUsed(portal.token)).toBe(false);

    // Saving a profile changes nothing.
    expect((await post('/sponsor/profile', { name: 'Changed', url: '', logo_alt: '' })).status()).toBe(404);
    const { data: row } = await service().from('sponsors').select('name').eq('id', profile.sponsor.id).single();
    expect(row!.name).toBe('Soon Co');

    // A correctly signed Stripe webhook is refused too.
    const payload = JSON.stringify({
      id: `evt_${uniq()}`,
      type: 'customer.subscription.updated',
      data: { object: {} },
    });
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.E2E_STRIPE_WEBHOOK_SECRET!,
    });
    const webhook = await page.request.post('/api/stripe/webhook', {
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
      data: payload,
    });
    expect(webhook.status()).toBe(404);
  });

  test('the about, privacy and accessibility pages say nothing about payments', async ({ page }) => {
    await page.goto('/about');
    await expect(page.getByText('Sponsorship opens soon.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sponsorship', exact: true })).toHaveAttribute('href', '/sponsor');
    for (const path of ['/privacy', '/accessibility']) {
      await page.goto(path);
      await expect(page.locator('main')).not.toContainText('Stripe');
    }
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: 'If you sponsor calenda11y' })).toHaveCount(0);
  });
});
