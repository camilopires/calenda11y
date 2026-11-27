import type { FieldErrors } from '../forms/errors.ts';
import { isEmail } from '../forms/event.ts';
import {
  EVENT_TOPICS,
  EVENT_TYPES,
  FORMATS,
  TOPIC_SLUGS,
  topicFromSlug,
  type EventType,
  type Format,
} from '../events/model.ts';
import { isCountryCode } from '../events/predicates.ts';
import { RADII, convertRadius, shownUnit, toKm, type Unit } from '../geo/distance.ts';
import { NEAR_MAX, formatAt, parseAt } from '../geo/place.ts';
import { CADENCES, type Preferences } from './subscribers.ts';

export interface PreferenceValues {
  cadence: string;
  country: string;
  online: boolean;
  formats: string[];
  types: string[];
  /** URL names (assistive-technology), as on the event list. */
  topics: string[];
  include_cfp: boolean;
  /**
   * Near a place. Its own field names (near_*), so it never mixes with the
   * "online" box above (online events as well as a country).
   */
  near: string;
  nearFrom: string | null;
  nearAt: string;
  nearUnit: Unit;
  nearWithin: string;
  nearOnline: boolean;
  /** "51.38,0.52|mi|Medway, Kent, United Kingdom", from a "Which Medway?" choice. */
  nearPick: string;
}

export function readPreferences(form: FormData): PreferenceValues {
  return {
    cadence: String(form.get('cadence') ?? ''),
    country: String(form.get('country') ?? '').toUpperCase(),
    online: form.get('online') === 'on',
    formats: form.getAll('format').map(String),
    types: form.getAll('type').map(String),
    topics: form.getAll('topic').map(String),
    include_cfp: form.get('include_cfp') === 'on',
    near: String(form.get('near') ?? '')
      .trim()
      .slice(0, NEAR_MAX),
    nearFrom: form.has('near_from') ? String(form.get('near_from')) : null,
    nearAt: String(form.get('near_at') ?? ''),
    nearUnit: form.get('near_u') === 'mi' ? 'mi' : 'km',
    nearWithin: String(form.get('near_within') ?? ''),
    nearOnline: form.get('near_online') === 'on',
    nearPick: String(form.get('near_pick') ?? ''),
  };
}

export function preferencesToValues(p: Preferences): PreferenceValues {
  return {
    cadence: p.cadence,
    country: p.countries.find((c) => c !== 'online') ?? '',
    online: p.countries.includes('online'),
    formats: p.formats,
    types: p.types,
    topics: p.topics.map((t) => TOPIC_SLUGS[t]),
    include_cfp: p.include_cfp,
    near: p.near?.label ?? '',
    nearFrom: p.near?.label ?? null,
    nearAt: p.near ? formatAt(p.near) : '',
    nearUnit: p.near?.unit ?? 'mi',
    nearWithin: p.near ? String(p.near.radius) : '',
    nearOnline: p.near?.includeOnline ?? false,
    nearPick: '',
  };
}

export type PreferenceValidation =
  | {
      ok: true;
      prefs: Preferences;
      /** A typed (or edited) place to look up before saving. */
      lookup?: string;
    }
  | { ok: false; errors: FieldErrors };

export function validatePreferences(v: PreferenceValues): PreferenceValidation {
  const errors: FieldErrors = {};
  if (!(CADENCES as readonly string[]).includes(v.cadence)) errors.cadence = 'Choose how often you want emails';
  if (v.country && !isCountryCode(v.country)) errors.country = 'Choose a country from the list';
  const formats = [...new Set(v.formats)];
  if (formats.some((f) => !(FORMATS as readonly string[]).includes(f))) errors.format = 'Choose formats from the list';
  if (v.types.some((t) => !(EVENT_TYPES as readonly string[]).includes(t))) errors.type = 'Choose types from the list';
  const types: EventType[] = EVENT_TYPES.filter((t) => v.types.includes(t));
  const chosenTopics = v.topics.map(topicFromSlug);
  if (chosenTopics.includes(null)) errors.topic = 'Choose topics from the list';
  const topics = EVENT_TOPICS.filter((t) => chosenTopics.includes(t));
  // Near a place: a picked choice, a resolved place, or something to look up.
  let near: Preferences['near'] = null;
  let lookup: string | undefined;
  const radius = v.nearWithin === '' ? 25 : Number(v.nearWithin);
  if (v.near || v.nearPick) {
    if (!(RADII as readonly number[]).includes(radius)) errors.near_within = 'Choose a distance from the list';
    const pick = /^([^|]+)\|(mi|km)\|(.+)$/.exec(v.nearPick);
    const pickPos = pick ? parseAt(pick[1]) : null;
    const pos = parseAt(v.nearAt);
    const place =
      pick && pickPos
        ? { ...pickPos, unit: pick[2] as Unit, label: pick[3]!.slice(0, 200) }
        : pos && (v.nearFrom === null || v.nearFrom === v.near)
          ? { ...pos, unit: v.nearUnit, label: v.near }
          : null;
    if (place) {
      // A picked place may be in another unit than "Within" showed.
      const r = pick && pickPos ? convertRadius(radius, shownUnit(!!v.nearAt, v.nearUnit), place.unit) : radius;
      near = { ...place, radius: r, km: toKm(r, place.unit), includeOnline: v.nearOnline };
    } else lookup = v.near;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ...(lookup && { lookup }),
    ok: true,
    prefs: {
      cadence: v.cadence as Preferences['cadence'],
      countries: [...(v.country ? [v.country] : []), ...(v.online ? ['online'] : [])],
      formats: formats as Format[],
      types,
      topics,
      include_cfp: v.include_cfp,
      near,
    },
  };
}

export function validateSignupEmail(email: string): FieldErrors {
  if (!email) return { email: 'Enter your email address' };
  if (!isEmail(email)) return { email: 'Enter an email address in the right format, like name@example.com' };
  return {};
}
