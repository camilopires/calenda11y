/**
 * Validating event details from the submit form and the admin edit form.
 * Messages follow one pattern: say what to do, in plain words.
 */
import type { FieldErrors } from './errors.ts';
import {
  ACCESS_PROVISIONS,
  EVENT_TYPES,
  FORMATS,
  PRICES,
  type AccessProvision,
  type EventType,
  type Format,
  type Price,
} from '../events/model.ts';
import { addDays, isIsoDate } from '../events/dates.ts';
import { isCountryCode } from '../events/predicates.ts';
import { isValidTimeZone, zonedTimeToUtc } from '../events/tz.ts';

/** Languages offered for event content. Anything else can be set by an admin. */
export const LANGUAGES = [
  'en',
  'ar',
  'zh',
  'cs',
  'da',
  'nl',
  'fi',
  'fr',
  'de',
  'el',
  'he',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'nb',
  'pl',
  'pt',
  'pt-BR',
  'ro',
  'ru',
  'es',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
] as const;

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
export const languageName = (code: string): string => languageNames.of(code) ?? code;

export const LIMITS = {
  title: 200,
  summary: 280,
  description: 20_000,
  organiser: 200,
  url: 2000,
  /** Matches the database check on events.cfp_url. */
  cfpUrl: 500,
  city: 120,
  venue: 300,
  accessNotes: 2000,
  name: 200,
  email: 320,
} as const;

/** What the person typed, kept as strings so the form can be shown again exactly. */
export interface EventFormValues {
  title: string;
  summary: string;
  description: string;
  lang: string;
  organiser: string;
  url: string;
  timing: string;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  timezone: string;
  format: string;
  types: string[];
  country: string;
  city: string;
  venue: string;
  price: string;
  access: string[];
  access_notes: string;
  cfp_url: string;
  cfp_closes_on: string;
}

export interface SubmitterValues {
  name: string;
  email: string;
}

/** The checked, normalised event, ready for the database. */
export interface EventRecord {
  title: string;
  summary: string;
  description: string | null;
  lang: string;
  organiser: string;
  url: string;
  all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string;
  format: Format;
  types: EventType[];
  country_code: string | null;
  city: string | null;
  venue: string | null;
  price: Price;
  captions: boolean;
  sign_language: boolean;
  step_free: boolean;
  quiet_room: boolean;
  hearing_loop: boolean;
  remote_attendance: boolean;
  access_notes: string | null;
  /** Call for speakers: where to apply, and the last day (optional). */
  cfp_url: string | null;
  cfp_closes_on: string | null;
}

const str = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '';
};

export function readEventForm(form: FormData): EventFormValues {
  return {
    title: str(form, 'title'),
    summary: str(form, 'summary'),
    description: str(form, 'description'),
    lang: str(form, 'lang') || 'en',
    organiser: str(form, 'organiser'),
    url: str(form, 'url'),
    timing: str(form, 'timing'),
    start_date: str(form, 'start_date'),
    start_time: str(form, 'start_time'),
    end_date: str(form, 'end_date'),
    end_time: str(form, 'end_time'),
    timezone: str(form, 'timezone'),
    format: str(form, 'format'),
    types: form.getAll('type').filter((v): v is string => typeof v === 'string'),
    country: str(form, 'country').toUpperCase(),
    city: str(form, 'city'),
    venue: str(form, 'venue'),
    price: str(form, 'price'),
    access: form.getAll('access').filter((v): v is string => typeof v === 'string'),
    access_notes: str(form, 'access_notes'),
    cfp_url: str(form, 'cfp_url'),
    cfp_closes_on: str(form, 'cfp_closes_on'),
  };
}

export function readSubmitter(form: FormData): SubmitterValues {
  return { name: str(form, 'submitter_name'), email: str(form, 'submitter_email') };
}

export const EMPTY_EVENT_FORM: EventFormValues = {
  title: '',
  summary: '',
  description: '',
  lang: 'en',
  organiser: '',
  url: '',
  timing: '',
  start_date: '',
  start_time: '',
  end_date: '',
  end_time: '',
  timezone: '',
  format: '',
  types: [],
  country: '',
  city: '',
  venue: '',
  price: '',
  access: [],
  access_notes: '',
  cfp_url: '',
  cfp_closes_on: '',
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// A practical check, not the full RFC 5322 grammar.
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function isEmail(value: string): boolean {
  return value.length <= LIMITS.email && EMAIL.test(value);
}

export function isHttpsUrl(value: string): boolean {
  if (value.length > LIMITS.url) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !!u.hostname && u.hostname.includes('.') && !u.username && !u.password;
  } catch {
    return false;
  }
}

export interface ValidateOptions {
  /** The current instant; events must end after it. */
  now: Date;
  /** Admins can save events that have already ended (for corrections). */
  allowPast?: boolean;
}

