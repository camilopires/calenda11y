# calenda11y

An accessibility events calendar for the world. Find accessibility conferences, meetups and workshops, filter them by country, add them to your calendar, or get them by email.

The site is built to meet [WCAG 2.2](https://www.w3.org/TR/WCAG22/) at level AAA. [`tests/a11y/wcag22-aaa-matrix.md`](tests/a11y/wcag22-aaa-matrix.md) shows how each success criterion is met and tested.

## What it does

- **Events list and month view.** Filter by country (or "online"), format, dates, price, access provisions and search. Filters are a plain HTML form, so they work without JavaScript and every result has a shareable address.
- **Calendar integrations.** Every event has an `.ics` download plus Google Calendar and Outlook links. Anyone can subscribe to a feed for all events, one country, or any set of filters (`webcal://`), or follow an RSS feed.
- **Email digest.** Weekly or monthly, with double opt-in and one-click unsubscribe (RFC 8058).
- **Adding events.** A public form with a check-your-answers step, plus imports from iCalendar, RSS, Luma, Eventbrite and Meetup. A person checks everything before it's published.
- **Sponsorship.** Monthly and yearly tiers and one-off donations through Stripe Checkout. Sponsors appear on the sponsor page once a person approves their profile.

## Stack

- [Astro](https://astro.build) 7, server-rendered, on Vercel. CI and end-to-end tests use the Node adapter.
- [Supabase](https://supabase.com): Postgres, Auth (admin magic links), Storage (sponsor logos), pg_cron and pg_net (the scheduler).
- [Stripe](https://stripe.com) Checkout and the customer portal.
- [Resend](https://resend.com) for email.
- [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) against spam.

## Local development

You need Node 24 (see `.nvmrc`), pnpm and Docker.

```sh
nvm use
pnpm install
pnpm exec supabase start      # local Postgres, Auth and Storage in Docker
pnpm env:local                # writes the local Supabase URL and keys into .env
pnpm exec supabase db reset   # applies migrations and seed data
pnpm dev                      # http://localhost:4321
```

Without Stripe, Resend or Turnstile keys, the app uses stand-ins. Emails are written to `.test-outbox/` and also go to Supabase's local Mailpit at http://127.0.0.1:54324.

To make yourself an admin, sign up through Supabase (or create a user in Studio), then add their id:

```sql
insert into admins (user_id) select id from auth.users where email = 'you@example.org';
```

## Tests

| Command                                                 | What it runs                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm test`                                             | Unit tests (Vitest)                                                                            |
| `pnpm test:integration`                                 | Database tests against local Supabase: access rules, constraints, imports, digest, Stripe sync |
| `ADAPTER=node APP_ENV=test pnpm build && pnpm test:e2e` | End-to-end tests (Playwright), with axe, HTML validation and CSP checks on every page          |
| `SMOKE_URL=https://… pnpm test:smoke`                   | Checks a real deployment: headers, CSP, caching, endpoint security, test pages hidden          |
| `STRIPE_SECRET_KEY=sk_test_… pnpm test:stripe-contract` | Checks the Stripe test-mode products and prices                                                |
| `pnpm lint`, `pnpm check`                               | ESLint (with jsx-a11y) and TypeScript                                                          |

There's also a manual checklist for screen reader testing before each release: [`tests/a11y/manual-checklist.md`](tests/a11y/manual-checklist.md).

## Deploying

### 1. Supabase

1. Create a project. Link it and push the schema:
   ```sh
   pnpm exec supabase link --project-ref <ref>
   pnpm exec supabase db push
   ```
2. **Auth → URL configuration.** Set the site URL to `https://calenda11y.org`, and add `https://calenda11y.org/admin/auth/callback` to the redirect URLs. Turn off sign-ups: admins are added by hand.
3. **Auth → SMTP.** Send through Resend, so sign-in emails come from your domain.
4. **Scheduled jobs.** In the SQL editor, store two secrets, then run [`supabase/cron.sql`](supabase/cron.sql):
   ```sql
   select vault.create_secret('https://calenda11y.org', 'calenda11y_site_url');
   select vault.create_secret('<CRON_SECRET>', 'calenda11y_cron_secret');
   ```
   pg_cron then calls `/api/cron/tick` every 10 minutes. That runs imports (each source every 6 hours), sends queued emails, sends the digests and cleans up old data. **Admin → Scheduled jobs** shows what ran, and every admin page warns you if the scheduler stops.

### 2. Stripe

1. Create the products and prices (safe to run again):
   ```sh
   STRIPE_SECRET_KEY=sk_test_… pnpm stripe:setup
   ```
2. Add a webhook endpoint at `https://calenda11y.org/api/stripe/webhook` for these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused` and `customer.subscription.resumed`.
3. Turn on the customer portal, with cancelling and invoice history.
4. Under subscription retries, set Stripe to cancel a subscription after its last failed retry. A `past_due` sponsor stays listed during retries.
5. When it all works in test mode, do the same with live keys.

### 3. Resend

Verify the sending domain. DKIM must sign the `List-Unsubscribe` and `List-Unsubscribe-Post` headers, which Resend does by default. Add a webhook at `https://calenda11y.org/api/resend/webhook` for `email.bounced` and `email.complained`.

### 4. Vercel

Use **Vercel Pro**: the free Hobby plan is for non-commercial use only, and this site takes sponsorship payments. Import the repository, then set the environment variables from [`.env.example`](.env.example), with `APP_ENV=production`. Every variable is required in production, and the build fails if one is missing.

| Variable                                                         | Where it comes from                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| `SITE_URL`                                                       | `https://calenda11y.org`                              |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project settings → API                       |
| `APP_SECRET`, `CRON_SECRET`                                      | `openssl rand -base64 48`, a different value for each |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                     | Stripe dashboard                                      |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`          | Resend dashboard                                      |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`                     | Cloudflare Turnstile (managed mode)                   |
| `LUMA_API_KEY`, `MEETUP_CLIENT_ID`, `MEETUP_CLIENT_SECRET`       | Optional, for those imports                           |

After deploying, run the smoke checks against the deployment: `SMOKE_URL=https://calenda11y.org pnpm test:smoke`.

### Import sources

Add sources in **Admin → Import sources**.

- **iCalendar** works for most calendars, including public Meetup groups and Luma calendars.
- **Eventbrite** only reads organisations whose token you have.
- **Meetup search** needs Meetup to grant API access (usually through Meetup Pro).
- **The Luma API** needs Luma Plus.

## Licence

Code: [MIT](LICENSE). Event data: [CC BY 4.0](DATA-LICENSE).
