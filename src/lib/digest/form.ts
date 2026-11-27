import type { FieldErrors } from '../forms/errors.ts';
import { isEmail } from '../forms/event.ts';
import { FORMATS, type Format } from '../events/model.ts';
import { isCountryCode } from '../events/predicates.ts';
import type { Preferences } from './subscribers.ts';

export interface PreferenceValues {
  cadence: string;
  country: string;
  online: boolean;
  formats: string[];
}

export function readPreferences(form: FormData): PreferenceValues {
  return {
    cadence: String(form.get('cadence') ?? ''),
    country: String(form.get('country') ?? '').toUpperCase(),
    online: form.get('online') === 'on',
    formats: form.getAll('format').map(String),
  };
}

export function preferencesToValues(p: Preferences): PreferenceValues {
  return {
    cadence: p.cadence,
    country: p.countries.find((c) => c !== 'online') ?? '',
    online: p.countries.includes('online'),
    formats: p.formats,
  };
}

export type PreferenceValidation = { ok: true; prefs: Preferences } | { ok: false; errors: FieldErrors };

export function validatePreferences(v: PreferenceValues): PreferenceValidation {
  const errors: FieldErrors = {};
  if (v.cadence !== 'weekly' && v.cadence !== 'monthly') errors.cadence = 'Choose how often you want emails';
  if (v.country && !isCountryCode(v.country)) errors.country = 'Choose a country from the list';
  const formats = [...new Set(v.formats)];
  if (formats.some((f) => !(FORMATS as readonly string[]).includes(f))) errors.format = 'Choose formats from the list';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    prefs: {
      cadence: v.cadence as Preferences['cadence'],
      countries: [...(v.country ? [v.country] : []), ...(v.online ? ['online'] : [])],
      formats: formats as Format[],
    },
  };
}

export function validateSignupEmail(email: string): FieldErrors {
  if (!email) return { email: 'Enter your email address' };
  if (!isEmail(email)) return { email: 'Enter an email address in the right format, like name@example.com' };
  return {};
}
