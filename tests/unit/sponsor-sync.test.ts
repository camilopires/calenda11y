import { describe, expect, it } from 'vitest';
import { planFromSession, planFromSubscription } from '../../src/lib/sponsors/sync.ts';
import { fromLookupKey, formatPounds, price } from '../../src/lib/sponsors/tiers.ts';
import type { CheckoutSession } from '../../src/lib/services/payments.ts';

const NOW = new Date('2027-01-10T12:00:00Z');
const session = (o: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 'cs_test_1',
  mode: 'payment',
  status: 'complete',
  payment_status: 'paid',
  customer: 'cus_1',
  customer_email: 'giver@example.org',
  subscription: null,
  amount_total: 1500,
  currency: 'gbp',
  client_reference_id: '6f1c2b3a-1234-4abc-9def-0123456789ab',
  metadata: { tier: 'donation' },
  ...o,
});

describe('tiers', () => {
  it('prices yearly at 10 × monthly', () => {
    expect(price('bronze', 'month')).toBe(2500);
    expect(price('bronze', 'year')).toBe(25000);
    expect(formatPounds(25000)).toBe('£250');
    expect(formatPounds(1550)).toBe('£15.50');
  });
  it('reads lookup keys', () => {
    expect(fromLookupKey('c11y_gold_year')).toEqual({ tier: 'gold', interval: 'year' });
    expect(fromLookupKey('other')).toBeNull();
  });
});

describe('planFromSession', () => {
  it('lists a paid donation for 12 months and sends a profile link', () => {
    const p = planFromSession(session(), NOW);
    expect(p.action).toBe('save');
    if (p.action !== 'save') return;
    expect(p.payload.sponsorship).toMatchObject({
      kind: 'one_off',
      paid: true,
      amount_minor: 1500,
      active_until: '2028-01-10T12:00:00.000Z',
    });
    expect(p.payload.attempt_id).toBe('6f1c2b3a-1234-4abc-9def-0123456789ab');
    expect(p.profileToken).toBeTruthy();
    expect(p.payload.profile_token_hash).toHaveLength(64);
    expect(p.payload.emails).toHaveLength(1);
    expect(p.payload.emails[0]!.text_body).toContain(`/sponsor/profile?token=${p.profileToken}`);
  });

  it('does not list a completed but unpaid session (a delayed payment)', () => {
    const p = planFromSession(session({ payment_status: 'unpaid' }), NOW);
    expect(p.action === 'save' && p.payload.sponsorship).toMatchObject({ paid: false, active_until: null });
    expect(p.action === 'save' && p.payload.emails).toEqual([]);
    expect(p.action === 'save' && p.payload.profile_token_hash).toBeUndefined();
  });

  it('ignores open sessions and sessions with no customer', () => {
    expect(planFromSession(session({ status: 'open' }), NOW).action).toBe('ignore');
    expect(planFromSession(session({ customer: null }), NOW).action).toBe('ignore');
  });

  it("leaves a subscription's state to the subscription", () => {
    const p = planFromSession(
      session({ mode: 'subscription', subscription: 'sub_1', metadata: { tier: 'gold', interval: 'year' } }),
      NOW,
    );
    expect(p.action === 'save' && p.payload.sponsorship).toMatchObject({
      kind: 'subscription',
      tier: 'gold',
      interval: 'year',
      observed_at: new Date(0).toISOString(),
    });
  });
});

describe('planFromSubscription', () => {
  const sub = {
    id: 'sub_1',
    customer: 'cus_1',
    lookup_key: 'c11y_silver_month',
    period_end: 1_800_000_000,
    amount: 10000,
    currency: 'gbp',
  };
  it.each([
    ['active', true],
    ['trialing', true],
    ['past_due', true],
    ['incomplete', false],
    ['incomplete_expired', false],
    ['unpaid', false],
    ['canceled', false],
    ['paused', false],
  ])('%s → listed: %s', (status, listed) => {
    const p = planFromSubscription({ ...sub, status }, NOW);
    expect(p.action === 'save' && p.payload.sponsorship.paid).toBe(listed);
  });

  it('ignores prices it does not know', () => {
    expect(planFromSubscription({ ...sub, status: 'active', lookup_key: 'something_else' }, NOW).action).toBe('ignore');
  });
});
