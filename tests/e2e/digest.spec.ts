import { expect, expectNoAxeViolations, test } from '../a11y/fixtures.ts';
import { clearOutbox, ownIp, sentEmails, service, uniq } from './support.ts';
import type { Page } from '@playwright/test';
import { signSvix } from '../../src/lib/email/webhook.ts';
import { subscriberToken } from '../../src/lib/digest/links.ts';
import { confirmSubscription, digestEmail } from '../../src/lib/email/templates.ts';

async function signUp(page: Page, email: string, cadence: 'Weekly' | 'Monthly' = 'Weekly') {
  await page.goto('/subscribe/email?country=PT');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('radio', { name: new RegExp(`^${cadence}`) }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email choices' })).toBeFocused();
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

const linkIn = (text: string, path: string) => new URL(new RegExp(`https?://\\S+${path}\\S*`).exec(text)![0]);

test.describe('email digest', () => {
  test.beforeEach(async ({ page }) => {
    await ownIp(page);
    clearOutbox();
  });

  test('signing up, confirming, changing and one-click unsubscribing', async ({ page, request }) => {
    const email = `reader-${uniq()}@example.test`;
    await page.goto('/subscribe/email');
    await expectNoAxeViolations(page, 'signup form');
    await signUp(page, email);
    await expectNoAxeViolations(page, 'signup done');

    const confirmMail = sentEmails().find((m) => m.to === email)!;
    expect(confirmMail.subject).toBe('Confirm your calenda11y emails');
    const confirmUrl = linkIn(confirmMail.text, '/subscribe/confirm');

    // Opening the link (as an email scanner would) does not confirm.
    await page.goto(confirmUrl.pathname + confirmUrl.search);
    const { data: before } = await service()
      .from('digest_subscribers')
      .select('confirmed_at')
      .eq('email', email)
      .single();
    expect(before!.confirmed_at).toBeNull();
    await expectNoAxeViolations(page, 'confirm');
    await page.getByRole('button', { name: 'Confirm my emails' }).click();
    await expect(page.getByRole('heading', { name: "You're signed up" })).toBeVisible();
    await expect(page.getByText(/a weekly email of events in Portugal/)).toBeVisible();

    const manageHref = await page.getByRole('link', { name: 'Change what you get' }).getAttribute('href');

    // The link only works once.
    await page.goto(confirmUrl.pathname + confirmUrl.search);
    await page.getByRole('button', { name: 'Confirm my emails' }).click();
    await expect(page.getByRole('heading', { name: "That link doesn't work" })).toBeVisible();

    // Change preferences.
    const manage = new URL(manageHref!);
    await page.goto(manage.pathname + manage.search);
    await expectNoAxeViolations(page, 'manage');
    await page.getByRole('radio', { name: /^Monthly/ }).check();
    await page.getByRole('button', { name: 'Save my choices' }).click();
    await expect(page.getByText(/Saved. You'll now get a monthly email/)).toBeVisible();

    // One-click unsubscribe, the way a mail app does it: no cookies, no Origin.
    const { data: sub } = await service().from('digest_subscribers').select('id').eq('email', email).single();
    const unsubscribeHref = await page.getByRole('link', { name: 'Unsubscribe' }).getAttribute('href');
    const token = new URL(unsubscribeHref!, 'http://x').searchParams.get('token')!;
    const res = await request.post(`/api/unsubscribe?token=${encodeURIComponent(token)}`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: 'List-Unsubscribe=One-Click',
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    const { data: gone } = await service().from('digest_subscribers').select('id').eq('id', sub!.id);
    expect(gone).toEqual([]);
  });

  test('types chosen on the list carry into the email sign-up, and changing something else keeps them', async ({
    page,
  }) => {
    const email = `typed-${uniq()}@example.test`;
    await page.goto('/?type=talk');
    await page.getByRole('link', { name: 'Subscribe to these events' }).click();
    await page.locator('a.button', { hasText: /email/i }).click();
    await expect(page.getByRole('checkbox', { name: 'Talk or webinar', exact: true })).toBeChecked();
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('radio', { name: /^Weekly/ }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.check-answers')).toContainText('a weekly email of talks and webinars');
    await page.getByRole('button', { name: 'Sign up' }).click();

    const confirmUrl = linkIn(sentEmails().find((m) => m.to === email)!.text, '/subscribe/confirm');
    await page.goto(confirmUrl.pathname + confirmUrl.search);
    await page.getByRole('button', { name: 'Confirm my emails' }).click();
    const manage = new URL((await page.getByRole('link', { name: 'Change what you get' }).getAttribute('href'))!);
    await page.goto(manage.pathname + manage.search);
    await expect(page.getByRole('checkbox', { name: 'Talk or webinar', exact: true })).toBeChecked();
    await page.getByRole('radio', { name: /^Monthly/ }).check();
    await page.getByRole('button', { name: 'Save my choices' }).click();
    await expect(page.getByText(/Saved. You'll now get a monthly email of talks and webinars/)).toBeVisible();
    const { data } = await service().from('digest_subscribers').select('cadence,types').eq('email', email).single();
    expect(data).toEqual({ cadence: 'monthly', types: ['talk'] });
  });

  test('an "Open for speakers" search ticks calls for speakers on the email sign-up', async ({ page }) => {
    await page.goto('/?cfp=open');
    await page.getByRole('link', { name: 'Subscribe to these events' }).click();
    await page.locator('a.button', { hasText: /email/i }).click();
    const box = page.getByRole('checkbox', { name: 'Also tell me about calls for speakers' });
    await expect(box).toBeChecked();
    await page.getByLabel('Email address').fill(`speaker-${uniq()}@example.test`);
    await page.getByRole('radio', { name: /^Monthly/ }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.check-answers')).toContainText('a monthly email of events, plus calls for speakers');
    await expectNoAxeViolations(page, 'sign-up check with calls');
  });

  test('topics chosen on the list carry into the email sign-up', async ({ page }) => {
    await page.goto('/?topic=content');
    await page.getByRole('link', { name: 'Subscribe to these events' }).click();
    await page.locator('a.button', { hasText: /email/i }).click();
    await expect(page.getByRole('checkbox', { name: 'Content and plain language', exact: true })).toBeChecked();
    await page.getByLabel('Email address').fill(`topical-${uniq()}@example.test`);
    await page.getByRole('radio', { name: /^Weekly/ }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.check-answers')).toContainText(
      'a weekly email of events about content and plain language',
    );
  });

  test('GET on the unsubscribe link only shows a confirmation page', async ({ page }) => {
    const email = `getter-${uniq()}@example.test`;
    const { data } = await service()
      .from('digest_subscribers')
      .insert({ email, cadence: 'weekly', confirmed_at: new Date().toISOString() })
      .select('id,token_version')
      .single();
    const token = subscriberToken('unsubscribe', data!.id, data!.token_version);
    await page.goto(`/api/unsubscribe?token=${encodeURIComponent(token)}`);
    await expect(page).toHaveURL(/\/subscribe\/unsubscribe\?token=/);
    await expect(page.getByRole('heading', { name: 'Unsubscribe?' })).toBeVisible();
    await expectNoAxeViolations(page, 'unsubscribe confirm');
    const { data: still } = await service().from('digest_subscribers').select('id').eq('id', data!.id);
    expect(still).toHaveLength(1);
    // Pressing the button does unsubscribe, and the page says so.
    await page.getByRole('button', { name: 'Unsubscribe' }).click();
    await expect(page.getByRole('heading', { name: "You're unsubscribed" })).toBeVisible();
    const { data: gone } = await service().from('digest_subscribers').select('id').eq('id', data!.id);
    expect(gone).toEqual([]);
  });

  test('signing up again with a subscribed address changes nothing and sends a manage link', async ({ page }) => {
    const email = `existing-${uniq()}@example.test`;
    await service()
      .from('digest_subscribers')
      .insert({ email, cadence: 'monthly', countries: ['JP'], confirmed_at: new Date().toISOString() });
    await signUp(page, email, 'Weekly');
    const { data } = await service().from('digest_subscribers').select('cadence,countries').eq('email', email).single();
    expect(data).toEqual({ cadence: 'monthly', countries: ['JP'] });
    expect(sentEmails().find((m) => m.to === email)?.subject).toBe('Your calenda11y emails');
  });

  test('the Resend webhook refuses unsigned requests and suppresses bounced addresses', async ({ request }) => {
    const unsigned = await request.post('/api/resend/webhook', {
      data: { type: 'email.bounced', data: { to: ['a@example.test'] } },
    });
    expect(unsigned.status()).toBe(401);

    const email = `bounce-${uniq()}@example.test`;
    await service()
      .from('digest_subscribers')
      .insert({ email, cadence: 'weekly', confirmed_at: new Date().toISOString() });
    const body = JSON.stringify({ type: 'email.bounced', data: { to: [email] } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSvix(process.env.E2E_RESEND_WEBHOOK_SECRET!, 'msg_e2e', ts, body);
    const res = await request.post('/api/resend/webhook', {
      headers: {
        'svix-id': 'msg_e2e',
        'svix-timestamp': ts,
        'svix-signature': `v1,${sig}`,
        'content-type': 'application/json',
      },
      data: body,
    });
    expect(res.status()).toBe(200);
    const { data } = await service().from('digest_subscribers').select('suppressed_reason').eq('email', email).single();
    expect(data!.suppressed_reason).toBe('bounced');
  });

  test('the email HTML passes axe', async ({ page }) => {
    const digest = digestEmail(
      'Accessibility events: 3 to 9 March 2031',
      [
        {
          title: 'Lisbon meetup',
          url: 'https://calenda11y.org/events/x',
          when: 'Wednesday 5 March 2031, 18:00 to 20:00',
          where: 'Lisbon, Portugal',
          summary: 'Short talks.',
        },
      ],
      'https://calenda11y.org/subscribe/manage?token=t',
      'https://calenda11y.org/api/unsubscribe?token=t',
    );
    for (const html of [
      digest.html,
      confirmSubscription('https://calenda11y.org/subscribe/confirm?token=t', 'a weekly email of events').html,
    ]) {
      await page.setContent(html);
      await expectNoAxeViolations(page, 'email');
    }
  });
});
