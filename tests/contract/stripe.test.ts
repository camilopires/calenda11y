// Checks the real Stripe test-mode setup. Runs only with a test key:
//   STRIPE_SECRET_KEY=sk_test_... pnpm test:stripe-contract
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
  CURRENCY,
  DONATION_LOOKUP_KEY,
  DONATION_MINIMUM,
  TIERS,
  lookupKey,
  price,
  type Interval,
  type Tier,
} from '../../src/lib/sponsors/tiers.ts';

const key = process.env.STRIPE_SECRET_KEY;
const run = key?.startsWith('sk_test_') ? describe : describe.skip;

run('Stripe test mode', () => {
  const stripe = new Stripe(key ?? 'sk_test_unused');

  for (const tier of Object.keys(TIERS) as Tier[]) {
    for (const interval of ['month', 'year'] as Interval[]) {
      it(`${lookupKey(tier, interval)} is ${price(tier, interval)} ${CURRENCY} per ${interval}`, async () => {
        const [p] = (await stripe.prices.list({ lookup_keys: [lookupKey(tier, interval)], active: true })).data;
        expect(p).toBeDefined();
        expect(p!.unit_amount).toBe(price(tier, interval));
        expect(p!.currency).toBe(CURRENCY);
        expect(p!.recurring?.interval).toBe(interval);
      });
    }
  }

  it('the donation price lets people choose an amount, from £1', async () => {
    const [p] = (await stripe.prices.list({ lookup_keys: [DONATION_LOOKUP_KEY], active: true })).data;
    expect(p!.custom_unit_amount).toMatchObject({ minimum: DONATION_MINIMUM });
    expect(p!.recurring).toBeNull();
  });

  it('creates Checkout sessions for a subscription and a donation', async () => {
    const [sub] = (await stripe.prices.list({ lookup_keys: [lookupKey('bronze', 'month')] })).data;
    const s = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: sub!.id, quantity: 1 }],
      success_url: 'https://calenda11y.org/sponsor/thanks?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://calenda11y.org/sponsor',
      client_reference_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(s.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [don] = (await stripe.prices.list({ lookup_keys: [DONATION_LOOKUP_KEY] })).data;
    const d = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: don!.id, quantity: 1 }],
      customer_creation: 'always',
      success_url: 'https://calenda11y.org/sponsor/thanks?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://calenda11y.org/sponsor',
    });
    expect(d.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });
});
