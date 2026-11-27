import { describe, expect, it } from 'vitest';
import { backoffMinutes } from '../../src/lib/email/outbox.ts';
import { renderEmail } from '../../src/lib/email/render.ts';

describe('renderEmail', () => {
  const email = renderEmail('Subject <x>', 'Heading & more', [
    { type: 'p', text: 'Hello <b>there</b>' },
    { type: 'link', text: 'Open', href: 'https://example.org/?a=1&b=2' },
    { type: 'list', items: [{ text: 'One', href: 'https://example.org/1', detail: 'Detail' }] },
  ]);

  it('escapes everything it is given', () => {
    expect(email.html).toContain('Hello &lt;b&gt;there&lt;/b&gt;');
    expect(email.html).toContain('<title>Subject &lt;x&gt;</title>');
    expect(email.html).toContain('href="https://example.org/?a=1&amp;b=2"');
  });

  it('has a language, a heading and a plain-text version with every link', () => {
    expect(email.html).toContain('<html lang="en">');
    expect(email.html).toContain('<h1');
    expect(email.text).toContain('Heading & more');
    expect(email.text).toContain('Open: https://example.org/?a=1&b=2');
    expect(email.text).toContain('- One\n  Detail\n  https://example.org/1');
  });
});

describe('backoffMinutes', () => {
  it('grows and is capped', () => {
    expect([1, 2, 3].map(backoffMinutes)).toEqual([1, 4, 9]);
    expect(backoffMinutes(100)).toBe(360);
  });
});

import { digestEmail, submissionReceived } from '../../src/lib/email/templates.ts';

describe('digestEmail', () => {
  const item = { title: 'A', url: 'https://x.test/a', when: 'Monday', where: 'Online', summary: 'S.' };
  it('gives the true total and a link to all of them when it lists only some', () => {
    const e = digestEmail('H', [item], 'https://m', 'https://u', { total: 60, listUrl: 'https://x.test/?country=PT' });
    expect(e.text).toContain('60 events match your choices. Here are the first 1.');
    expect(e.text).toContain('See all 60 events on calenda11y: https://x.test/?country=PT');
    expect(digestEmail('H', [item, item], 'https://m', 'https://u').text).toContain('2 events for you.');
  });
});

describe('time zone abbreviations in emails', () => {
  const lisbon = {
    title: 'Meetup',
    slug: 'meetup',
    all_day: false,
    starts_at: '2026-11-30T18:30:00Z',
    ends_at: '2026-11-30T20:30:00Z',
    local_start_date: '2026-11-30',
    local_end_date: '2026-11-30',
    timezone: 'Europe/Lisbon',
  };

  it('the submission receipt explains GMT in both versions', () => {
    const e = submissionReceived(lisbon);
    expect(e.text).toContain('GMT means Greenwich Mean Time');
    expect(e.html).toContain('GMT means Greenwich Mean Time');
  });

  it('a digest explains UTC', () => {
    const item = {
      title: 'T',
      url: 'https://x.test/e',
      when: 'Monday, 17:00 to 18:00, UTC',
      where: 'Online',
      summary: 'S',
    };
    expect(digestEmail('H', [item], 'https://m', 'https://u').text).toContain('UTC means Coordinated Universal Time');
  });

  it('an all-day event gets no note', () => {
    const e = submissionReceived({ ...lisbon, all_day: true, starts_at: null, ends_at: null });
    expect(e.text).not.toContain('means');
  });
});
