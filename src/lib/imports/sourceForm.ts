/** Validating the admin form for adding or editing an import source. */
import type { FieldErrors } from '../forms/errors.ts';
import { isCountryCode } from '../events/predicates.ts';
import { isValidTimeZone } from '../events/tz.ts';
import { LANGUAGES } from '../forms/event.ts';
import { FetchBlocked, checkUrl } from './fetch.ts';
import type { SourceConfig, SourceType } from './types.ts';

export const SOURCE_TYPES: Record<SourceType, { label: string; hint: string }> = {
  ics: {
    label: 'iCalendar feed (.ics)',
    hint: 'Most calendars, including public Meetup groups and Luma calendars, publish one.',
  },
  rss: { label: 'RSS feed with event dates', hint: 'Only feeds that use RSS event dates (ev:startdate).' },
  luma: { label: 'Luma calendar', hint: 'Its iCalendar address, or the API if LUMA_API_KEY is set (needs Luma Plus).' },
  eventbrite: {
    label: 'Eventbrite organisation',
    hint: 'Needs the organisation id and a token that can read its events.',
  },
  meetup: { label: 'Meetup search', hint: 'Needs Meetup API access (usually Meetup Pro) and an OAuth refresh token.' },
};

export interface SourceFormValues {
  name: string;
  type: string;
  enabled: boolean;
  url: string;
  default_timezone: string;
  default_country: string;
  lang: string;
  organisation_id: string;
  token: string;
  query: string;
  refresh_token: string;
}

export function readSourceForm(form: FormData): SourceFormValues {
  const s = (k: string) => String(form.get(k) ?? '').trim();
  return {
    name: s('name'),
    type: s('type'),
    enabled: form.get('enabled') === 'on',
    url: s('url'),
    default_timezone: s('default_timezone'),
    default_country: s('default_country').toUpperCase(),
    lang: s('lang') || 'en',
    organisation_id: s('organisation_id'),
    token: s('token'),
    query: s('query'),
    refresh_token: s('refresh_token'),
  };
}

export type SourceValidation =
  | { ok: true; name: string; type: SourceType; enabled: boolean; config: SourceConfig }
  | { ok: false; errors: FieldErrors };

/**
 * Checks the form. Secrets left blank keep their saved value (`existing`),
 * so an admin never has to see or retype them.
 */
export function validateSource(v: SourceFormValues, existing: SourceConfig = {}): SourceValidation {
  const errors: FieldErrors = {};
  if (!v.name) errors.name = 'Enter a name for this source';
  else if (v.name.length > 200) errors.name = 'The name must be 200 characters or fewer';
  if (!(v.type in SOURCE_TYPES)) errors.type = 'Choose the kind of source';
  const type = v.type as SourceType;

  if (type === 'ics' || type === 'rss' || (type === 'luma' && v.url)) {
    if (!v.url) errors.url = 'Enter the feed address';
    else {
      try {
        checkUrl(v.url);
      } catch (e) {
        errors.url =
          e instanceof FetchBlocked ? `${e.message}. Enter a public https address` : 'Enter a valid https address';
      }
    }
  }
  if (type === 'eventbrite') {
    if (!/^\d{1,20}$/.test(v.organisation_id)) errors.organisation_id = 'Enter the organisation id (a number)';
    if (!v.token && !existing.token) errors.token = 'Enter an Eventbrite token';
  }
  if (type === 'meetup' && !v.refresh_token && !existing.refresh_token && !existing.access_token) {
    errors.refresh_token = 'Enter a Meetup OAuth refresh token';
  }
  if (v.default_timezone && !isValidTimeZone(v.default_timezone))
    errors.default_timezone = 'Choose a time zone from the list';
  if (v.default_country && !isCountryCode(v.default_country)) errors.default_country = 'Choose a country from the list';
  if (!(LANGUAGES as readonly string[]).includes(v.lang)) errors.lang = 'Choose a language from the list';
  if (Object.keys(errors).length) return { ok: false, errors };

  const config: SourceConfig = {
    ...(v.url && { url: new URL(v.url).href }),
    ...(v.default_timezone && { default_timezone: v.default_timezone }),
    ...(v.default_country && { default_country: v.default_country }),
    lang: v.lang,
    ...(type === 'eventbrite' && { organisation_id: v.organisation_id, token: v.token || existing.token }),
    ...(type === 'meetup' && {
      query: v.query || 'accessibility',
      ...(v.refresh_token
        ? { refresh_token: v.refresh_token }
        : existing.refresh_token
          ? { refresh_token: existing.refresh_token }
          : {}),
      ...(existing.access_token && !v.refresh_token
        ? { access_token: existing.access_token, access_token_expires_at: existing.access_token_expires_at }
        : {}),
    }),
  };
  return { ok: true, name: v.name, type, enabled: v.enabled, config };
}

export function configToForm(name: string, type: SourceType, enabled: boolean, c: SourceConfig): SourceFormValues {
  return {
    name,
    type,
    enabled,
    url: c.url ?? '',
    default_timezone: c.default_timezone ?? '',
    default_country: c.default_country ?? '',
    lang: c.lang ?? 'en',
    organisation_id: c.organisation_id ?? '',
    token: '',
    query: c.query ?? '',
    refresh_token: '',
  };
}
