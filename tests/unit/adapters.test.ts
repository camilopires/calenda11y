import { describe, expect, it } from 'vitest';
import { eventbriteAdapter } from '../../src/lib/imports/eventbrite.ts';
import { lumaAdapter } from '../../src/lib/imports/luma.ts';
import { meetupAdapter } from '../../src/lib/imports/meetup.ts';
import { parseRss } from '../../src/lib/imports/rss.ts';
import { SourceUnavailable, type AdapterContext, type ImportSource } from '../../src/lib/imports/types.ts';

const NOW = new Date('2027-01-15T00:00:00Z');
const src = (type: ImportSource['type'], config: ImportSource['config'] = {}): ImportSource => ({
  id: 's',
  type,
  name: 'Src',
  enabled: true,
  config,
});

function ctx(responses: Array<{ status?: number; body: unknown }>, env: AdapterContext['env'] = {}) {
  const calls: Array<{
    url: string;
    init: { headers?: Record<string, string>; method?: string; body?: string } | undefined;
  }> = [];
  const c: AdapterContext = {
    now: NOW,
    env,
    fetchText: async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (!r) throw new Error(`unexpected request to ${url}`);
      return {
        status: r.status ?? 200,
        body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
        contentType: 'application/json',
      };
    },
  };
  return { c, calls };
}

