/**
 * Flesch–Kincaid grade level, used to keep site copy at about a US grade 9
 * reading level (WCAG 3.1.5 Reading Level). The syllable count is a
 * standard heuristic: good enough to catch hard text, not exact.
 */

export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

export interface Readability {
  words: number;
  sentences: number;
  syllables: number;
  grade: number;
}

export function fleschKincaid(text: string): Readability {
  // Drop URLs and email addresses, which aren't prose.
  const prose = text.replace(/\bhttps?:\/\/\S+|\S+@\S+\.\S+/g, ' ');
  const sentences = Math.max(1, prose.split(/[.!?:]+(?=\s|$)|\n{2,}/).filter((s) => /[a-z]/i.test(s)).length);
  const words = prose.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const wc = Math.max(1, words.length);
  return {
    words: words.length,
    sentences,
    syllables: syl,
    grade: Math.round((0.39 * (wc / sentences) + 11.8 * (syl / wc) - 15.59) * 10) / 10,
  };
}
