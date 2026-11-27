// Creates calenda11y's products and prices in Stripe. Safe to run again:
// prices are found by lookup key and only created if missing.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.ts
import Stripe from 'stripe';
import {
  CURRENCY,
  DONATION_LOOKUP_KEY,
  DONATION_MINIMUM,
  TIERS,
  lookupKey,
  price,
  type Interval,
  type Tier,
} from '../src/lib/sponsors/tiers.ts';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Set STRIPE_SECRET_KEY (use a test key first).');
  process.exit(1);
}
const stripe = new Stripe(key);

async function product(name: string, id: string): Promise<string> {
  try {
    return (await stripe.products.retrieve(id)).id;
  } catch {
    return (await stripe.products.create({ id, name, tax_code: 'txcd_90000001' })).id;
  }
}

async function ensurePrice(lookup: string, create: () => Promise<Stripe.Price>): Promise<void> {
  const existing = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 });
  if (existing.data[0]) {
    console.log(`  ${lookup}: exists (${existing.data[0].id})`);
    return;
  }
  const p = await create();
  console.log(`  ${lookup}: created (${p.id})`);
}

for (const tier of Object.keys(TIERS) as Tier[]) {
  const productId = await product(`calenda11y ${TIERS[tier].name} sponsor`, `c11y_${tier}`);
  for (const interval of ['month', 'year'] as Interval[]) {
    await ensurePrice(lookupKey(tier, interval), () =>
      stripe.prices.create({
        product: productId,
        currency: CURRENCY,
        unit_amount: price(tier, interval),
        recurring: { interval },
        lookup_key: lookupKey(tier, interval),
        nickname: `${TIERS[tier].name} (${interval}ly)`,
      }),
    );
  }
}

const donation = await product('calenda11y donation', 'c11y_donation');
await ensurePrice(DONATION_LOOKUP_KEY, () =>
  stripe.prices.create({
    product: donation,
    currency: CURRENCY,
    custom_unit_amount: { enabled: true, minimum: DONATION_MINIMUM, preset: 1500 },
    lookup_key: DONATION_LOOKUP_KEY,
    nickname: 'One-off donation (any amount)',
  }),
);
console.log('Done. Next: add a webhook endpoint for /api/stripe/webhook with the events listed in the README.');
