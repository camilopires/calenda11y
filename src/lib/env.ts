import { z } from 'zod';

/**
 * Every environment variable the app reads, checked in one place.
 *
 * In production every variable is required. In development and test, local
 * defaults are used where there's a sensible local value, and third-party
 * keys are optional (fake services stand in for them).
 *
 * No key or secret is ever written in this file, not even a local or
 * placeholder one: secret scanners can't tell them apart from real ones.
 * Local Supabase keys come from `pnpm env:local`, which copies them from
 * `supabase status`.
 */

export const APP_ENVS = ['development', 'test', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
// Not a secret: it only signs local development cookies and tokens.
const DEV_SECRET = 'local-development-only-not-for-production';

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
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  APP_SECRET: secret.default(DEV_SECRET),
  CRON_SECRET: secret.default(DEV_SECRET),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
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

/**
 * A value that's optional locally but needed for the feature being used.
 * Throws a message that says how to fix it.
 */
export function requireEnv<K extends keyof Env>(key: K, hint: string): NonNullable<Env[K]> {
  const value = env()[key];
  if (value === undefined || value === null || value === '') {
    throw new EnvError([`${String(key)} is not set. ${hint}`]);
  }
  return value as NonNullable<Env[K]>;
}

/** Only for tests. */
export function resetEnvCache(): void {
  cached = undefined;
}
