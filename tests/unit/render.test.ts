import { describe, expect, it } from 'vitest';
import { linkify, toParagraphs } from '../../src/lib/text/render.ts';

describe('toParagraphs', () => {
  it('splits on blank lines and joins single line breaks', () => {
    expect(toParagraphs('One\nline.\n\n\nTwo.')).toEqual([
      [{ type: 'text', text: 'One line.' }],
      [{ type: 'text', text: 'Two.' }],
    ]);
  });

  it('returns nothing for empty text', () => {
    expect(toParagraphs(null)).toEqual([]);
    expect(toParagraphs('  \n\n ')).toEqual([]);
  });

  it('keeps markup as plain text', () => {
    expect(toParagraphs('<script>alert(1)</script>')).toEqual([[{ type: 'text', text: '<script>alert(1)</script>' }]]);
  });
});

describe('linkify', () => {
  it('links https URLs and leaves trailing punctuation outside', () => {
    expect(linkify('Details at https://example.org/a?b=1. Thanks')).toEqual([
      { type: 'text', text: 'Details at ' },
      { type: 'link', href: 'https://example.org/a?b=1', text: 'https://example.org/a?b=1' },
      { type: 'text', text: '. Thanks' },
    ]);
  });

  it('does not link other schemes', () => {
    expect(linkify('javascript:alert(1) http://example.org')).toEqual([
      { type: 'text', text: 'javascript:alert(1) http://example.org' },
    ]);
  });
});
