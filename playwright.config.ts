import { defineConfig, devices } from '@playwright/test';
import { ensureLocalSupabaseEnv } from './scripts/local-supabase.ts';

// End-to-end tests run against the local Supabase stack.
ensureLocalSupabaseEnv();

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
    },
    timeout: 30_000,
  },
});