describe('RSS', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:ev="http://purl.org/rss/1.0/modules/event/"><channel><title>T</title>
    <item><title>With dates &amp; more</title><link>https://example.org/a</link><guid>a-1</guid><description>&lt;p&gt;Hi&lt;/p&gt;</description>
      <ev:startdate>2027-02-01T18:00:00+01:00</ev:startdate><ev:enddate>2027-02-01T20:00:00+01:00</ev:enddate><ev:location>Lisbon</ev:location></item>
    <item><title>No date</title><guid>b-1</guid></item></channel></rss>`;

  it('reads RSS Events dates and reports items without dates', () => {
    const page = parseRss(xml, src('rss', { default_timezone: 'Europe/Lisbon' }), NOW);
    expect(page.items).toEqual([
      expect.objectContaining({
        source_uid: 'a-1',
        title: 'With dates & more',
        starts_at: '2027-02-01T17:00:00.000Z',
        location: 'Lisbon',
      }),
    ]);
    expect(page.skipped).toEqual([{ uid: 'b-1', reason: 'It has no event date (ev:startdate)' }]);
  });

  it('refuses something that is not RSS', () => {
    expect(() => parseRss('<html></html>', src('rss'), NOW)).toThrow(/RSS/);
  });
});

describe('Eventbrite', () => {
  const event = {
    id: 'eb-1',
    name: { text: 'Inclusive design day' },
    description: { text: 'All about it.' },
    url: 'https://www.eventbrite.com/e/eb-1',
    start: { timezone: 'Europe/London', utc: '2027-03-01T09:00:00Z' },
    end: { utc: '2027-03-01T17:00:00Z' },
    online_event: false,
    is_free: false,
    status: 'canceled',
    venue: { name: 'Hall', address: { city: 'Leeds', country: 'GB', localized_address_display: '1 Street, Leeds' } },
  };

  it("pages through an organisation's events with the continuation token", async () => {
    const { c, calls } = ctx([
      { body: { events: [event], pagination: { has_more_items: true, continuation: 'abc' } } },
      { body: { events: [], pagination: { has_more_items: false } } },
    ]);
    const source = src('eventbrite', { organisation_id: '123', token: 'tok' });
    const first = await eventbriteAdapter.fetchPage(source, undefined, c);
    expect(first.next).toBe('abc');
    expect(first.items[0]).toMatchObject({
      source_uid: 'eb-1',
      city: 'Leeds',
      country_code: 'GB',
      free: false,
      cancelled: true,
      online: false,
    });
    const second = await eventbriteAdapter.fetchPage(source, first.next, c);
    expect(second.next).toBeUndefined();
    expect(calls[0]!.url).toContain('/v3/organizations/123/events/');
    expect(calls[0]!.url).toContain('status=live%2Cstarted%2Ccanceled');
    expect(calls[1]!.url).toContain('continuation=abc');
    expect(calls[0]!.init?.headers?.Authorization).toBe('Bearer tok');
  });

  it('says what is missing, and when the token is refused', async () => {
    await expect(eventbriteAdapter.fetchPage(src('eventbrite'), undefined, ctx([]).c)).rejects.toBeInstanceOf(
      SourceUnavailable,
    );
    const refused = eventbriteAdapter.fetchPage(
      src('eventbrite', { organisation_id: '1', token: 't' }),
      undefined,
      ctx([{ status: 403, body: {} }]).c,
    );
    await expect(refused).rejects.toMatchObject({ credentials: 'expired' });
  });
});

describe('Luma', () => {
  it('uses the API with a key, reading old and new entry shapes', async () => {
    const { c, calls } = ctx(
      [
        {
          body: {
            entries: [
              {
                event: {
                  api_id: 'evt-old',
                  name: 'Old shape',
                  start_at: '2027-02-01T10:00:00Z',
                  end_at: '2027-02-01T11:00:00Z',
                  timezone: 'UTC',
                  meeting_url: 'https://zoom.us/x',
                },
              },
              {
                api_id: 'evt-new',
                name: 'New shape',
                start_at: '2027-02-02T10:00:00Z',
                end_at: '2027-02-02T11:00:00Z',
                geo_address_json: { city: 'Paris', country_code: 'FR' },
              },
            ],
            has_more: true,
            next_cursor: 'cur',
          },
        },
      ],
      { LUMA_API_KEY: 'key' },
    );
    const page = await lumaAdapter.fetchPage(src('luma'), undefined, c);
    expect(page.items.map((i) => i.source_uid)).toEqual(['evt-old', 'evt-new']);
    expect(page.items[0]).toMatchObject({ online: true });
    expect(page.items[1]).toMatchObject({ city: 'Paris', country_code: 'FR', online: false });
    expect(page.next).toBe('cur');
    expect(calls[0]!.init?.headers?.['x-luma-api-key']).toBe('key');
  });

  it('falls back to the iCalendar feed without a key, and says what is needed with neither', async () => {
    const ics =
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:l1\r\nDTSTAMP:20270101T000000Z\r\nDTSTART:20270301T100000Z\r\nDTEND:20270301T110000Z\r\nSUMMARY:Luma ICS\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const page = await lumaAdapter.fetchPage(
      src('luma', { url: 'https://api.lu.ma/ics/get?entity=calendar&id=x' }),
      undefined,
      ctx([{ body: ics }]).c,
    );
    expect(page.items[0]!.title).toBe('Luma ICS');
    await expect(lumaAdapter.fetchPage(src('luma'), undefined, ctx([]).c)).rejects.toMatchObject({
      credentials: 'missing',
    });
  });
});

describe('Meetup', () => {
  const result = {
    data: {
      eventSearch: {
        pageInfo: { hasNextPage: false },
        edges: [
          {
            node: {
              id: 'm1',
              title: 'Meetup a11y',
              dateTime: '2027-02-10T19:00:00+01:00',
              endTime: '2027-02-10T21:00:00+01:00',
              eventType: 'ONLINE',
              group: { name: 'A11y Group' },
            },
          },
        ],
      },
    },
  };

  it('is unavailable without credentials', async () => {
    await expect(meetupAdapter.fetchPage(src('meetup'), undefined, ctx([]).c)).rejects.toMatchObject({
      credentials: 'missing',
    });
  });

  it('refreshes an expired token and returns the new one to save', async () => {
    const { c, calls } = ctx(
      [{ body: { access_token: 'new', refresh_token: 'r2', expires_in: 3600 } }, { body: result }],
      { MEETUP_CLIENT_ID: 'id', MEETUP_CLIENT_SECRET: 'secret' },
    );
    const page = await meetupAdapter.fetchPage(
      src('meetup', { refresh_token: 'r1', access_token: 'old', access_token_expires_at: '2027-01-01T00:00:00Z' }),
      undefined,
      c,
    );
    expect(calls[0]!.url).toBe('https://secure.meetup.com/oauth2/access');
    expect(calls[1]!.init?.headers?.Authorization).toBe('Bearer new');
    expect(page.configUpdate).toMatchObject({ access_token: 'new', refresh_token: 'r2' });
    expect(page.items[0]).toMatchObject({
      source_uid: 'm1',
      starts_at: '2027-02-10T18:00:00.000Z',
      online: true,
      organiser: 'A11y Group',
    });
  });

  it('treats GraphQL errors as failures even with HTTP 200', async () => {
    const { c } = ctx([{ body: { errors: [{ message: 'Cannot query field "eventSearch"' }] } }]);
    await expect(meetupAdapter.fetchPage(src('meetup', { access_token: 'tok' }), undefined, c)).rejects.toThrow(
      /GraphQL error: Cannot query field/,
    );
  });
});
