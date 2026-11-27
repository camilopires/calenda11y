/**
 * Converting a wall-clock time in an IANA time zone to a UTC instant, using
 * only Intl (no time zone database dependency).
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!/^([A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}|UTC)$/.test(timeZone)) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC, in minutes, at a given instant. */
export function offsetMinutes(instantMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(instantMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
}

export type ZonedResult =
  | { ok: true; instant: string }
  /** The time is skipped when clocks go forward (e.g. 02:30 on the spring change). */
  | { ok: false; reason: 'nonexistent' };

/**
 * Converts `date` (YYYY-MM-DD) and `time` (HH:MM or HH:MM:SS) in `timeZone` to a UTC
 * ISO instant. When clocks go back and a time happens twice, the earlier
 * one is used. A time that doesn't exist (clocks going forward) is reported,
 * not silently moved.
 */
export function zonedTimeToUtc(
  date: string,
  time: string,
  timeZone: string,
  /** Which of two possible instants to use when clocks go back. PostgreSQL uses the later one. */
  repeated: 'earlier' | 'later' = 'earlier',
): ZonedResult {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi, sec = 0] = time.split(':').map(Number) as [number, number, number?];
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec);
  // Candidate instants for each offset in effect around that wall time.
  const offsets = new Set([offsetMinutes(wall - 86_400_000, timeZone), offsetMinutes(wall + 86_400_000, timeZone)]);
  const matches: number[] = [];
  for (const off of offsets) {
    const candidate = wall - off * 60_000;
    if (offsetMinutes(candidate, timeZone) === off) matches.push(candidate);
  }
  if (matches.length === 0) return { ok: false, reason: 'nonexistent' };
  const pick = repeated === 'later' ? Math.max(...matches) : Math.min(...matches);
  return { ok: true, instant: new Date(pick).toISOString() };
}

/** All IANA time zones the runtime knows, plus UTC. */
export function timeZones(): string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}
