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

describe('the language of event text in emails (WCAG 3.1.2)', () => {
  const pt = {
    title: 'Encontro de acessibilidade',
    url: 'https://x.test/events/pt',
    when: 'Wednesday 5 March 2031, 18:00 to 20:00',
    where: 'Lisbon, Portugal',
    summary: 'Palestras curtas.',
    lang: 'pt',
  };

  it('marks a Portuguese title and summary, and nothing else', () => {
    const e = digestEmail('H', [pt], 'https://m', 'https://u');
    expect(e.html).toMatch(/<a lang="pt" href="https:\/\/x.test\/events\/pt"[^>]*>Encontro de acessibilidade<\/a>/);
    expect(e.html).toContain('<span lang="pt">Palestras curtas.</span>');
    expect(e.html).not.toMatch(/lang="pt"[^>]*>[^<]*Wednesday/);
    expect(e.text).toContain('Palestras curtas.');
  });

  it('adds nothing for English', () => {
    const e = digestEmail('H', [{ ...pt, lang: 'en' }], 'https://m', 'https://u');
    expect(e.html).not.toContain('lang="en"><');
    expect(e.html.match(/ lang="/g)).toHaveLength(2); // <html> and the article only
  });

  it('drops a language that is not a language code', () => {
    const e = digestEmail('H', [{ ...pt, lang: '"><script>' }], 'https://m', 'https://u');
    expect(e.html).not.toContain('<script>');
    expect(e.html.match(/ lang="/g)).toHaveLength(2);
  });

  it('keeps the English deadline out of a call for speakers link', () => {
    const e = digestEmail('H', [], 'https://m', 'https://u', {
      cfp: [
        {
          title: 'Encontro',
          url: 'https://x.test/cfp',
          deadline: 'Apply by Monday 8 March 2031',
          event: 'Wednesday 5 March 2031, Lisbon, Portugal',
          lang: 'pt',
        },
      ],
    });
    expect(e.html).toMatch(/<a lang="pt" href="https:\/\/x.test\/cfp"[^>]*>Encontro<\/a>/);
    expect(e.html).toMatch(/Apply by Monday 8 March 2031/);
    expect(e.html).not.toMatch(/<a[^>]*>[^<]*Apply by/);
  });

  it('marks a title quoted in an English sentence', () => {
    const e = submissionReceived({
      title: 'Encontro',
      slug: 'e',
      all_day: true,
      starts_at: null,
      ends_at: null,
      local_start_date: '2031-03-05',
      local_end_date: '2031-03-05',
      timezone: 'Europe/Lisbon',
      lang: 'pt',
    });
    expect(e.html).toContain('You added &quot;<span lang="pt">Encontro</span>&quot;');
    expect(e.text).toContain('You added "Encontro"');
  });
});

describe('email link targets (WCAG 2.5.5)', () => {
  it('standalone and list links are at least 44 by 44 pixels', () => {
    const e = renderEmail('S', 'H', [
      { type: 'link', text: 'Go', href: 'https://x.test' },
      { type: 'list', items: [{ text: 'A', href: 'https://x.test/a' }] },
    ]);
    const links = e.html.match(/<a [^>]*>/g)!;
    expect(links).toHaveLength(2);
    for (const a of links) expect(a).toMatch(/min-width:44px;min-height:44px/);
  });
});
