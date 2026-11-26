/**
 * Turns plain text (event descriptions) into paragraphs and links without
 * ever producing HTML strings. Components render the parts, so nothing a
 * submitter writes can become markup.
 */

export type TextPart = { type: 'text'; text: string } | { type: 'link'; href: string; text: string };
export type Paragraph = TextPart[];

const URL_PATTERN = /\bhttps:\/\/[^\s<>"']+/g;
// Punctuation that usually ends a sentence rather than a URL.
const TRAILING = /[.,;:!?)\]]+$/;

export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    const trail = TRAILING.exec(url)?.[0] ?? '';
    if (trail) url = url.slice(0, -trail.length);
    const start = match.index;
    if (start > last) parts.push({ type: 'text', text: text.slice(last, start) });
    try {
      const href = new URL(url).href;
      parts.push({ type: 'link', href, text: url });
    } catch {
      parts.push({ type: 'text', text: url });
    }
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}

/** Splits on blank lines. Single line breaks inside a paragraph become spaces. */
export function toParagraphs(text: string | null | undefined): Paragraph[] {
  if (!text) return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map(linkify);
}
