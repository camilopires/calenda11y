/** An RSS 2.0 feed of events. */
import { TOPIC_LABELS, TYPE_LABELS, type PublicEvent } from '../events/model.ts';
import { describeWhen } from '../events/dates.ts';
import { cfpDeadline } from '../events/cfp.ts';
import { eventLocation, eventPageUrl } from './ics.ts';

export function escapeXml(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // XML 1.0 forbids most control characters, even escaped.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

export interface FeedOptions {
  title: string;
  description: string;
  siteUrl: string;
  selfUrl: string;
}

export function buildRss(events: readonly PublicEvent[], o: FeedOptions): string {
  const items = events.map((e) => {
    const when = describeWhen(e);
    const link = eventPageUrl(o.siteUrl, e.slug);
    const cfp = cfpDeadline(e);
    const desc = `${when.date}, ${when.time}. ${eventLocation(e)}. ${e.summary}${cfp ? ` ${cfp}: ${e.cfp_url}` : ''}`;
    return [
      '    <item>',
      `      <title>${escapeXml(e.status === 'cancelled' ? `Cancelled: ${e.title}` : e.title)}</title>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
      `      <description>${escapeXml(desc)}</description>`,
      ...e.types.map((t) => `      <category>${escapeXml(TYPE_LABELS[t])}</category>`),
      ...e.topics.map((t) => `      <category>${escapeXml(TOPIC_LABELS[t])}</category>`),
      `      <pubDate>${new Date(e.approved_at ?? e.updated_at).toUTCString()}</pubDate>`,
      '    </item>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(o.title)}</title>`,
    `    <link>${escapeXml(o.siteUrl)}</link>`,
    `    <description>${escapeXml(o.description)}</description>`,
    '    <language>en</language>',
    `    <atom:link href="${escapeXml(o.selfUrl)}" rel="self" type="application/rss+xml"/>`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
