import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { ensureLocalSupabaseEnv } from './scripts/local-supabase.ts';

// End-to-end tests run against the local Supabase stack.
ensureLocalSupabaseEnv();

// Webhook signing secrets for this test run only, generated fresh each time
// (never committed). Tests sign their requests with the same values.
process.env.E2E_STRIPE_WEBHOOK_SECRET ??= `whsec_${randomBytes(24).toString('base64')}`;
process.env.E2E_RESEND_WEBHOOK_SECRET ??= `whsec_${randomBytes(24).toString('base64')}`;

const PORT = Number(process.env.E2E_PORT ?? 4322);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    deviceScaleFactor: 1,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } }],
  webServer: {
    // Run `ADAPTER=node APP_ENV=test pnpm build` first.
    command: 'node dist/server/entry.mjs',
    url: `http://127.0.0.1:${PORT}/settings`,
    reuseExistingServer: !process.env.CI,
    env: {
      APP_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      SITE_URL: `http://127.0.0.1:${PORT}`,
      SUPABASE_URL: process.env.SUPABASE_URL!,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      STRIPE_WEBHOOK_SECRET: process.env.E2E_STRIPE_WEBHOOK_SECRET,
      RESEND_WEBHOOK_SECRET: process.env.E2E_RESEND_WEBHOOK_SECRET,
    },
    timeout: 30_000,
  },
});
