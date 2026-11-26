import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../../src/lib/env.ts';

describe('parseEnv', () => {
  it('fills local defaults in development', () => {
    const e = parseEnv({});
    expect(e.APP_ENV).toBe('development');
    expect(e.SUPABASE_URL).toBe('http://127.0.0.1:54321');
  });

  it('treats empty strings as unset', () => {
    expect(parseEnv({ SITE_URL: '' }).SITE_URL).toBe('http://localhost:4321');
  });

  it('requires every production variable', () => {
    expect(() => parseEnv({ APP_ENV: 'production' })).toThrow(EnvError);
    try {
      parseEnv({ APP_ENV: 'production' });
    } catch (e) {
      expect((e as EnvError).issues.some((i) => i.startsWith('STRIPE_SECRET_KEY'))).toBe(true);
    }
  });

  it('rejects short secrets', () => {
    expect(() => parseEnv({ APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
  });
});
