import { afterAll, describe, expect, it } from 'vitest';
import { applyPlan, planFromSession, planFromSubscription } from '../../src/lib/sponsors/sync.ts';
import type { CheckoutSession, Subscription } from '../../src/lib/services/payments.ts';
import { rest, service } from './helpers.ts';

const db = service();
const tag = `${Date.now()}`;
const customers: string[] = [];

afterAll(async () => {
  if (customers.length) await db.from('sponsors').delete().in('stripe_customer_id', customers);
  await db.from('stripe_events').delete().like('event_id', `evt_test${tag}%`);
});

const customer = (n: number) => {
  const id = `cus_t${tag}${n}`;
  customers.push(id);
  return id;
};
const evt = (n: number, type = 'customer.subscription.updated') => ({ id: `evt_test${tag}${n}`, type });

const sub = (o: Partial<Subscription> & { customer: string }): Subscription => ({
  id: `sub_t${tag}${o.customer.slice(-2)}`,
  status: 'active',
  lookup_key: 'c11y_bronze_month',
  period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
  amount: 2500,
  currency: 'gbp',
  ...o,
});

async function sponsorshipOf(cust: string) {
  const { data } = await db
    .from('sponsors')
    .select('id, sponsorships(stripe_status, tier, paid, active_until, kind)')
    .eq('stripe_customer_id', cust)
    .single();
  return data!;
}

describe('apply_stripe_sync', () => {
  it('handles each webhook event once, even when delivered twice at the same time', async () => {
    const c = customer(1);
    const plan = planFromSubscription(sub({ customer: c }), new Date());
    const results = await Promise.all([applyPlan(plan, evt(1)), applyPlan(plan, evt(1))]);
    expect(results.sort()).toEqual(['applied', 'duplicate']);
    expect((await sponsorshipOf(c)).sponsorships).toHaveLength(1);
  });

  it('never lets an older snapshot overwrite a newer one (events out of order)', async () => {
    const c = customer(2);
    const s = sub({ customer: c });
    // Deleted arrives (and is fetched) first...
    await applyPlan(planFromSubscription({ ...s, status: 'canceled' }, new Date('2027-01-02T00:00:00Z')), evt(2));
    // ...then an older "updated" snapshot shows up late.
    await applyPlan(planFromSubscription({ ...s, status: 'active' }, new Date('2027-01-01T00:00:00Z')), evt(3));
    const [row] = (await sponsorshipOf(c)).sponsorships;
    expect(row).toMatchObject({ stripe_status: 'canceled', paid: false });
  });

  it('a Checkout completion does not overwrite the subscription state', async () => {
    const c = customer(3);
    const s = sub({ customer: c, status: 'past_due' });
    await applyPlan(planFromSubscription(s, new Date()), evt(4));
    const session: CheckoutSession = {
      id: `cs_t${tag}3`,
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      customer: c,
      customer_email: `s3-${tag}@example.test`,
      subscription: s.id,
      amount_total: 2500,
      currency: 'gbp',
      client_reference_id: null,
      metadata: { tier: 'bronze', interval: 'month' },
    };
    await applyPlan(planFromSession(session, new Date()), evt(5, 'checkout.session.completed'));
    const row = await sponsorshipOf(c);
    expect(row.sponsorships[0]).toMatchObject({ stripe_status: 'past_due' });
    const { data } = await db.from('sponsors').select('contact_email').eq('stripe_customer_id', c).single();
    expect(data!.contact_email).toBe(`s3-${tag}@example.test`);
    const { data: mail } = await db
      .from('email_outbox')
      .select('subject')
      .eq('dedupe_key', `sponsor:welcome:${session.id}`);
    expect(mail).toEqual([{ subject: 'Thank you for sponsoring calenda11y' }]);
  });

  it('a one-off donation keeps its first 12 months even if repeated later', async () => {
    const c = customer(4);
    const session: CheckoutSession = {
      id: `cs_t${tag}4`,
      mode: 'payment',
      status: 'complete',
      payment_status: 'paid',
      customer: c,
      customer_email: null,
      subscription: null,
      amount_total: 1000,
      currency: 'gbp',
      client_reference_id: null,
      metadata: {},
    };
    await applyPlan(planFromSession(session, new Date('2027-01-01T00:00:00Z')));
    await applyPlan(planFromSession(session, new Date('2027-06-01T00:00:00Z')));
    const [row] = (await sponsorshipOf(c)).sponsorships;
    expect(row!.active_until).toBe('2028-01-01T00:00:00+00:00');
  });
});

describe('public_sponsors', () => {
  it('lists only approved profiles with a sponsorship that counts, at their best tier', async () => {
    const active = customer(5);
    const cancelled = customer(6);
    await applyPlan(planFromSubscription(sub({ customer: active, lookup_key: 'c11y_gold_year' }), new Date()));
    await applyPlan(planFromSubscription(sub({ customer: cancelled, status: 'canceled' }), new Date()));
    await db
      .from('sponsors')
      .update({ approved_name: `Active ${tag}` })
      .eq('stripe_customer_id', active);
    await db
      .from('sponsors')
      .update({ approved_name: `Cancelled ${tag}` })
      .eq('stripe_customer_id', cancelled);
    const { data } = await db.from('public_sponsors').select('name, tier').like('name', `%${tag}`);
    expect(data).toEqual([{ name: `Active ${tag}`, tier: 'gold' }]);
  });

  it('is not readable with the anon key, and nor are payment details', async () => {
    for (const name of [
      'public_sponsors',
      'sponsors',
      'sponsorships',
      'stripe_events',
      'sponsorship_attempts',
      'tokens',
    ]) {
      const res = await rest(`${name}?select=*&limit=1`);
      expect([401, 403, 404], name).toContain(res.status);
    }
  });

  it('does not expose payment ids through the view', async () => {
    const { error } = await db.from('public_sponsors').select('stripe_customer_id').limit(1);
    expect(error?.message).toMatch(/does not exist/);
  });
});
