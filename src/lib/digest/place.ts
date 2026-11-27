/**
 * The place on the email sign-up and manage forms: a typed (or edited)
 * place is looked up before saving, shared by both pages. One match is
 * used; several ask "Which Medway?" on the same form (the other choices
 * are kept, as they're all in the form); none is an error on the field.
 */
import { lookupPlace } from '../geo/lookup.ts';
import { formatAt } from '../geo/place.ts';
import { unitFor } from '../geo/distance.ts';
import type { FieldErrors } from '../forms/errors.ts';
import { validatePreferences, type PreferenceValues } from './form.ts';
import type { Preferences } from './subscribers.ts';

export type Settled =
  | { kind: 'ok'; prefs: Preferences; values: PreferenceValues }
  | { kind: 'errors'; errors: FieldErrors; values: PreferenceValues }
  | { kind: 'choose'; choices: Array<{ value: string; label: string }>; values: PreferenceValues };

export async function settlePlace(v: PreferenceValues, ip: string): Promise<Settled> {
  const r = validatePreferences(v);
  if (!r.ok) return { kind: 'errors', errors: r.errors, values: v };
  if (!r.lookup) return { kind: 'ok', prefs: r.prefs, values: v };
  const found = await lookupPlace(r.lookup, { ip });
  if (!found.ok) {
    return {
      kind: 'errors',
      values: v,
      errors: {
        near:
          found.reason === 'busy'
            ? 'Too many place searches right now. Try again in a moment.'
            : found.reason === 'off'
              ? 'Place search is not available right now. Leave "Near" blank, or try again later.'
              : "We couldn't look up places just now. Try again later.",
      },
    };
  }
  if (!found.places.length) {
    return { kind: 'errors', values: v, errors: { near: "We couldn't find that place. Try a town or city name" } };
  }
  const asValues = (p: (typeof found.places)[number]): PreferenceValues => ({
    ...v,
    near: p.label,
    nearFrom: p.label,
    nearAt: formatAt(p),
    nearUnit: unitFor(p.countryCode),
    nearPick: '',
  });
  if (found.places.length === 1) {
    const values = asValues(found.places[0]!);
    const again = validatePreferences(values);
    return again.ok ? { kind: 'ok', prefs: again.prefs, values } : { kind: 'errors', errors: again.errors, values };
  }
  return {
    kind: 'choose',
    values: v,
    choices: found.places.map((p) => ({
      value: `${formatAt(p)}|${unitFor(p.countryCode)}|${p.label}`,
      label: p.label,
    })),
  };
}
