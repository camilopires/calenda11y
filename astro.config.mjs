// @ts-check
import { existsSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';

// Make .env available to server code through process.env in dev and build.
if (existsSync('.env')) process.loadEnvFile('.env');

// Production runs on Vercel. CI and end-to-end tests use the Node adapter,
// because the Vercel adapter doesn't support `astro preview`.
const adapter = process.env.ADAPTER === 'node' ? node({ mode: 'standalone' }) : vercel({ maxDuration: 60 });

const storageOrigin = (() => {
  try {
    return new URL(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321').origin;
  } catch {
    return 'http://127.0.0.1:54321';
  }
})();

export default defineConfig({
  site: process.env.SITE_URL ?? 'http://localhost:4321',
  output: 'server',
  adapter,
  trailingSlash: 'never',
  build: { inlineStylesheets: 'never' },
  devToolbar: { enabled: false },
  markdown: { syntaxHighlight: false },
  security: {
    // Replaced by our own Origin check in src/lib/security/csrf.ts, because
    // webhooks, the cron tick and RFC 8058 one-click unsubscribe must accept
    // cross-origin POSTs that authenticate themselves.
    checkOrigin: false,
    csp: {
      directives: [
        "default-src 'self'",
        `img-src 'self' data: ${storageOrigin}`,
        "font-src 'self'",
        "connect-src 'self'",
        'frame-src https://challenges.cloudflare.com',
        "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
        "base-uri 'self'",
        "object-src 'none'",
      ],
      scriptDirective: {
        resources: ["'self'", 'https://challenges.cloudflare.com'],
      },
    },
  },
});
