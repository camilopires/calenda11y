/**
 * Stripe, behind a small interface. Tests (APP_ENV=test) use an in-process
 * fake with the same shapes, including a stand-in for the hosted Checkout
 * page. Webhook signatures are always checked with Stripe's own code.
 */
import Stripe from 'stripe';
import { env, requireEnv } from '../env.ts';
import { DONATION_LOOKUP_KEY, lookupKey, type Interval, type Tier } from '../sponsors/tiers.ts';

export interface CheckoutSession {
  id: string;
  mode: 'payment' | 'subscription';
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  customer: string | null;
  customer_email: string | null;
  subscription: string | null;
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
}

export interface Subscription {
  id: string;
  status: string;
  customer: string;
  lookup_key: string | null;
  period_end: number | null;
  amount: number | null;
  currency: string | null;
}

export interface CheckoutRequest {
  attemptId: string;
  /** null for a one-off donation. */
  plan: { tier: Tier; interval: Interval } | null;
  successUrl: string;
  cancelUrl: string;
}

export interface Payments {
  createCheckout(r: CheckoutRequest): Promise<{ id: string; url: string }>;
  retrieveSession(id: string): Promise<CheckoutSession>;
  retrieveSubscription(id: string): Promise<Subscription>;
  createPortal(customerId: string, returnUrl: string): Promise<string>;
}

const asId = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null));

class StripePayments implements Payments {
  readonly #stripe: Stripe;
  #prices = new Map<string, string>();
  constructor(key: string) {
    this.#stripe = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'calenda11y' } });
  }

  async #priceId(key: string): Promise<string> {
    const cached = this.#prices.get(key);
    if (cached) return cached;
    const list = await this.#stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    const id = list.data[0]?.id;
    if (!id) throw new Error(`Stripe has no active price with lookup key ${key}. Run scripts/stripe-setup.ts`);
    this.#prices.set(key, id);
    return id;
  }

  async createCheckout(r: CheckoutRequest) {
    const metadata = { attempt_id: r.attemptId, tier: r.plan?.tier ?? 'donation', interval: r.plan?.interval ?? '' };
    const common = {
      client_reference_id: r.attemptId,
      metadata,
      success_url: r.successUrl,
      cancel_url: r.cancelUrl,
      billing_address_collection: 'auto' as const,
    };
    const session = r.plan
      ? await this.#stripe.checkout.sessions.create({
          ...common,
          mode: 'subscription',
          line_items: [{ price: await this.#priceId(lookupKey(r.plan.tier, r.plan.interval)), quantity: 1 }],
          subscription_data: { metadata },
        })
      : await this.#stripe.checkout.sessions.create({
          ...common,
          mode: 'payment',
          line_items: [{ price: await this.#priceId(DONATION_LOOKUP_KEY), quantity: 1 }],
          customer_creation: 'always',
          invoice_creation: { enabled: true },
        });
    if (!session.url) throw new Error('Stripe did not return a Checkout address');
    return { id: session.id, url: session.url };
  }

  async retrieveSession(id: string): Promise<CheckoutSession> {
    const s = await this.#stripe.checkout.sessions.retrieve(id);
    return {
      id: s.id,
      mode: s.mode === 'subscription' ? 'subscription' : 'payment',
      status: (s.status ?? 'open') as CheckoutSession['status'],
      // Unknown future values are treated as not paid.
      payment_status: (['paid', 'unpaid', 'no_payment_required'].includes(s.payment_status)
        ? s.payment_status
        : 'unpaid') as CheckoutSession['payment_status'],
      customer: asId(s.customer as string | { id: string } | null),
      customer_email: s.customer_details?.email ?? s.customer_email ?? null,
      subscription: asId(s.subscription as string | { id: string } | null),
      amount_total: s.amount_total,
      currency: s.currency,
      client_reference_id: s.client_reference_id,
      metadata: (s.metadata ?? {}) as Record<string, string>,
    };
  }

  async retrieveSubscription(id: string): Promise<Subscription> {
    const s = await this.#stripe.subscriptions.retrieve(id);
    const item = s.items.data[0];
    return {
      id: s.id,
      status: s.status,
      customer: asId(s.customer as string | { id: string })!,
      lookup_key: item?.price.lookup_key ?? null,
      period_end: item?.current_period_end ?? null,
      amount: item?.price.unit_amount ?? null,
      currency: item?.price.currency ?? null,
    };
  }

  async createPortal(customerId: string, returnUrl: string) {
    const p = await this.#stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return p.url;
  }
}

// ---------------------------------------------------------------------------
// Test fake
// ---------------------------------------------------------------------------

/** Shared state for the fake, kept on globalThis so test-only routes can change it. */
export interface FakeStripeState {
  sessions: Map<string, CheckoutSession & { url: string }>;
  subscriptions: Map<string, Subscription>;
  counter: number;
}

export function fakeState(): FakeStripeState {
  const g = globalThis as { __fakeStripe?: FakeStripeState };
  g.__fakeStripe ??= { sessions: new Map(), subscriptions: new Map(), counter: 0 };
  return g.__fakeStripe;
}

class FakePayments implements Payments {
  async createCheckout(r: CheckoutRequest) {
    const st = fakeState();
    const n = ++st.counter;
    const id = `cs_test_fake${Date.now()}${n}`;
    const session = {
      id,
      mode: r.plan ? ('subscription' as const) : ('payment' as const),
      status: 'open' as const,
      payment_status: 'unpaid' as const,
      customer: null,
      customer_email: null,
      subscription: null,
      amount_total: null,
      currency: 'gbp',
      client_reference_id: r.attemptId,
      metadata: {
        attempt_id: r.attemptId,
        tier: r.plan?.tier ?? 'donation',
        interval: r.plan?.interval ?? '',
        success_url: r.successUrl,
      },
      url: `/sponsor/test-checkout?session=${id}`,
    };
    st.sessions.set(id, session);
    return { id, url: session.url };
  }
  async retrieveSession(id: string) {
    const s = fakeState().sessions.get(id);
    if (!s) throw new Error(`No such checkout session: ${id}`);
    return s;
  }
  async retrieveSubscription(id: string) {
    const s = fakeState().subscriptions.get(id);
    if (!s) throw new Error(`No such subscription: ${id}`);
    return s;
  }
  async createPortal(customerId: string) {
    return `/sponsor/test-portal?customer=${customerId}`;
  }
}

let instance: Payments | undefined;

/** Tests, and local development without a Stripe key, use the stand-in. */
export function usesFakePayments(): boolean {
  const e = env();
  return e.APP_ENV === 'test' || (e.APP_ENV === 'development' && !e.STRIPE_SECRET_KEY);
}

export function payments(): Payments {
  instance ??= usesFakePayments()
    ? new FakePayments()
    : new StripePayments(requireEnv('STRIPE_SECRET_KEY', 'Add a Stripe secret key (a test key while developing).'));
  return instance;
}

/** Checks a webhook's signature with Stripe's own code. Throws if it doesn't match. */
export function verifyStripeWebhook(rawBody: string, signature: string | null, secret: string): Stripe.Event {
  if (!signature) throw new Error('Missing Stripe-Signature header');
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}
