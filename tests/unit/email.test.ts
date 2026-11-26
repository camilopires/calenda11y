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