export type EventValidation = { ok: true; record: EventRecord } | { ok: false; errors: FieldErrors };

export function validateEvent(v: EventFormValues, options: ValidateOptions): EventValidation {
  const errors: FieldErrors = {};
  const tooLong = (field: string, label: string, value: string, max: number) => {
    if (value.length > max) errors[field] = `${label} must be ${max} characters or fewer`;
  };

  if (!v.title) errors.title = 'Enter the name of the event';
  tooLong('title', 'The name', v.title, LIMITS.title);
  if (!v.summary) errors.summary = 'Enter a short summary of the event';
  tooLong('summary', 'The summary', v.summary, LIMITS.summary);
  tooLong('description', 'The description', v.description, LIMITS.description);
  if (!(LANGUAGES as readonly string[]).includes(v.lang)) errors.lang = 'Choose the language the event is in';
  if (!v.organiser) errors.organiser = 'Enter who is running the event';
  tooLong('organiser', 'The organiser', v.organiser, LIMITS.organiser);
  if (!v.url) errors.url = 'Enter the address of the event website';
  else if (!isHttpsUrl(v.url)) errors.url = 'Enter the website address in full, starting with https://';

  // When
  const allDay = v.timing === 'all_day';
  if (v.timing !== 'timed' && v.timing !== 'all_day')
    errors.timing = 'Choose whether the event has start and end times';
  if (!v.start_date) errors.start_date = 'Enter the date of the event';
  else if (!isIsoDate(v.start_date)) errors.start_date = 'Enter the start date as a real date';
  const endDate = v.end_date || v.start_date;
  if (v.end_date && !isIsoDate(v.end_date)) errors.end_date = 'Enter the end date as a real date';
  else if (isIsoDate(v.start_date) && isIsoDate(endDate) && endDate < v.start_date) {
    errors.end_date = 'The end date must be the same as or after the start date';
  }
  if (!v.timezone) errors.timezone = 'Choose the time zone the event is in';
  else if (!isValidTimeZone(v.timezone)) errors.timezone = 'Choose a time zone from the list';

  let startsAt: string | null = null;
  let endsAt: string | null = null;
  let startDate: string | null = null;
  let endDateExclusive: string | null = null;
  const datesOk = !errors.start_date && !errors.end_date && !errors.timezone && !errors.timing;

  if (v.timing === 'timed') {
    if (!v.start_time) errors.start_time = 'Enter the time the event starts';
    else if (!TIME.test(v.start_time)) errors.start_time = 'Enter the start time using the 24-hour clock, like 18:30';
    if (!v.end_time) errors.end_time = 'Enter the time the event ends';
    else if (!TIME.test(v.end_time)) errors.end_time = 'Enter the end time using the 24-hour clock, like 20:00';
    if (datesOk && !errors.start_time && !errors.end_time) {
      const s = zonedTimeToUtc(v.start_date, v.start_time, v.timezone);
      const e = zonedTimeToUtc(endDate, v.end_time, v.timezone);
      if (!s.ok)
        errors.start_time = 'That time does not exist on that day, because the clocks change. Choose another time';
      if (!e.ok)
        errors.end_time = 'That time does not exist on that day, because the clocks change. Choose another time';
      if (s.ok && e.ok) {
        if (e.instant <= s.instant) errors.end_time = 'The event must end after it starts';
        else {
          startsAt = s.instant;
          endsAt = e.instant;
        }
      }
    }
  } else if (allDay && datesOk) {
    startDate = v.start_date;
    endDateExclusive = addDays(endDate, 1);
  }

  if (!options.allowPast && !errors.start_date && !errors.end_date) {
    const ends = endsAt ?? (endDateExclusive && datesOk ? zonedTimeToUtc(endDateExclusive, '00:00', v.timezone) : null);
    const endMs = typeof ends === 'string' ? Date.parse(ends) : ends && ends.ok ? Date.parse(ends.instant) : null;
    if (endMs !== null && endMs <= options.now.getTime()) {
      errors[allDay ? 'end_date' : 'end_time'] =
        'The event has already ended. You can only add events that have not ended';
    }
  }

  // What kind of event
  const types = EVENT_TYPES.filter((t) => v.types.includes(t));
  if (v.types.some((t) => !(EVENT_TYPES as readonly string[]).includes(t))) errors.type = 'Choose types from the list';
  else if (!types.length) errors.type = 'Choose at least one type of event';

  // Where
  if (!(FORMATS as readonly string[]).includes(v.format)) errors.format = 'Choose how people can attend';
  const online = v.format === 'online';
  if (!online && v.format) {
    if (!v.country) errors.country = 'Choose the country the event is in';
    else if (!isCountryCode(v.country)) errors.country = 'Choose a country from the list';
    if (!v.city) errors.city = 'Enter the town or city';
  }
  tooLong('city', 'The town or city', v.city, LIMITS.city);
  tooLong('venue', 'The venue', v.venue, LIMITS.venue);

  if (!(PRICES as readonly string[]).includes(v.price)) errors.price = 'Choose whether the event is free or paid';
  const access = new Set<AccessProvision>();
  for (const a of v.access) {
    if ((ACCESS_PROVISIONS as readonly string[]).includes(a)) access.add(a as AccessProvision);
    else errors.access = 'Choose access provisions from the list';
  }
  tooLong('access_notes', 'Access details', v.access_notes, LIMITS.accessNotes);

  // Call for speakers (optional)
  if (v.cfp_url) {
    if (v.cfp_url.length > LIMITS.cfpUrl) errors.cfp_url = 'The link must be 500 characters or fewer';
    else if (!isHttpsUrl(v.cfp_url)) errors.cfp_url = 'Enter the link in full, starting with https://';
  }
  if (v.cfp_closes_on) {
    if (!v.cfp_url) errors.cfp_closes_on = 'Add the link to apply, or remove the date';
    else if (!isIsoDate(v.cfp_closes_on)) errors.cfp_closes_on = 'Enter the last day as a real date';
    else if (isIsoDate(v.start_date) && v.cfp_closes_on > v.start_date)
      errors.cfp_closes_on = 'The last day to apply must be on or before the day the event starts';
    else if (!options.allowPast && isValidTimeZone(v.timezone) && v.cfp_closes_on < todayIn(v.timezone, options.now))
      errors.cfp_closes_on = 'That call for speakers has already closed';
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    record: {
      title: v.title,
      summary: v.summary,
      description: v.description || null,
      lang: v.lang,
      organiser: v.organiser,
      url: new URL(v.url).href,
      all_day: allDay,
      starts_at: startsAt,
      ends_at: endsAt,
      start_date: startDate,
      end_date: endDateExclusive,
      timezone: v.timezone,
      format: v.format as Format,
      types,
      country_code: online ? null : v.country,
      city: online ? null : v.city || null,
      venue: online ? null : v.venue || null,
      price: v.price as Price,
      captions: access.has('captions'),
      sign_language: access.has('sign_language'),
      step_free: access.has('step_free'),
      quiet_room: access.has('quiet_room'),
      hearing_loop: access.has('hearing_loop'),
      remote_attendance: access.has('remote_attendance'),
      access_notes: v.access_notes || null,
      cfp_url: v.cfp_url || null,
      cfp_closes_on: v.cfp_url && v.cfp_closes_on ? v.cfp_closes_on : null,
    },
  };
}

