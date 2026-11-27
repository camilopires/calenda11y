import { expect, expectNoAxeViolations, test } from '../a11y/fixtures.ts';
import {
  frontOfQueue,
  insertPendingEvent,
  clearOutbox,
  ensureAdmin,
  ensureUser,
  fillEventForm,
  ownIp,
  sentEmails,
  service,
  signIn,
  uniq,
} from './support.ts';
import type { Page } from '@playwright/test';

async function submitEvent(page: Page, title: string): Promise<string> {
  await page.goto('/submit');
  await fillEventForm(page, { title, email: 'submitter@example.test' });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Send for review' }).click();
  await expect(page).toHaveURL(/\/submit\/done$/);
  const { data } = await service().from('events').select('id').eq('title', title).single();
  await frontOfQueue(data!.id);
  return data!.id as string;
}

test.describe('admin', () => {
  test.beforeEach(async ({ page }) => {
    await ownIp(page);
    clearOutbox();
  });

  test('sends signed-out visitors to the sign-in page', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin$/);
    await expectNoAxeViolations(page, 'admin login');
    const res = await page.request.get('/admin');
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });

  test('asking for a sign-in link gives the same answer for any address', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Email address').fill('nobody-at-all@example.test');
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByText(/If nobody-at-all@example.test belongs to an admin/)).toBeVisible();
  });

  test('signed-in people who are not admins are turned away', async ({ page }) => {
    const email = `notadmin-${uniq()}@example.test`;
    await ensureUser(email);
    await signIn(page, email);
    const res = await page.request.get('/admin');
    expect(res.status()).toBe(403);
  });

  test('a bad sign-in link never redirects off the site', async ({ page }) => {
    const res = await page.request.get('/admin/auth/callback?token_hash=nope&type=magiclink&next=//evil.example', {
      maxRedirects: 0,
    });
    expect(res.headers().location).toBe('/admin/login?error=link&next=%2Fadmin');
  });

  test('approving an event publishes it and emails the person who added it', async ({ page }) => {
    const title = `Approve me ${uniq()}`;
    const id = await submitEvent(page, title);
    await signIn(page, await ensureAdmin());
    await expect(page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();
    await expectNoAxeViolations(page, 'admin queue');
    await page.getByRole('link', { name: title }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/events/${id}$`));
    await expectNoAxeViolations(page, 'admin event');
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Event published.')).toBeVisible();

    const { data } = await service().from('events').select('slug, status').eq('id', id).single();
    expect(data!.status).toBe('approved');
    await page.goto(`/events/${data!.slug}`);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(
      sentEmails().some((m) => m.to === 'submitter@example.test' && m.subject === `Your event is published: ${title}`),
    ).toBe(true);
  });

  test('rejecting needs a reason and a confirmation, and emails the reason', async ({ page }) => {
    const title = `Reject me ${uniq()}`;
    const id = await submitEvent(page, title);
    await signIn(page, await ensureAdmin(), `/admin/events/${id}`);
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByRole('heading', { name: 'Reject this event?' })).toBeFocused();
    await page.getByRole('button', { name: 'Reject event' }).click();
    await expect(page.locator('.error-summary')).toContainText('Enter why the event is not being published');
    await expectNoAxeViolations(page, 'reject with error');
    await page.getByLabel('Reason').fill('It is not about accessibility.');
    await page.getByRole('button', { name: 'Reject event' }).click();
    await expect(page.getByText('Event rejected.')).toBeVisible();
    const mail = sentEmails().find((m) => m.subject === `Your event was not published: ${title}`);
    expect(mail?.text).toContain('It is not about accessibility.');
  });

  test('two admins editing at once cannot overwrite each other', async ({ page, browser, baseURL }) => {
    const id = await submitEvent(page, `Conflict ${uniq()}`);
    const admin = await ensureAdmin();
    await signIn(page, admin, `/admin/events/${id}`);
    const other = await (await browser.newContext({ baseURL: baseURL! })).newPage();
    await signIn(other, admin, `/admin/events/${id}`);

    await page.getByLabel('Event name').fill('First admin title');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await other.getByLabel('Event name').fill('Second admin title');
    await other.getByRole('button', { name: 'Save changes' }).click();
    await expect(other.locator('.error-summary')).toContainText('Someone else changed this event');
    // Their typing is kept so they can decide what to do.
    await expect(other.getByLabel('Event name')).toHaveValue('Second admin title');
    const { data } = await service().from('events').select('title').eq('id', id).single();
    expect(data!.title).toBe('First admin title');
  });

  test('if the session expires while saving, the changes come back after signing in (2.2.5)', async ({ page }) => {
    const id = await submitEvent(page, `Draft ${uniq()}`);
    const admin = await ensureAdmin();
    await signIn(page, admin, `/admin/events/${id}`);
    await page.getByLabel('Event name').fill('Kept through sign-in');
    // The session ends (for example it timed out somewhere else).
    const cookies = await page.context().cookies();
    await page.context().clearCookies();
    await page.context().addCookies(cookies.filter((c) => !c.name.startsWith('sb-')));
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page).toHaveURL(/\/admin\/login\?next=.*&expired=1$/);
    await expect(page.getByText("Sign in again and we'll bring back what you were working on.")).toBeVisible();

    await signIn(page, admin, `/admin/events/${id}`);
    await expect(page.getByText('You were signed out while saving, so we kept your changes.')).toBeVisible();
    await expect(page.getByLabel('Event name')).toHaveValue('Kept through sign-in');
  });

  test('bulk publishing shows a check page first', async ({ page }) => {
    const a = `Bulk A ${uniq()}`;
    const b = `Bulk B ${uniq()}`;
    await submitEvent(page, a);
    await submitEvent(page, b);
    await signIn(page, await ensureAdmin());
    await page.getByRole('checkbox', { name: a }).check();
    await page.getByRole('checkbox', { name: b }).check();
    await page.getByRole('button', { name: 'Publish selected events' }).click();
    await expect(page.getByRole('heading', { name: 'Publish 2 events?' })).toBeFocused();
    await expectNoAxeViolations(page, 'bulk check');
    await page.getByRole('button', { name: 'Publish these events' }).click();
    await expect(page.getByText('Events published. 2 published.')).toBeVisible();
  });

  test('unpublishing puts an event back in the review list', async ({ page }) => {
    const title = `Unpublish ${uniq()}`;
    const id = await submitEvent(page, title);
    await signIn(page, await ensureAdmin(), `/admin/events/${id}`);
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.goto(`/admin/events/${id}`);
    await page.getByRole('button', { name: 'Take off the site' }).click();
    await expect(page.getByText('Event taken off the site.')).toBeVisible();
    const { data } = await service().from('events').select('status').eq('id', id).single();
    expect(data!.status).toBe('pending');
  });

  test('admin pages pass axe', async ({ page }) => {
    await signIn(page, await ensureAdmin());
    for (const path of [
      '/admin?view=approved',
      '/admin/reports',
      '/admin/reports?show=resolved',
      '/admin/email-outbox',
    ]) {
      await page.goto(path);
      await expectNoAxeViolations(page, path);
    }
  });

  test('a rejection reason typed before the session expired comes back too', async ({ page }) => {
    const id = await submitEvent(page, `Draft reject ${uniq()}`);
    const admin = await ensureAdmin();
    await signIn(page, admin, `/admin/events/${id}`);
    await page.getByRole('button', { name: 'Reject' }).click();
    await page.getByLabel('Reason').fill('Kept reason');
    const cookies = await page.context().cookies();
    await page.context().clearCookies();
    await page.context().addCookies(cookies.filter((c) => !c.name.startsWith('sb-')));
    await page.getByRole('button', { name: 'Reject event' }).click();
    await expect(page).toHaveURL(/\/admin\/login\?next=.*&expired=1$/);
    await signIn(page, admin, `/admin/events/${id}`);
    await expect(page.getByText('so we kept your reason')).toBeVisible();
    await expect(page.getByLabel('Reason')).toHaveValue('Kept reason');
    // Nothing happened yet: it's still waiting for review.
    const { data } = await service().from('events').select('status').eq('id', id).single();
    expect(data!.status).toBe('pending');
  });

  test('oversized drafts are not kept', async ({ page }) => {
    const res = await page.request.post('/admin/events/00000000-0000-4000-8000-000000000000', {
      headers: { origin: 'http://127.0.0.1:4322' },
      form: { step: 'save', title: 'x'.repeat(200_000) },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(303);
    expect((await page.context().cookies()).some((c) => c.name === 'admin_draft')).toBe(false);
  });
  test('rejecting without a reason moves focus to the error summary, not the heading', async ({ page }) => {
    const id = await submitEvent(page, `No reason ${uniq()}`);
    await signIn(page, await ensureAdmin(), `/admin/events/${id}`);
    await page.getByRole('button', { name: 'Reject' }).click();
    await page.getByRole('button', { name: 'Reject event' }).click();
    await expect(page.locator('.error-summary')).toBeFocused();
    await expect(page).toHaveTitle(/^Error: /);
    // The event's time explains its time zone abbreviation here too.
    await page.goto(`/admin/events/${id}`);
    await expect(page.locator('.lede abbr').first()).toHaveAttribute('title', /Mean Time|Universal Time/);
  });
  test('an event with no type cannot be published until one is added', async ({ page }) => {
    const title = `Untyped ${uniq()}`;
    const id = await insertPendingEvent(title);
    await signIn(page, await ensureAdmin());
    await expect(page.locator('tr', { hasText: title })).toContainText('Needs a type');
    await page.goto(`/admin/events/${id}`);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.locator('.error-summary')).toBeFocused();
    await expect(page.locator('.error-summary')).toContainText('Add at least one type before publishing');
    let { data } = await service().from('events').select('status, flags').eq('id', id).single();
    expect(data!.status).toBe('pending');

    await page.getByRole('checkbox', { name: 'Workshop', exact: true }).check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Event published.')).toBeVisible();
    ({ data } = await service().from('events').select('status, flags, types').eq('id', id).single());
    expect(data).toEqual({ status: 'approved', flags: [], types: ['workshop'] });
  });

  test('chosen types survive a session expiring and a version conflict', async ({ page, browser, baseURL }) => {
    const id = await submitEvent(page, `Types kept ${uniq()}`);
    const admin = await ensureAdmin();
    await signIn(page, admin, `/admin/events/${id}`);
    await page.getByRole('checkbox', { name: 'Conference', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Training course', exact: true }).check();
    const cookies = await page.context().cookies();
    await page.context().clearCookies();
    await page.context().addCookies(cookies.filter((c) => !c.name.startsWith('sb-')));
    await page.getByRole('button', { name: 'Save changes' }).click();
    await signIn(page, admin, `/admin/events/${id}`);
    await expect(page.getByRole('checkbox', { name: 'Conference', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Training course', exact: true })).toBeChecked();

    // Someone else saves first; our ticked types are kept on the form.
    const other = await (await browser.newContext({ baseURL: baseURL! })).newPage();
    await signIn(other, admin, `/admin/events/${id}`);
    await other.getByLabel('Event name').fill('Saved by the other admin');
    await other.getByRole('button', { name: 'Save changes' }).click();
    await expect(other.getByText('Saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.error-summary')).toContainText('Someone else changed this event');
    await expect(page.getByRole('checkbox', { name: 'Conference', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Training course', exact: true })).toBeChecked();
  });

  test('bulk publishing skips events that have no type yet', async ({ page }) => {
    const typed = `Bulk typed ${uniq()}`;
    const untyped = `Bulk untyped ${uniq()}`;
    await submitEvent(page, typed);
    const untypedId = await insertPendingEvent(untyped);
    await signIn(page, await ensureAdmin());
    await page.getByRole('checkbox', { name: typed }).check();
    await page.getByRole('checkbox', { name: untyped }).check();
    await page.getByRole('button', { name: 'Publish selected events' }).click();
    await expect(page.getByRole('heading', { name: 'Publish 1 event?' })).toBeVisible();
    await expect(page.getByRole('heading', { name: "Can't publish yet: no type" })).toBeVisible();
    await expect(page.locator('.notice--important')).toContainText(untyped);
    await expectNoAxeViolations(page, 'bulk check with untyped');
    await page.getByRole('button', { name: 'Publish these events' }).click();
    // The check page already listed the untyped one, so only the typed one was sent.
    await expect(page.getByText('Events published. 1 published.')).toBeVisible();
    const { data } = await service().from('events').select('status').eq('id', untypedId).single();
    expect(data!.status).toBe('pending');
  });
  test('a publish request sent without the check page still skips events with no type', async ({ page }) => {
    const id = await insertPendingEvent(`Direct ${uniq()}`);
    await signIn(page, await ensureAdmin());
    const { data: ev } = await service().from('events').select('version').eq('id', id).single();
    const res = await page.request.post('/admin/bulk', {
      headers: { origin: new URL(page.url()).origin },
      form: { step: 'confirm', event: `${id}:${ev!.version}` },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('None of these can be published yet');
    const { data } = await service().from('events').select('status').eq('id', id).single();
    expect(data!.status).toBe('pending');
  });
});
