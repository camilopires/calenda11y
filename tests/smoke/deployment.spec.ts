import { expect, test } from '@playwright/test';

test.describe('deployment smoke checks', () => {
  test('security headers and CSP are in place, and no page logs a CSP violation', async ({ page, request }) => {
    const res = await request.get('/');
    const h = res.headers();
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).toMatch(/script-src [^;]*'sha256-/);
    expect(h['strict-transport-security']).toContain('max-age=');
    expect(h['x-content-type-options']).toBe('nosniff');
    const problems: string[] = [];
    page.on(
      'console',
      (m) => m.type() === 'error' && /Content Security Policy/i.test(m.text()) && problems.push(m.text()),
    );
    for (const path of ['/', '/calendar', '/submit', '/subscribe', '/sponsor']) await page.goto(path);
    expect(problems).toEqual([]);
  });

  test('feeds are cached at the edge; pages (which carry display settings) and admin are not', async ({ request }) => {
    expect((await request.get('/')).headers()['cache-control']).toBe('private, no-cache');
    expect((await request.get('/feeds/all.ics')).headers()['cache-control']).toContain('s-maxage=3600');
    expect((await request.get('/admin/login')).headers()['cache-control']).toBe('private, no-store');
  });

  test('test-only pages do not exist', async ({ request }) => {
    expect((await request.get('/styleguide')).status()).toBe(404);
    expect((await request.get('/sponsor/test-checkout?session=x')).status()).toBe(404);
    expect((await request.get('/api/test/stripe')).status()).toBe(404);
  });

  test('endpoints that authenticate themselves refuse bad credentials', async ({ request }) => {
    expect((await request.post('/api/cron/tick')).status()).toBe(401);
    expect(
      (await request.post('/api/stripe/webhook', { headers: { 'stripe-signature': 't=1,v1=x' }, data: '{}' })).status(),
    ).toBe(400);
    expect((await request.post('/api/resend/webhook', { data: '{}' })).status()).toBe(401);
  });

  test('cross-site form posts are blocked', async ({ request }) => {
    expect(
      (
        await request.post('/settings', { headers: { origin: 'https://evil.example' }, form: { theme: 'dark' } })
      ).status(),
    ).toBe(403);
  });

  test('cookies are secure', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('radio', { name: /^Dark/ }).check();
    await page.getByRole('button', { name: 'Save display settings' }).click();
    const cookie = (await page.context().cookies()).find((c) => c.name === 'display');
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax' });
  });
});