/** Today's date in a time zone, as YYYY-MM-DD. */
function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function validateSubmitter(s: SubmitterValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!s.email) errors.submitter_email = 'Enter your email address';
  else if (!isEmail(s.email))
    errors.submitter_email = 'Enter an email address in the right format, like name@example.com';
  if (s.name.length > LIMITS.name) errors.submitter_name = `Your name must be ${LIMITS.name} characters or fewer`;
  return errors;
}

export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return base || 'event';
}

/** A slug that's readable and unique enough: "lisbon-meetup-k3x9q2". */
export function newSlug(title: string, random: () => string): string {
  return `${slugify(title)}-${random()}`;
}

/** Turns a stored event back into form values (for the admin edit form). */
export function recordToForm(e: EventRecord & { local_end_date?: string }): EventFormValues {
  const timeIn = (instant: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: e.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(instant));
  const dateIn = (instant: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: e.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(instant));
  return {
    title: e.title,
    summary: e.summary,
    description: e.description ?? '',
    lang: e.lang,
    organiser: e.organiser ?? '',
    url: e.url ?? '',
    timing: e.all_day ? 'all_day' : 'timed',
    start_date: e.all_day ? (e.start_date ?? '') : e.starts_at ? dateIn(e.starts_at) : '',
    start_time: !e.all_day && e.starts_at ? timeIn(e.starts_at) : '',
    end_date: e.all_day ? (e.end_date ? addDays(e.end_date, -1) : '') : e.ends_at ? dateIn(e.ends_at) : '',
    end_time: !e.all_day && e.ends_at ? timeIn(e.ends_at) : '',
    timezone: e.timezone,
    format: e.format,
    types: [...(e.types ?? [])],
    country: e.country_code ?? '',
    city: e.city ?? '',
    venue: e.venue ?? '',
    price: e.price,
    access: ACCESS_PROVISIONS.filter((a) => e[a]),
    access_notes: e.access_notes ?? '',
    cfp_url: e.cfp_url ?? '',
    cfp_closes_on: e.cfp_closes_on ?? '',
  };
}
