import type { AstroCookies } from 'astro';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, sessionSponsor, startSession } from '../../src/lib/sponsors/profile.ts';
import { hmac } from '../../src/lib/security/tokens.ts';

/** Just enough of AstroCookies for the session helpers. */
function jar(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(SESSION_COOKIE, initial);
  return {
    store,
    cookies: {
      get: (name: string) => (store.has(name) ? { value: store.get(name)! } : undefined),
      set: (name: string, value: string) => store.set(name, value),
    } as unknown as AstroCookies,
  };
}

const ID = '0b6f1a52-2f7e-4a8e-9a3b-1d2c3e4f5a6b';

describe('sponsor sessions', () => {
  it('carry the session version, and read it back', () => {
    const j = jar();
    startSession(j.cookies, ID, 3);
    expect(sessionSponsor(jar(j.store.get(SESSION_COOKIE)).cookies)).toEqual({ id: ID, version: 3 });
  });

  it('refuse a changed version', () => {
    const j = jar();
    startSession(j.cookies, ID, 3);
    const tampered = j.store.get(SESSION_COOKIE)!.replace(`${ID}.3.`, `${ID}.4.`);
    expect(sessionSponsor(jar(tampered).cookies)).toBeNull();
  });

  it('refuse the old cookie without a version', () => {
    const exp = Date.now() + 86_400_000;
    const old = `${ID}.${exp}.${hmac('sponsor-session', `${ID}:${exp}`)}`;
    expect(sessionSponsor(jar(old).cookies)).toBeNull();
  });

  it('refuse an expired session', () => {
    const exp = Date.now() - 1;
    const sig = hmac('sponsor-session', `${ID}:2:${exp}`);
    expect(sessionSponsor(jar(`${ID}.2.${exp}.${sig}`).cookies)).toBeNull();
  });
});
