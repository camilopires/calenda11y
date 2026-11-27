import { describe, expect, it } from 'vitest';
import { buildChangesRss, type FeedChange } from '../../src/lib/alerts/feed.ts';
import { makeEvent } from '../support/factories.ts';

const SITE = 'https://calenda11y.org';
const event = makeEvent({ id: 'e1', title: 'Lisbon <Meetup> & friends' });
const change = (over: Partial<FeedChange>): FeedChange => ({
  id: 7,
  kind: 'updated',
  what: ['time'],
  before_status: 'approved',
  after: {},
  created_at: '2026-11-20T10:00:00.000Z',
  ...over,
});

describe('buildChangesRss', () => {
  it('describes each entry from its own snapshot, so older entries stay true', () => {
    const xml = buildChangesRss(
      [
        {
          change: change({
            id: 2,
            after: {
              starts_at: '2026-12-03T18:30:00Z',
              ends_at: '2026-12-03T20:30:00Z',
              local_start_date: '2026-12-03',
              local_end_date: '2026-12-03',
            },
          }),
          event,
        },
        {
          change: change({
            id: 1,
            after: {
              starts_at: '2026-12-02T18:30:00Z',
              ends_at: '2026-12-02T20:30:00Z',
              local_start_date: '2026-12-02',
              local_end_date: '2026-12-02',
            },
          }),
          event,
        },
      ],
      { title: 'New and changed', description: 'd', siteUrl: SITE, selfUrl: `${SITE}/feeds/new.rss` },
    );
    expect(xml).toContain('Thursday 3 December 2026');
    expect(xml).toContain('Wednesday 2 December 2026');
    expect(xml).toContain('<title>Updated (new date or time): Lisbon &lt;Meetup&gt; &amp; friends</title>');
    expect(xml).toContain('<guid isPermaLink="false">change-2@calenda11y.org</guid>');
    expect(xml).toContain('<pubDate>Fri, 20 Nov 2026 10:00:00 GMT</pubDate>');
  });

  it('new events and cancellations have their own titles', () => {
    const xml = buildChangesRss(
      [
        { change: change({ id: 3, kind: 'new', what: [], before_status: 'pending' }), event },
        { change: change({ id: 4, what: ['cancelled'], after: { status: 'cancelled' } }), event },
      ],
      { title: 't', description: 'd', siteUrl: SITE, selfUrl: `${SITE}/feeds/new.rss` },
    );
    expect(xml).toContain('<title>New: Lisbon &lt;Meetup&gt; &amp; friends</title>');
    expect(xml).toContain('<title>Updated (cancelled): Lisbon &lt;Meetup&gt; &amp; friends</title>');
  });
});
