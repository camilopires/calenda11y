/** Whether a change should reach a subscriber, by their choices. Mirrors the digest's conditions. */
import type { Preferences } from '../digest/subscribers.ts';
import type { PublicEvent } from '../events/model.ts';
import { hasNetChange, type MergedChange } from './changes.ts';

export type AlertPrefs = Pick<Preferences, 'countries' | 'formats' | 'types' | 'topics' | 'include_cfp'>;

export function matchesPrefs(e: PublicEvent, p: AlertPrefs): boolean {
  if (p.formats.length && !p.formats.includes(e.format)) return false;
  if (p.types.length && !p.types.some((t) => e.types.includes(t))) return false;
  if (p.topics.length && !p.topics.some((t) => e.topics.includes(t))) return false;
  const countries = p.countries.filter((c) => c !== 'online');
  const online = p.countries.includes('online');
  if (!countries.length && !online) return true;
  return (
    (countries.length > 0 && !!e.country_code && countries.includes(e.country_code)) ||
    (online && (e.format === 'online' || e.format === 'hybrid'))
  );
}

/**
 * Whether this person should hear about this change: the event matches
 * their choices, hasn't ended, and something is left to say. A change only
 * to the call for speakers goes only to people who asked for calls.
 */
export function wantsChange(e: PublicEvent, m: MergedChange, p: AlertPrefs, now: Date): boolean {
  if (Date.parse(e.end_instant) <= now.getTime()) return false;
  if (!matchesPrefs(e, p) || !hasNetChange(e, m)) return false;
  const onlyCfp = !m.isNew && m.what.size === 1 && m.what.has('cfp') && m.statusBefore === e.status;
  return !onlyCfp || p.include_cfp;
}
