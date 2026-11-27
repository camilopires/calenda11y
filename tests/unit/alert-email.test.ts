import { describe, expect, it } from 'vitest';
import { alertEmail, type AlertItem } from '../../src/lib/email/templates.ts';

const item = (title: string, reasons: string[] = []): AlertItem => ({
  title,
  url: `https://x.test/events/${title}`,
  when: 'Tuesday 1 December 2026, 18:30 to 20:30, Lisbon time (GMT)',
  where: 'Lisbon, Portugal',
  summary: 'Talks.',
  reasons,
});

describe('alertEmail', () => {
  it('has New and Updated sections, with what changed, in HTML and text', () => {
    const e = alertEmail([item('Fresh')], [item('Moved', ['Moved to: Porto, Portugal'])], 'https://m', 'https://u');
    expect(e.subject).toBe('New and updated accessibility events');
    for (const body of [e.html, e.text]) {
      expect(body).toContain('New');
      expect(body).toContain('Updated');
      expect(body).toContain('Moved to: Porto, Portugal');
      expect(body).toContain('Fresh');
    }
    expect(e.html).toMatch(/<h2[^>]*>New<\/h2>/);
    expect(e.html).toMatch(/<h2[^>]*>Updated<\/h2>/);
    expect(e.text).toContain('GMT means Greenwich Mean Time');
  });

  it('leaves out an empty section', () => {
    const e = alertEmail([], [item('Moved', ['Cancelled'])], 'https://m', 'https://u');
    expect(e.html).not.toMatch(/<h2[^>]*>New<\/h2>/);
  });

  it('says when it shows only some, and links to the rest', () => {
    const e = alertEmail([item('A')], [], 'https://m', 'https://u', {
      total: 340,
      listUrl: 'https://x.test/?country=PT',
    });
    expect(e.text).toContain('These are the first 1 of 340. See everything new on calenda11y');
    expect(e.text).toContain('https://x.test/?country=PT');
  });
});
