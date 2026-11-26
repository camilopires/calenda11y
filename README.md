# calenda11y

An accessibility events calendar for the world. Find accessibility conferences, meetups and workshops, filter them by country, add them to your calendar, or get them by email.

The site is built to meet [WCAG 2.2](https://www.w3.org/TR/WCAG22/) at level AAA. See [the accessibility statement](src/pages/accessibility.astro) for what that covers and how it's tested.

## Stack

- [Astro](https://astro.build) 7, server-rendered, deployed on Vercel
- [Supabase](https://supabase.com): Postgres, Auth (admin magic links), Storage (sponsor logos), pg_cron + pg_net (the scheduler)
- [Stripe](https://stripe.com) Checkout for sponsorships
- [Resend](https://resend.com) for email
- [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) for spam protection

Pages are plain HTML and CSS. JavaScript only adds optional extras, and every feature works without it.

## Local development

Needs Node 24 (see `.nvmrc`), pnpm and Docker.

```sh
nvm use
pnpm install
pnpm exec supabase start      # local Postgres, Auth and Storage in Docker
pnpm env:local                # writes the local Supabase URL and keys into .env
pnpm exec supabase db reset   # apply migrations and seed data
pnpm dev                      # http://localhost:4321
```

## Tests

| Command                                                 | What it runs                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm test`                                             | Unit tests (Vitest)                                                                  |
| `pnpm test:integration`                                 | Database tests against the local Supabase: row-level security, grants, functions     |
| `ADAPTER=node APP_ENV=test pnpm build && pnpm test:e2e` | End-to-end tests (Playwright) with axe, HTML validation and CSP checks on every page |
| `pnpm test:stripe-contract`                             | Checks the real Stripe test-mode setup (needs `STRIPE_SECRET_KEY` set to a test key) |
| `pnpm lint`, `pnpm check`                               | ESLint (including jsx-a11y) and TypeScript                                           |

## Licence

Code: [MIT](LICENSE). Event data: [CC BY 4.0](DATA-LICENSE).
