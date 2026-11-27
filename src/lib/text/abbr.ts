/**
 * Time zone abbreviations in event times (WCAG 3.1.4). Pages mark them up
 * with <abbr>; plain-text places (emails) add a sentence that expands them.
 */

export const ZONE_ABBRS = {
  UTC: 'Coordinated Universal Time',
  GMT: 'Greenwich Mean Time',
} as const;

export interface AbbrPart {
  text: string;
  /** The expanded form, when this part is an abbreviation. */
  title?: string;
}

const PATTERN = /\b(UTC|GMT)\b/g;

/** Splits text into plain parts and abbreviations, in order. */
export function splitAbbreviations(text: string): AbbrPart[] {
  const parts: AbbrPart[] = [];
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const abbr = m[1] as keyof typeof ZONE_ABBRS;
    parts.push({ text: abbr, title: ZONE_ABBRS[abbr] });
    last = m.index + abbr.length;
  }
  if (last < text.length || parts.length === 0) parts.push({ text: text.slice(last) });
  return parts;
}

/** A sentence explaining the abbreviations used in these texts, or null if there are none. */
export function zoneNote(texts: string[]): string | null {
  const joined = texts.join(' ');
  const notes: string[] = [];
  if (/\bUTC\b/.test(joined)) notes.push(`UTC means ${ZONE_ABBRS.UTC}.`);
  if (/\bGMT\b/.test(joined)) notes.push(`GMT means ${ZONE_ABBRS.GMT}, the same as ${ZONE_ABBRS.UTC}.`);
  return notes.length ? notes.join(' ') : null;
}
