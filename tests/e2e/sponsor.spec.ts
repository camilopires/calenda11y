import Stripe from 'stripe';
import sharp from 'sharp';
import { expect, expectNoAxeViolations, expectValidHtml, test } from '../a11y/fixtures.ts';
import { clearOutbox, ensureAdmin, ownIp, sentEmails, service, signIn, uniq } from './support.ts';
import type { APIRequestContext, Page } from '@playwright/test';

async function checkout(
  page: Page,
  tierButton: RegExp,
  opts: { yearly?: boolean; email?: string; outcome?: 'paid' | 'delayed' } = {},
) {
  await page.goto('/sponsor');
  const form = page.locator('form', { has: page.getByRole('button', { name: tierButton }) });
  if (opts.yearly) await form.getByRole('radio', { name: /^Yearly/ }).check();
  await form.getByRole('button', { name: tierButton }).click();
  await expect(page).toHaveURL(/\/sponsor\/test-checkout\?session=cs_test_fake/);
  await page.getByLabel('Email').fill(opts.email ?? `sponsor-${uniq()}@example.test`);
  if (opts.outcome) await page.getByLabel('Outcome').selectOption(opts.outcome);
  await page.getByRole('button', { name: 'Pay' }).click();
}

async function postWebhook(request: APIRequestContext, event: object, secret = process.env.E2E_STRIPE_WEBHOOK_SECRET!) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return request.post('/api/stripe/webhook', {
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
    data: payload,
  });
}

