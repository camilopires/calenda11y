/**
 * The iCalendar (.ics) adapter, also used for Luma and Meetup group feeds.
 *
 * Time handling:
 *  - "…Z" times are UTC.
 *  - TZID times use the feed's own VTIMEZONE if it has one; otherwise, if the
 *    TZID is an IANA name, our Intl-based conversion (no zone database needed).
 *  - Floating times (no zone) use the source's default time zone.
 *  - Anything else is skipped and reported, never guessed.
 *
 * Recurring events are expanded up to a year ahead (at most 200 occurrences
 * per series). Each occurrence keeps its identity through moves: its
 * source_uid is the UID plus the original RECURRENCE-ID, so a rescheduled
 * occurrence updates the same event instead of creating a new one.
 */
import ICAL from 'ical.js';
import { addDays } from '../events/dates.ts';
import { isValidTimeZone, zonedTimeToUtc } from '../events/tz.ts';
import {
  IMPORT_LIMITS,
  type Adapter,
  type FetchPage,
  type ImportSource,
  type RawEvent,
  type Skipped,
} from './types.ts';

type ITime = InstanceType<typeof ICAL.Time>;
type IEvent = InstanceType<typeof ICAL.Event>;

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (t: ITime) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;
const timeOf = (t: ITime) => `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;

/** The TZID a time was written with, if any. */
function tzidOf(t: ITime): string | undefined {
  const zone = t.zone;
  if (zone && zone !== ICAL.Timezone.utcTimezone && zone !== ICAL.Timezone.localTimezone && zone.tzid) return zone.tzid;
  const tz = (t as unknown as { timezone?: string }).timezone;
  return tz && tz !== 'Z' && tz !== 'floating' ? tz : undefined;
}

/** The TZID parameter on a component's DTSTART (occurrence times from the iterator can lose it). */
function dtstartTzid(event: IEvent): string | undefined {
  const tzid = event.component.getFirstProperty('dtstart')?.getParameter('tzid');
  return typeof tzid === 'string' ? tzid : undefined;
}

const isUtc = (t: ITime) =>
  t.zone === ICAL.Timezone.utcTimezone || (t as unknown as { timezone?: string }).timezone === 'Z';

export type InstantResult = { ok: true; instant: string } | { ok: false; reason: string };

export function toInstant(t: ITime, registered: Set<string>, defaultTz: string, tzidHint?: string): InstantResult {
  if (isUtc(t)) {
    return {
      ok: true,
      instant: new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second)).toISOString(),
    };
  }
  const tzid = tzidOf(t) ?? tzidHint;
  if (tzid && registered.has(tzid)) {
    const zone = ICAL.TimezoneService.get(tzid);
    if (zone) {
      const zoned = ICAL.Time.fromData(
        { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
        zone,
      );
      return { ok: true, instant: new Date(zoned.toUnixTime() * 1000).toISOString() };
    }
  }
  const zone = tzid ?? defaultTz;
  if (!isValidTimeZone(zone)) return { ok: false, reason: `Unknown time zone "${zone}"` };
  const r = zonedTimeToUtc(dateOf(t), timeOf(t), zone);
  // A time skipped by daylight saving is moved forward an hour, as calendar apps do.
  if (!r.ok) {
    const later = zonedTimeToUtc(dateOf(t), `${pad(Math.min(t.hour + 1, 23))}:${pad(t.minute)}:${pad(t.second)}`, zone);
    return later.ok ? later : { ok: false, reason: 'Its time does not exist in its time zone' };
  }
  return r;
}

function text(event: IEvent, name: string): string | null {
  const v = event.component.getFirstPropertyValue(name);
  return v === null || v === undefined ? null : String(v);
}

function organiserOf(event: IEvent): string | null {
  const prop = event.component.getFirstProperty('organizer');
  const cn = prop?.getParameter('cn');
  return typeof cn === 'string' ? cn : null;
}

function rawFrom(
  base: IEvent,
  item: IEvent,
  start: ITime,
  end: ITime | null,
  uid: string,
  registered: Set<string>,
  source: ImportSource,
): RawEvent | Skipped {
  const defaultTz = source.config.default_timezone ?? 'UTC';
  const hint = dtstartTzid(item) ?? dtstartTzid(base);
  const tzid = tzidOf(start) ?? hint;
  const timezone = tzid && isValidTimeZone(tzid) ? tzid : defaultTz;
  const common = {
    source_uid: uid,
    title: item.summary || base.summary || '',
    description: item.description || base.description || null,
    url: text(item, 'url') ?? text(base, 'url'),
    organiser: organiserOf(item) ?? organiserOf(base),
    location: item.location || base.location || null,
    timezone,
    cancelled: (text(item, 'status') ?? '').toUpperCase() === 'CANCELLED',
  };
  if (start.isDate) {
    const startDate = dateOf(start);
    const endDate = end && end.isDate ? dateOf(end) : addDays(startDate, 1);
    return {
      ...common,
      all_day: true,
      start_date: startDate,
      end_date: endDate > startDate ? endDate : addDays(startDate, 1),
    };
  }
  const s = toInstant(start, registered, defaultTz, hint);
  if (!s.ok) return { uid, reason: s.reason };
  let endsAt: string;
  if (end) {
    const e = toInstant(end, registered, defaultTz, hint);
    if (!e.ok) return { uid, reason: e.reason };
    endsAt = e.instant;
  } else {
    // No end: RFC 5545 says it ends when it starts; give it an hour so it shows up.
    endsAt = new Date(Date.parse(s.instant) + 3600_000).toISOString();
  }
  return { ...common, all_day: false, starts_at: s.instant, ends_at: endsAt };
}

const isSkipped = (x: RawEvent | Skipped): x is Skipped => 'reason' in x;

/** Parses an iCalendar document into raw events. */
export function parseIcs(body: string, source: ImportSource, now: Date): FetchPage {
  let root: InstanceType<typeof ICAL.Component>;
  try {
    root = new ICAL.Component(ICAL.parse(body));
  } catch (error) {
    throw new Error(`The feed is not valid iCalendar: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const registered = new Set<string>();
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    const id = vtz.getFirstPropertyValue('tzid');
    if (typeof id === 'string') {
      ICAL.TimezoneService.register(vtz);
      registered.add(id);
    }
  }

  const items: RawEvent[] = [];
  const skipped: Skipped[] = [];
  let truncated = false;
  const earliestEnd = now.getTime() - IMPORT_LIMITS.keepEndedDays * 86_400_000;
  const horizon = now.getTime() + IMPORT_LIMITS.horizonDays * 86_400_000;

  const vevents = root.getAllSubcomponents('vevent');
  const masters = new Map<string, IEvent>();
  const exceptions: IEvent[] = [];
  for (const c of vevents) {
    const e = new ICAL.Event(c);
    if (!e.uid) {
      skipped.push({ uid: '(no UID)', reason: 'It has no UID, so it cannot be tracked' });
      continue;
    }
    if (c.hasProperty('recurrence-id')) exceptions.push(e);
    else masters.set(e.uid, e);
  }
  for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);

  const keep = (r: RawEvent) => {
    const end = r.all_day ? Date.parse(`${r.end_date}T00:00:00Z`) : Date.parse(r.ends_at!);
    return end >= earliestEnd;
  };

  for (const [uid, event] of masters) {
    if (items.length >= IMPORT_LIMITS.maxItemsPerRun) {
      skipped.push({
        uid,
        reason: `The feed has more than ${IMPORT_LIMITS.maxItemsPerRun} events; the rest were not read`,
      });
      truncated = true;
      break;
    }
    if (!event.startDate) {
      skipped.push({ uid, reason: 'It has no start' });
      continue;
    }
    if (!event.isRecurring()) {
      const r = rawFrom(event, event, event.startDate, event.endDate ?? null, uid, registered, source);
      if (isSkipped(r)) skipped.push(r);
      else if (keep(r)) items.push(r);
      continue;
    }
    // Expansion starts at the series' first DTSTART, so an old weekly series
    // walks through its past first. Past occurrences don't count towards the
    // per-series cap, and a hard ceiling on steps keeps the work bounded.
    const iterator = event.iterator();
    let kept = 0;
    let steps = 0;
    for (let next = iterator.next(); next; next = iterator.next()) {
      if (++steps > IMPORT_LIMITS.maxRecurrenceSteps) {
        skipped.push({ uid, reason: 'It repeats too often to read in full; later occurrences were not read' });
        break;
      }
      if (next.toJSDate().getTime() > horizon) break;
      const details = event.getOccurrenceDetails(next);
      // Identify the occurrence by its original start, in UTC, so it stays the same if the occurrence moves.
      const original = details.recurrenceId.isDate
        ? { ok: true as const, instant: dateOf(details.recurrenceId) }
        : toInstant(details.recurrenceId, registered, source.config.default_timezone ?? 'UTC', dtstartTzid(event));
      if (!original.ok) {
        skipped.push({ uid, reason: original.reason });
        continue;
      }
      const occurrenceUid = `${uid}#${original.instant.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
      const r = rawFrom(event, details.item, details.startDate, details.endDate, occurrenceUid, registered, source);
      if (isSkipped(r)) {
        skipped.push(r);
        continue;
      }
      if (!keep(r)) continue;
      if (++kept > IMPORT_LIMITS.maxOccurrencesPerSeries) {
        skipped.push({
          uid,
          reason: `It repeats more than ${IMPORT_LIMITS.maxOccurrencesPerSeries} times in the next year; later ones were not read`,
        });
        break;
      }
      items.push(r);
      if (items.length >= IMPORT_LIMITS.maxItemsPerRun) {
        truncated = true;
        break;
      }
    }
  }
  return { items, skipped, ...(truncated && { truncated }) };
}

export const icsAdapter: Adapter = {
  async fetchPage(source, _cursor, ctx) {
    if (!source.config.url) throw new Error('This source has no feed address');
    const res = await ctx.fetchText(source.config.url);
    if (res.status !== 200) throw new Error(`The feed answered with HTTP ${res.status}`);
    if (!/BEGIN:VCALENDAR/i.test(res.body.slice(0, 2000)))
      throw new Error('The address did not return an iCalendar feed');
    return parseIcs(res.body, source, ctx.now);
  },
};
