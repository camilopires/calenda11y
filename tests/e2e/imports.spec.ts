import { expect, expectNoAxeViolations, test } from '../a11y/fixtures.ts';
import { ensureAdmin, ownIp, service, signIn, uniq } from './support.ts';

const CRON_SECRET = 'local-development-only-not-for-production';

test.describe('scheduled jobs and imports', () => {
  test.beforeEach(async ({ page }) => ownIp(page));

  test('the tick refuses calls without the cron secret', async ({ request }) => {
    expect((await request.post('/api/cron/tick')).status()).toBe(401);
    expect((await request.get('/api/cron/tick', { headers: { authorization: 'Bearer wrong' } })).status()).toBe(401);
  });

  test('the tick runs due jobs and records them', async ({ request }) => {
    await service()
      .from('jobs')
      .update({ run_after: new Date(0).toISOString(), lease_until: null })
      .in('key', ['outbox', 'cleanup']);
    const res = await request.post('/api/cron/tick', { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { ran: Array<{ key: string; ok: boolean }> };
    expect(body.ran.map((r) => r.key)).toEqual(expect.arrayContaining(['outbox', 'cleanup']));
    const { data } = await service()
      .from('job_runs')
      .select('job_key,ok')
      .in('job_key', ['outbox', 'cleanup'])
      .order('started_at', { ascending: false })
      .limit(2);
    expect(data!.every((r) => r.ok)).toBe(true);
  });

  test('adding a source checks the address, and a failing source shows on every admin page', async ({ page }) => {
    await signIn(page, await ensureAdmin(), '/admin/sources/new');
    await expectNoAxeViolations(page, 'new source');
    const name = `Broken feed ${uniq()}`;
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Feed address').fill('https://10.0.0.5/feed.ics');
    await page.getByRole('button', { name: 'Add source' }).click();
    await expect(page.locator('.error-summary')).toContainText('private network');
    await expectNoAxeViolations(page, 'new source with errors');

    // A name that can never resolve, so the test never touches the internet.
    await page.getByLabel('Feed address').fill('https://feed.calenda11y-test.invalid/cal.ics');
    await page.getByRole('button', { name: 'Add source' }).click();
    await expect(page.getByText('Source saved.')).toBeVisible();

    await page.getByRole('button', { name: new RegExp(`^Run now\\s?: ${name}$`) }).click();
    await expect(page.locator('.notice--error[role="status"]')).toContainText(`"${name}" failed`);
    await expect(page.getByRole('region', { name: 'Things that need attention' })).toContainText(
      'failed the last time',
    );
    await expectNoAxeViolations(page, 'sources with a failure');

    await page.goto('/admin/jobs');
    await expect(
      page.getByRole('cell', { name: `Import: ${name}` }).or(page.getByRole('rowheader', { name: `Import: ${name}` })),
    ).toBeVisible();
    await expectNoAxeViolations(page, 'jobs');
    await service().from('import_sources').update({ enabled: false }).eq('name', name);
  });

  test('an admin can accept changes from a source', async ({ page }) => {
    const db = service();
    const { data: src } = await db
      .from('import_sources')
      .insert({ type: 'ics', name: `Changes ${uniq()}`, enabled: false, config: {} })
      .select('id')
      .single();
    const { data: ev } = await db
      .from('events')
      .insert({
        slug: `changes-${uniq()}`,
        title: 'Old title',
        summary: 'Summary.',
        timezone: 'UTC',
        format: 'online',
        starts_at: '2030-03-01T10:00:00Z',
        ends_at: '2030-03-01T11:00:00Z',
        status: 'approved',
        source: 'ics',
        source_id: src!.id,
        source_uid: 'uid-1',
        flags: ['changed'],
        pending_changes: { title: 'New title from the source' },
      })
      .select('id,slug')
      .single();
    await signIn(page, await ensureAdmin(), `/admin/events/${ev!.id}`);
    await expect(page.getByRole('heading', { name: 'The source changed this event' })).toBeVisible();
    await expectNoAxeViolations(page, 'pending changes');
    await page.getByRole('button', { name: 'Accept the changes' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.goto(`/events/${ev!.slug}`);
    await expect(page.getByRole('heading', { level: 1, name: 'New title from the source' })).toBeVisible();
  });
});
