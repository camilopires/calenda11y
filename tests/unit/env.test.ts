import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../../src/lib/env.ts';

const PRODUCTION = {
  APP_ENV: 'production',
  SITE_URL: 'https://calenda11y.org',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  APP_SECRET: 'a'.repeat(32),
  CRON_SECRET: 'c'.repeat(32),
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  RESEND_API_KEY: 're_x',
  RESEND_WEBHOOK_SECRET: 'whsec_y',
  EMAIL_FROM: 'calenda11y <hello@calenda11y.org>',
  TURNSTILE_SITE_KEY: 'site',
  TURNSTILE_SECRET_KEY: 'secret',
};

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

describe('parseEnv on Vercel', () => {
  // Every Vercel deploy, previews included, must use production settings.
  it.each([
    ['no APP_ENV', { VERCEL: '1' }],
    [
      'APP_ENV=development',
      { VERCEL: '1', APP_ENV: 'development', APP_SECRET: 'a'.repeat(32), CRON_SECRET: 'c'.repeat(32) },
    ],
    ['APP_ENV=test', { VERCEL: '1', APP_ENV: 'test' }],
    ['a full set marked development', { ...PRODUCTION, VERCEL: '1', APP_ENV: 'development' }],
  ])('refuses %s', (_label, source) => {
    expect(() => parseEnv(source)).toThrow(EnvError);
  });

  it('refuses a production set missing only CRON_SECRET', () => {
    expect(() => parseEnv({ ...PRODUCTION, VERCEL: '1', CRON_SECRET: undefined })).toThrow(/CRON_SECRET/);
  });

  it('refuses blank values', () => {
    expect(() => parseEnv({ ...PRODUCTION, VERCEL: '1', APP_SECRET: '' })).toThrow(/APP_SECRET/);
  });

  it('accepts a full production set', () => {
    expect(parseEnv({ ...PRODUCTION, VERCEL: '1' }).APP_ENV).toBe('production');
  });

  it('leaves local development alone without VERCEL', () => {
    expect(parseEnv({ VERCEL: '0' }).APP_ENV).toBe('development');
    expect(parseEnv({}).APP_ENV).toBe('development');
  });
});
