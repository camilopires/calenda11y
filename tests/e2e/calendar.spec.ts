import ICAL from 'ical.js';
import { XMLParser } from 'fast-xml-parser';
import { expect, expectNoAxeViolations, expectValidHtml, test } from '../a11y/fixtures.ts';
import { service, uniq } from './support.ts';

function parseIcs(text: string) {
  const comp = new ICAL.Component(ICAL.parse(text));
  return comp.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v));
}

test.describe('calendar integrations', () => {
  test('the all-events feed is valid and only has published events', async ({ request }) => {
    const res = await request.get('/feeds/all.ics');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers()['cache-control']).toContain('s-maxage=3600');
    const text = await res.text();
    const events = parseIcs(text);
    expect(events.length).toBeGreaterThan(30);
    const titles = events.map((e) => e.summary);
    expect(titles.some((t) => /not public/.test(t))).toBe(false);
    // Cancelled events stay in the feed (as cancelled) so subscribed calendars update.
    expect(text).toMatch(/SUMMARY;LANGUAGE=fr:Cancelled: Paris accessibility meetup/);
    expect(text).toContain('STATUS:CANCELLED');
  });

  test('country and filtered feeds only contain matching events', async ({ request }) => {
    const pt = parseIcs(await (await request.get('/feeds/PT.ics')).text());
    expect(pt.map((e) => e.summary)).toContain('Lisbon Inclusive Design Meetup');
    expect(pt.every((e) => /Portugal/.test(e.location))).toBe(true);

    const online = parseIcs(await (await request.get('/feeds/online.ics')).text());
    expect(online.length).toBeGreaterThan(0);
    expect(online.every((e) => /Online|and online/.test(e.location))).toBe(true);

    const filtered = parseIcs(await (await request.get('/feeds/events.ics?access=sign_language&format=online')).text());
    expect(filtered.map((e) => e.summary)).toEqual(expect.arrayContaining(['Screen reader testing basics']));
  });

  test('bad feed addresses get a clear 400', async ({ request }) => {
    const res = await request.get('/feeds/ZZ.ics');
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('Choose a country from the list');
    expect((await request.get('/feeds/events.ics?format=space')).status()).toBe(400);
  });

  test('a single event downloads as an .ics file', async ({ request }) => {
    const res = await request.get('/events/lisbon-inclusive-design-meetup.ics');
    expect(res.headers()['content-disposition']).toBe('attachment; filename="lisbon-inclusive-design-meetup.ics"');
    const [event] = parseIcs(await res.text());
    expect(event!.summary).toBe('Lisbon Inclusive Design Meetup');
    expect((await request.get('/events/pending-event-not-public.ics')).status()).toBe(404);
  });

  test('the RSS feed is well-formed', async ({ request }) => {
    const res = await request.get('/feeds/events.rss?country=PT');
    expect(res.headers()['content-type']).toBe('application/rss+xml; charset=utf-8');
    const xml = new XMLParser().parse(await res.text());
    const items = [xml.rss.channel.item].flat();
    expect(items.map((i: { title: string }) => i.title)).toContain('Lisbon Inclusive Design Meetup');
  });

  test('the event page offers every way to add it to a calendar', async ({ page }) => {
    await page.goto('/events/lisbon-inclusive-design-meetup');
    const section = page.getByRole('region', { name: 'Add to your calendar' });
    await expect(
      section.getByRole('link', { name: /^Download a calendar file\s?: Lisbon Inclusive Design Meetup$/ }),
    ).toHaveAttribute('href', '/events/lisbon-inclusive-design-meetup.ics');
    const google = await section.getByRole('link', { name: /Add to Google Calendar/ }).getAttribute('href');
    expect(google).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
    await expect(section.getByRole('link', { name: /Add to Outlook\.com/ })).toBeVisible();
    await expect(section.getByRole('link', { name: /Add to Microsoft 365/ })).toBeVisible();
    await expect(section.getByRole('link', { name: 'Subscribe to all events in Portugal' })).toBeVisible();
  });

  test('cancelled and past events do not offer to add them', async ({ page }) => {
    await page.goto('/events/cancelled-meetup-paris');
    await expect(page.getByRole('heading', { name: 'Add to your calendar' })).toHaveCount(0);
  });

  test('the subscribe page describes the filters and gives working feed links', async ({ page, request }) => {
    await page.goto('/subscribe?country=PT&access=captions');
    await expect(page.locator('strong', { hasText: 'events in Portugal with live captions' })).toBeVisible();
    const webcal = await page.getByRole('link', { name: 'Subscribe in my calendar app' }).getAttribute('href');
    expect(webcal).toMatch(/^webcal:\/\/.*\/feeds\/events\.ics\?country=PT&access=captions$/);
    const feedUrl = await page.getByLabel('Calendar feed address').inputValue();
    const res = await request.get(new URL(feedUrl).pathname + new URL(feedUrl).search);
    expect(res.status()).toBe(200);
  });

  test('"Subscribe to these events" on the list keeps the filters', async ({ page }) => {
    await page.goto('/?country=online&format=hybrid');
    await page.getByRole('link', { name: 'Subscribe to these events' }).click();
    await expect(page).toHaveURL(/\/subscribe\?country=online&format=hybrid$/);
  });

  for (const path of ['/subscribe', '/subscribe?country=PT', '/subscribe?format=space']) {
    test(`${path} passes axe and is valid HTML`, async ({ page }) => {
      await page.goto(path);
      await expectNoAxeViolations(page, path);
      await expectValidHtml(page, path);
    });
  }
  test('"more events" on a past day of the grid lists that day\'s past events', async ({ page }) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const month = d.toISOString().slice(0, 7);
    const day = `${month}-15`;
    const tag = uniq();
    const rows = Array.from({ length: 4 }, (_, i) => ({
      slug: `past-${tag}-${i}`,
      title: `Past grid ${tag} ${i}`,
      summary: 'Summary.',
      timezone: 'UTC',
      format: 'online',
      starts_at: `${day}T1${i}:00:00Z`,
      ends_at: `${day}T1${i}:30:00Z`,
      status: 'approved',
      source: 'form',
    }));
    await service().from('events').insert(rows);
    try {
      await page.goto(`/calendar?month=${month}&q=${tag}`);
      const more = page.getByRole('link', { name: /^1 more event on / });
      await expect(more).toHaveAttribute('href', /when=any/);
      await more.click();
      for (const r of rows) await expect(page.getByRole('link', { name: r.title })).toBeVisible();
    } finally {
      await service().from('events').delete().like('slug', `past-${tag}-%`);
    }
  });

  test('pages are not cached by shared caches; feeds are', async ({ request }) => {
    for (const path of ['/', '/calendar', '/sponsor']) {
      const res = await request.get(path);
      expect(res.headers()['cache-control'], path).toBe('private, no-cache');
    }
    expect((await request.get('/feeds/all.ics')).headers()['cache-control']).toMatch(/public/);
  });
});
