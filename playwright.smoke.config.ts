import { defineConfig, devices } from '@playwright/test';

// Checks a real deployment (a Vercel preview or production):
//   SMOKE_URL=https://calenda11y-git-branch.vercel.app pnpm test:smoke
const baseURL = process.env.SMOKE_URL;
if (!baseURL) throw new Error('Set SMOKE_URL to the deployment to check');

export default defineConfig({
  testDir: 'tests/smoke',
  retries: 1,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