test.describe('sponsorship', () => {
  test.beforeEach(async ({ page }) => {
    await ownIp(page);
    clearOutbox();
  });

  test('the sponsor page passes axe and is valid HTML', async ({ page }) => {
    await page.goto('/sponsor');
    await expectNoAxeViolations(page, '/sponsor');
    await expectValidHtml(page, '/sponsor');
  });

  test('sponsoring, adding a profile with a logo, and appearing once approved', async ({ page }) => {
    const name = `Acme ${uniq()}`;
    await checkout(page, /^Sponsor as Bronze$/, { yearly: true });
    // The browser that paid goes straight to its profile.
    await expect(page).toHaveURL(/\/sponsor\/profile\?welcome=1$/);
    await expect(page.getByText('Thank you for sponsoring calenda11y!')).toBeVisible();
    await expectNoAxeViolations(page, 'profile');

    // A logo without a description is refused.
    const logo = await sharp({ create: { width: 400, height: 120, channels: 4, background: '#123f9c' } })
      .png()
      .toBuffer();
    await page.getByLabel('Name to show').fill(name);
    await page.getByLabel(/^Logo/).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo });
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.locator('.error-summary')).toContainText('Describe the logo');
    await expectNoAxeViolations(page, 'profile with errors');

    await page.getByLabel(/^Logo/).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo });
    await page.getByLabel('Describe the logo').fill(name);
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText(/Saved. A person will check your profile/)).toBeVisible();

    // Not public until approved.
    await page.goto('/sponsor');
    await expect(page.getByRole('img', { name })).toHaveCount(0);

    await signIn(page, await ensureAdmin(), '/admin/sponsors');
    await expectNoAxeViolations(page, 'admin sponsors');
    await page.getByRole('button', { name: new RegExp(`^Publish profile\\s?: ${name}$`) }).click();
    await expect(page.getByText(`Published the profile for ${name}.`)).toBeVisible();

    await page.goto('/sponsor');
    await expect(page.getByRole('img', { name })).toBeVisible();
    await expect(page.getByRole('contentinfo').getByText(name)).toBeVisible();
    await expectNoAxeViolations(page, '/sponsor with sponsors');
  });

  test('a fake image is refused', async ({ page }) => {
    await checkout(page, /^Sponsor as Supporter$/);
    await page.getByLabel('Name to show').fill('Sneaky');
    await page
      .getByLabel(/^Logo/)
      .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"/>') });
    await page.getByLabel('Describe the logo').fill('Sneaky');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.locator('.error-summary')).toContainText('must be a PNG, JPEG or WebP image');
  });

  test('another browser on the thanks page does not get the profile link', async ({ page, browser, baseURL }) => {
    await checkout(page, /^Make a one-off donation$/);
    await expect(page).toHaveURL(/\/sponsor\/profile/);
    const { data } = await service()
      .from('sponsorship_attempts')
      .select('checkout_session_id')
      .not('used_at', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    const other = await (await browser.newContext({ baseURL: baseURL! })).newPage();
    await other.goto(`/sponsor/thanks?session_id=${data!.checkout_session_id}`);
    await expect(other).toHaveURL(/\/sponsor\/thanks/);
    await expect(other.getByRole('heading', { name: 'Thank you for sponsoring calenda11y' })).toBeVisible();
    await expect(other.getByText("We've emailed you a link")).toBeVisible();
    // Coming back to the thanks page later doesn't issue a second link either.
    await page.goto(`/sponsor/thanks?session_id=${data!.checkout_session_id}`);
    await expect(page).toHaveURL(/\/sponsor\/thanks/);
  });

  test('a delayed payment is not treated as paid', async ({ page }) => {
    await checkout(page, /^Make a one-off donation$/, { outcome: 'delayed' });
    await expect(page.getByRole('heading', { name: 'Your payment is being processed' })).toBeVisible();
  });

  test('webhooks: signature checked, repeats ignored, cancellations stop the listing', async ({ page, request }) => {
    const name = `Webhook Co ${uniq()}`;
    await checkout(page, /^Sponsor as Silver$/);
    const { data: att } = await service()
      .from('sponsorship_attempts')
      .select('checkout_session_id, sponsor_id')
      .not('used_at', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    const session = await (await request.get(`/api/test/stripe?session=${att!.checkout_session_id}`)).json();
    await service().from('sponsors').update({ approved_name: name }).eq('id', att!.sponsor_id);

    const subscription = {
      id: session.subscription,
      status: 'active',
      customer: session.customer,
      lookup_key: 'c11y_silver_month',
      period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
      amount: 10000,
      currency: 'gbp',
    };
    await request.post('/api/test/stripe', { data: { subscription } });
    const created = {
      id: `evt_e2e${uniq()}`,
      object: 'event',
      type: 'customer.subscription.created',
      data: { object: { id: session.subscription } },
    };
    expect((await (await postWebhook(request, created)).json()).outcome).toBe('applied');
    expect((await (await postWebhook(request, created)).json()).outcome).toBe('duplicate');

    const bad = await request.post('/api/stripe/webhook', {
      headers: { 'stripe-signature': 't=1,v1=bad' },
      data: '{}',
    });
    expect(bad.status()).toBe(400);

    let { data: listed } = await service().from('public_sponsors').select('name').eq('name', name);
    expect(listed).toEqual([{ name }]);

    await request.post('/api/test/stripe', { data: { subscription: { ...subscription, status: 'canceled' } } });
    const deleted = {
      id: `evt_e2e${uniq()}`,
      object: 'event',
      type: 'customer.subscription.deleted',
      data: { object: { id: session.subscription } },
    };
    expect((await (await postWebhook(request, deleted)).json()).outcome).toBe('applied');
    ({ data: listed } = await service().from('public_sponsors').select('name').eq('name', name));
    expect(listed).toEqual([]);
  });

  test('sponsors can get links to manage their sponsorship, without revealing who sponsors', async ({
    page,
    browser,
    baseURL,
  }) => {
    const email = `manager-${uniq()}@example.test`;
    await checkout(page, /^Sponsor as Supporter$/, { email });
    clearOutbox();
    await page.goto('/sponsor/manage');
    await expectNoAxeViolations(page, 'manage');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Email me the links' }).click();
    await expect(page.getByText(`If ${email} belongs to a sponsor`)).toBeVisible();
    const mail = sentEmails().find((m) => m.to === email)!;
    const portal = new URL(/https?:\/\/\S+\/sponsor\/portal\?token=\S+/.exec(mail.text)![0]);
    const profile = new URL(/https?:\/\/\S+\/sponsor\/profile\?token=\S+/.exec(mail.text)![0]);
    const origin = { origin: new URL(page.url()).origin };

    // Email scanners open links on their own: opening one (GET) doesn't use it up.
    expect((await page.request.get(portal.pathname + portal.search)).status()).toBe(200);
    const oldLink = await page.request.get(`/api/sponsor/portal${portal.search}`, { maxRedirects: 0 });
    expect(oldLink.headers().location).toBe(`/sponsor/portal${portal.search}`);
    await page.goto(portal.pathname + portal.search);
    await expectNoAxeViolations(page, 'portal landing');
    await expect(page.getByRole('button', { name: 'Go to my payments' })).toBeVisible();

    // Pressing the button does.
    const res = await page.request.post(`/api/sponsor/portal${portal.search}`, { headers: origin, maxRedirects: 0 });
    expect(res.headers().location).toMatch(/^\/sponsor\/test-portal\?customer=cus_fake/);
    // The link works once.
    const again = await page.request.post(`/api/sponsor/portal${portal.search}`, { headers: origin, maxRedirects: 0 });
    expect(again.headers().location).toBe('/sponsor/manage?expired=1');

    // The profile link also needs its button pressed.
    const fresh = await browser.newContext({ baseURL: baseURL! });
    const other = await fresh.newPage();
    await other.goto(profile.pathname + profile.search);
    await other.reload(); // a second open (like a scanner's) still works
    await expectNoAxeViolations(other, 'profile landing');
    await other.getByRole('button', { name: 'Open my sponsor profile' }).click();
    await expect(other).toHaveURL(/\/sponsor\/profile$/);
    await expect(other.getByLabel('Name to show')).toBeVisible();
    await fresh.close();

    // An unknown address gets the same answer and no email.
    clearOutbox();
    await page.goto('/sponsor/manage');
    await page.getByLabel('Email address').fill(`nobody-${uniq()}@example.test`);
    await page.getByRole('button', { name: 'Email me the links' }).click();
    await expect(page.getByText(/belongs to a sponsor/)).toBeVisible();
    expect(sentEmails()).toEqual([]);
  });

  test("a forged cookie on the thanks page doesn't use up the payer's profile link", async ({
    page,
    browser,
    baseURL,
  }) => {
    await page.goto('/sponsor');
    await page
      .locator('form', { has: page.getByRole('button', { name: /^Make a one-off donation$/ }) })
      .getByRole('button')
      .click();
    await expect(page).toHaveURL(/\/sponsor\/test-checkout/);
    // Pay without following the redirect, so the payer hasn't reached the thanks page yet.
    const paid = await page.request.post(page.url(), {
      headers: { origin: new URL(page.url()).origin },
      form: { email: `forged-${uniq()}@example.test`, outcome: 'paid' },
      maxRedirects: 0,
    });
    const thanks = new URL(paid.headers().location!);
    const { data } = await service()
      .from('sponsorship_attempts')
      .select('id')
      .eq('checkout_session_id', thanks.searchParams.get('session_id')!)
      .single();

    const attacker = await browser.newContext({ baseURL: baseURL! });
    await attacker.addCookies([
      { name: 'sponsor_attempt', value: `${data!.id}.forged-secret-value`, url: `${baseURL}/sponsor` },
    ]);
    const other = await attacker.newPage();
    await other.goto(thanks.pathname + thanks.search);
    await expect(other).toHaveURL(/\/sponsor\/thanks/);
    await expect(other.getByText("We've emailed you a link")).toBeVisible();

    // The real payer still gets straight to their profile.
    await page.goto(thanks.pathname + thanks.search);
    await expect(page).toHaveURL(/\/sponsor\/profile\?welcome=1$/);
    await attacker.close();
  });
  test('someone with several sponsor records gets links for each', async ({ page }) => {
    const email = `twice-${uniq()}@example.test`;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { data } = await service()
        .from('sponsors')
        .insert({ stripe_customer_id: `cus_twice${uniq()}`, contact_email: email })
        .select('id')
        .single();
      ids.push(data!.id);
    }
    await page.goto('/sponsor/manage');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Email me the links' }).click();
    await expect(page.getByText(`If ${email} belongs to a sponsor`)).toBeVisible();
    expect(sentEmails().filter((m) => m.to === email)).toHaveLength(2);
    const { data: tokens } = await service()
      .from('tokens')
      .select('subject_id')
      .eq('purpose', 'sponsor_portal')
      .in('subject_id', ids);
    expect(new Set(tokens!.map((t) => t.subject_id))).toEqual(new Set(ids));
  });

  test('admins can decline a profile with a reason, and changes made while reviewing are not lost', async ({
    page,
  }) => {
    const name = `Review Co ${uniq()}`;
    const { data: sponsor } = await service()
      .from('sponsors')
      .insert({ stripe_customer_id: `cus_review${uniq()}`, name, profile_status: 'pending' })
      .select('id')
      .single();
    await signIn(page, await ensureAdmin(), '/admin/sponsors');

    // No reason: refused.
    await page.getByRole('button', { name: new RegExp(`^Don't publish\\s?: ${name}$`) }).click();
    await expect(page.getByText('Enter why the profile is not being published')).toBeVisible();

    // The sponsor changes their profile while the admin is looking.
    await service()
      .from('sponsors')
      .update({ name: `${name} v2`, updated_at: new Date().toISOString() })
      .eq('id', sponsor!.id);
    await page.getByRole('button', { name: new RegExp(`^Publish profile\\s?: ${name}$`) }).click();
    await expect(page.getByText(`${name} v2 changed their profile while you were looking`)).toBeVisible();
    let { data: row } = await service().from('sponsors').select('profile_status').eq('id', sponsor!.id).single();
    expect(row!.profile_status).toBe('pending');

    // Declining the version shown works, and the sponsor sees the reason.
    await page.getByLabel(`Reason, if not publishing ${name} v2`).fill('The website address does not work');
    await page.getByRole('button', { name: new RegExp(`^Don't publish\\s?: ${name} v2$`) }).click();
    await expect(page.getByText(`Didn't publish the changes for ${name} v2`)).toBeVisible();
    ({ data: row } = await service()
      .from('sponsors')
      .select('profile_status, rejection_reason')
      .eq('id', sponsor!.id)
      .single());
    expect(row).toEqual({ profile_status: 'rejected', rejection_reason: 'The website address does not work' });
  });
});
