import { z } from 'zod';

/**
 * Every environment variable the app reads, checked in one place.
 *
 * In production every variable is required. In development and test, local
 * defaults are used for anything that has a sensible local value (the local
 * Supabase stack, fake third-party services), so the app runs out of the box.
 */

export const APP_ENVS = ['development', 'test', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
// These are the well-known demo keys that every local `supabase start` uses.
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const LOCAL_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const DEV_SECRET = 'dev-only-secret-change-me-dev-only-secret';

const secret = z.string().min(32, 'must be at least 32 characters');

const productionSchema = z.object({
  APP_ENV: z.literal('production'),
  SITE_URL: z.url(),
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  APP_SECRET: secret,
  CRON_SECRET: secret,
  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  RESEND_API_KEY: z.string().startsWith('re_'),
  RESEND_WEBHOOK_SECRET: z.string().min(1),
  EMAIL_FROM: z.string().min(3),
  TURNSTILE_SITE_KEY: z.string().min(1),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  LUMA_API_KEY: z.string().optional(),
  MEETUP_CLIENT_ID: z.string().optional(),
  MEETUP_CLIENT_SECRET: z.string().optional(),
});

const localSchema = z.object({
  APP_ENV: z.enum(['development', 'test']).default('development'),
  SITE_URL: z.url().default('http://localhost:4321'),
  SUPABASE_URL: z.url().default(LOCAL_SUPABASE_URL),
  SUPABASE_ANON_KEY: z.string().default(LOCAL_ANON_KEY),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(LOCAL_SERVICE_KEY),
  APP_SECRET: secret.default(DEV_SECRET),
  CRON_SECRET: secret.default(DEV_SECRET),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_test_secret'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().default('whsec_dGVzdC1yZXNlbmQtc2VjcmV0'),
  EMAIL_FROM: z.string().default('calenda11y <hello@calenda11y.org>'),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  LUMA_API_KEY: z.string().optional(),
  MEETUP_CLIENT_ID: z.string().optional(),
  MEETUP_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof productionSchema> | z.infer<typeof localSchema>;

export class EnvError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

type Source = Record<string, string | undefined>;

export function parseEnv(source: Source): Env {
  // Treat empty strings as unset so a blank line in .env doesn't count as a value.
  const cleaned: Source = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const schema = cleaned.APP_ENV === 'production' ? productionSchema : localSchema;
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return result.data;
}

let cached: Env | undefined;

/** The validated environment. Throws EnvError on first use if it's invalid. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Only for tests. */
export function resetEnvCache(): void {
  cached = undefined;
}
