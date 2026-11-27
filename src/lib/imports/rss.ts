/**
 * RSS adapter. RSS has no standard event dates, so it reads the RSS Events
 * module (ev:startdate / ev:enddate), which event sites use. Items without
 * a date are skipped and reported.
 */
import { XMLParser } from 'fast-xml-parser';
import type { Adapter, FetchPage, ImportSource, RawEvent, Skipped } from './types.ts';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: false,
  processEntities: true,
  htmlEntities: true,
});

const asText = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && '#text' in (v as object)) return String((v as { '#text': unknown })['#text']);
  return String(v);
};

export function parseRss(body: string, source: ImportSource, now: Date): FetchPage {
  let doc: { rss?: { channel?: { item?: unknown } } };
  try {
    doc = parser.parse(body);
  } catch (error) {
    throw new Error(`The feed is not valid RSS: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const channel = doc.rss?.channel;
  if (!channel) throw new Error('The address did not return an RSS feed');
  const rawItems = [channel.item ?? []].flat() as Array<Record<string, unknown>>;
  const items: RawEvent[] = [];
  const skipped: Skipped[] = [];
  for (const item of rawItems) {
    const uid = asText(item.guid) ?? asText(item.link);
    if (!uid) {
      skipped.push({ uid: '(no guid)', reason: 'It has no guid or link, so it cannot be tracked' });
      continue;
    }
    const start = asText(item['ev:startdate']);
    const end = asText(item['ev:enddate']);
    if (!start || Number.isNaN(Date.parse(start))) {
      skipped.push({ uid, reason: 'It has no event date (ev:startdate)' });
      continue;
    }
    const startsAt = new Date(start).toISOString();
    const endsAt =
      end && !Number.isNaN(Date.parse(end))
        ? new Date(end).toISOString()
        : new Date(Date.parse(startsAt) + 3600_000).toISOString();
    if (Date.parse(endsAt) < now.getTime() - 86_400_000) continue;
    items.push({
      source_uid: uid,
      title: asText(item.title) ?? '',
      description: asText(item.description),
      url: asText(item.link),
      organiser: asText(item['ev:organizer']),
      location: asText(item['ev:location']),
      all_day: false,
      starts_at: startsAt,
      ends_at: endsAt,
      timezone: source.config.default_timezone ?? null,
    });
  }
  return { items, skipped };
}

export const rssAdapter: Adapter = {
  async fetchPage(source, _cursor, ctx) {
    if (!source.config.url) throw new Error('This source has no feed address');
    const res = await ctx.fetchText(source.config.url);
    if (res.status !== 200) throw new Error(`The feed answered with HTTP ${res.status}`);
    return parseRss(res.body, source, ctx.now);
  },
};
