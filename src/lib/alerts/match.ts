/** Whether a change should reach a subscriber, by their choices. Mirrors the digest's conditions. */
import type { Preferences } from '../digest/subscribers.ts';
import type { PublicEvent } from '../events/model.ts';
import { hasNetChange, type MergedChange } from './changes.ts';
import { withinNear } from '../geo/distance.ts';

export type AlertPrefs = Pick<Preferences, 'countries' | 'formats' | 'types' | 'topics' | 'include_cfp' | 'near'>;

export function matchesPrefs(e: PublicEvent, p: AlertPrefs): boolean {
  if (p.formats.length && !p.formats.includes(e.format)) return false;
  if (p.types.length && !p.types.some((t) => e.types.includes(t))) return false;
  if (p.topics.length && !p.topics.some((t) => e.topics.includes(t))) return false;
  if (p.near && !withinNear(e, p.near)) return false;
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

/**
 * For someone with a place: whether this event can't be judged yet. Its
 * position is still being looked up, or it has moved since the change being
 * described (so its current position doesn't belong to that change). Their
 * alerts wait just before it until the next round, instead of skipping it.
 * A position that couldn't be found doesn't hold anything up: that event is
 * simply not near.
 */
export function cannotJudgeYet(current: PublicEvent, asOf: PublicEvent): boolean {
  if (current.format === 'online') return false;
  if (current.geo_status === 'pending') return true;
  return (
    current.format !== asOf.format ||
    current.venue !== asOf.venue ||
    current.city !== asOf.city ||
    current.country_code !== asOf.country_code
  );
}
