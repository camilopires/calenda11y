/**
 * Accessible HTML email: one column, semantic headings and lists, real text
 * (no images), 7:1 contrast, and a plain-text version of everything.
 */

export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** A run of text in a paragraph; `lang` marks event text in another language (WCAG 3.1.2). */
export type Inline = string | { text: string; lang?: string | null | undefined };

export interface ListItem {
  /** The title: the link text when there's an href. In the event's language. */
  text: string;
  href?: string;
  /** English details: date, place, what changed. */
  detail?: string;
  /** The event's summary, in its own language, on its own line. */
  summary?: string;
  lang?: string | null | undefined;
}

export type Block =
  | { type: 'p'; text: string | Inline[] }
  | { type: 'h2'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'list'; items: ListItem[] };

const INK = '#0f1b3d';
const LINK = '#123f9c';
const PAPER = '#ffffff';
const MUTED = '#3a4560';

const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** ` lang="…"` for text in another language. The email is English, so English needs none. */
function langAttr(lang: string | null | undefined): string {
  if (!lang || !LANG.test(lang) || lang === 'en' || lang.startsWith('en-')) return '';
  return ` lang="${esc(lang)}"`;
}

/** Standalone links are buttons in all but looks: at least 44 by 44 pixels to tap (WCAG 2.5.5). */
const TARGET =
  'display:inline-block;min-width:44px;min-height:44px;padding:10px 0;line-height:24px;box-sizing:border-box';

const inlineHtml = (parts: string | Inline[]) =>
  typeof parts === 'string'
    ? esc(parts)
    : parts
        .map((p) => {
          if (typeof p === 'string') return esc(p);
          const lang = langAttr(p.lang);
          return lang ? `<span${lang}>${esc(p.text)}</span>` : esc(p.text);
        })
        .join('');

const inlineText = (parts: string | Inline[]) =>
  typeof parts === 'string' ? parts : parts.map((p) => (typeof p === 'string' ? p : p.text)).join('');

function blockHtml(b: Block): string {
  switch (b.type) {
    case 'p':
      return `<p style="margin:0 0 16px;font-size:17px;line-height:1.5;color:${INK}">${inlineHtml(b.text)}</p>`;
    case 'h2':
      return `<h2 style="margin:28px 0 12px;font-size:21px;line-height:1.3;color:${INK}">${esc(b.text)}</h2>`;
    case 'link':
      return `<p style="margin:0 0 16px;font-size:17px;line-height:1.5"><a href="${esc(b.href)}" style="color:${LINK};font-weight:bold;${TARGET}">${esc(b.text)}</a></p>`;
    case 'list':
      return `<ul style="margin:0 0 16px;padding-left:22px;font-size:17px;line-height:1.5;color:${INK}">${b.items
        .map((i) => {
          const lang = langAttr(i.lang);
          const title = i.href
            ? `<a${lang} href="${esc(i.href)}" style="color:${LINK};font-weight:bold;${TARGET}">${esc(i.text)}</a>`
            : lang
              ? `<span${lang}>${esc(i.text)}</span>`
              : esc(i.text);
          const detail = i.detail ? `<br><span style="color:${MUTED}">${esc(i.detail)}</span>` : '';
          const summary = i.summary ? `<br><span${lang}>${esc(i.summary)}</span>` : '';
          return `<li style="margin:0 0 12px">${title}${detail}${summary}</li>`;
        })
        .join('')}</ul>`;
  }
}

function blockText(b: Block): string {
  switch (b.type) {
    case 'p':
      return inlineText(b.text);
    case 'h2':
      return `${b.text}\n${'-'.repeat(Math.min(b.text.length, 60))}`;
    case 'link':
      return `${b.text}: ${b.href}`;
    case 'list':
      return b.items
        .map(
          (i) =>
            `- ${i.text}${i.detail ? `\n  ${i.detail}` : ''}${i.summary ? `\n  ${i.summary}` : ''}${i.href ? `\n  ${i.href}` : ''}`,
        )
        .join('\n\n');
  }
}

export function renderEmail(subject: string, heading: string, blocks: Block[], footer: Block[] = []): EmailContent {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};font-family:'Atkinson Hyperlegible Next','Atkinson Hyperlegible',Verdana,Arial,sans-serif">
<main>
<div role="article" aria-roledescription="email" aria-label="${esc(subject)}" lang="en" style="max-width:600px;margin:0 auto;padding:24px 16px">
<p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:${INK}">calenda11y</p>
<h1 style="margin:0 0 20px;font-size:26px;line-height:1.25;color:${INK}">${esc(heading)}</h1>
${blocks.map(blockHtml).join('\n')}
${footer.length ? `<hr style="border:0;border-top:2px solid ${MUTED};margin:32px 0 16px">\n${footer.map(blockHtml).join('\n')}` : ''}
</div>
</main>
</body>
</html>`;
  const text = [
    heading,
    '',
    ...blocks.map(blockText).flatMap((t) => [t, '']),
    ...(footer.length ? ['---', '', ...footer.map(blockText).flatMap((t) => [t, ''])] : []),
  ]
    .join('\n')
    .trim();
  return { subject, html, text: `${text}\n` };
}
