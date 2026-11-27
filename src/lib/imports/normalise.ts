/** Turns a RawEvent into an ImportedEvent, or explains why it can't be used. */
import sanitizeHtml from 'sanitize-html';
import { isCountryCode } from '../events/predicates.ts';
import { isValidTimeZone } from '../events/tz.ts';
import type { ImportSource, ImportedEvent, RawEvent } from './types.ts';

/** Strips all markup, keeping paragraph breaks. */
export function toPlainText(html: string | null | undefined): string {
  if (!html) return '';
  const withBreaks = html.replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n\n');
  const text = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*(\n\s*)+/g, '\n\n')
    .trim();
}

const ONLINE_HINT = /\b(online|virtual|webinar|zoom|teams|google meet|livestream|live stream|remote)\b|https?:\/\//i;
const HYBRID_HINT = /\bhybrid\b/i;

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sentence = cut.lastIndexOf('. ');
  return sentence > max * 0.5 ? cut.slice(0, sentence + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

function httpsOrNull(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' && u.href.length <= 2000 ? u.href : null;
  } catch {
    return null;
  }
}

export type Normalised = { ok: true; event: ImportedEvent } | { ok: false; reason: string };

export function normalise(raw: RawEvent, source: ImportSource): Normalised {
  const title = toPlainText(raw.title).replace(/\s+/g, ' ').slice(0, 200);
  if (!title) return { ok: false, reason: 'It has no name' };

  const description = toPlainText(raw.description).slice(0, 20_000) || null;
  const firstParagraph = description?.split('\n\n')[0] ?? '';
  const summary = shorten(firstParagraph || `${title}, from ${source.name}.`, 280);

  const tz = raw.timezone && isValidTimeZone(raw.timezone) ? raw.timezone : (source.config.default_timezone ?? 'UTC');
  if (!isValidTimeZone(tz)) return { ok: false, reason: `Unknown time zone "${raw.timezone}"` };

  if (raw.all_day) {
    if (!raw.start_date || !raw.end_date || raw.end_date <= raw.start_date)
      return { ok: false, reason: 'Its dates are missing or the wrong way round' };
  } else if (!raw.starts_at || !raw.ends_at || Date.parse(raw.ends_at) <= Date.parse(raw.starts_at)) {
    return { ok: false, reason: 'Its times are missing or the end is before the start' };
  }

  const where = [raw.location, raw.city].filter(Boolean).join(' ');
  const online = raw.online ?? (!raw.location && !raw.city ? true : ONLINE_HINT.test(where));
  const hybrid = HYBRID_HINT.test(where) || (raw.online === true && !!raw.city);
  const format = hybrid ? 'hybrid' : online ? 'online' : 'in_person';
  let country: string | null = null;
  if (format !== 'online') {
    const candidate = (raw.country_code ?? source.config.default_country ?? '').toUpperCase();
    if (!isCountryCode(candidate))
      return {
        ok: false,
        reason: 'It is in person but the country is not known. Set a default country for this source',
      };
    country = candidate;
  }

  return {
    ok: true,
    event: {
      source_uid: raw.source_uid,
      cancelled: raw.cancelled ?? false,
      fields: {
        title,
        summary,
        description,
        lang: source.config.lang ?? 'en',
        organiser: toPlainText(raw.organiser).slice(0, 200) || source.name.slice(0, 200),
        url: httpsOrNull(raw.url),
        all_day: raw.all_day,
        starts_at: raw.all_day ? null : new Date(raw.starts_at!).toISOString(),
        ends_at: raw.all_day ? null : new Date(raw.ends_at!).toISOString(),
        start_date: raw.all_day ? raw.start_date! : null,
        end_date: raw.all_day ? raw.end_date! : null,
        timezone: tz,
        format,
        country_code: country,
        city: format === 'online' ? null : (raw.city?.slice(0, 120) ?? null),
        venue: format === 'online' ? null : (raw.location?.replace(/\s+/g, ' ').slice(0, 300) ?? null),
        price: raw.free === false ? 'paid' : 'free',
      },
    },
  };
}
