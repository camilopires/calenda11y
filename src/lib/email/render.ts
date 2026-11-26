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

export type Block =
  | { type: 'p'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'list'; items: Array<{ text: string; href?: string; detail?: string }> };

const INK = '#0f1b3d';
const LINK = '#123f9c';
const PAPER = '#ffffff';
const MUTED = '#3a4560';

function blockHtml(b: Block): string {
  switch (b.type) {
    case 'p':
      return `<p style="margin:0 0 16px;font-size:17px;line-height:1.5;color:${INK}">${esc(b.text)}</p>`;
    case 'h2':
      return `<h2 style="margin:28px 0 12px;font-size:21px;line-height:1.3;color:${INK}">${esc(b.text)}</h2>`;
    case 'link':
      return `<p style="margin:0 0 16px;font-size:17px;line-height:1.5"><a href="${esc(b.href)}" style="color:${LINK};font-weight:bold">${esc(b.text)}</a></p>`;
    case 'list':
      return `<ul style="margin:0 0 16px;padding-left:22px;font-size:17px;line-height:1.5;color:${INK}">${b.items
        .map(
          (i) =>
            `<li style="margin:0 0 12px">${i.href ? `<a href="${esc(i.href)}" style="color:${LINK};font-weight:bold">${esc(i.text)}</a>` : esc(i.text)}${i.detail ? `<br><span style="color:${MUTED}">${esc(i.detail)}</span>` : ''}</li>`,
        )
        .join('')}</ul>`;
  }
}

function blockText(b: Block): string {
  switch (b.type) {
    case 'p':
      return b.text;
    case 'h2':
      return `${b.text}\n${'-'.repeat(Math.min(b.text.length, 60))}`;
    case 'link':
      return `${b.text}: ${b.href}`;
    case 'list':
      return b.items
        .map((i) => `- ${i.text}${i.detail ? `\n  ${i.detail}` : ''}${i.href ? `\n  ${i.href}` : ''}`)
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
<div role="article" aria-roledescription="email" aria-label="${esc(subject)}" lang="en" style="max-width:600px;margin:0 auto;padding:24px 16px">
<p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:${INK}">calenda11y</p>
<h1 style="margin:0 0 20px;font-size:26px;line-height:1.25;color:${INK}">${esc(heading)}</h1>
${blocks.map(blockHtml).join('\n')}
${footer.length ? `<hr style="border:0;border-top:2px solid ${MUTED};margin:32px 0 16px">\n${footer.map(blockHtml).join('\n')}` : ''}
</div>
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
