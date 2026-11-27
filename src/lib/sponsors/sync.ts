/**
 * Turning Stripe objects into sponsor records.
 *
 * Webhook events arrive in any order and can repeat, so we never use the
 * event's own copy of an object: the caller fetches the current version
 * from Stripe, and this works out what to save from that. The database
 * function apply_stripe_sync then saves it in one transaction.
 */
import { randomToken, sha256 } from '../security/tokens.ts';
import { db } from '../db.ts';
import { env } from '../env.ts';
import { queued, sendNow } from '../email/outbox.ts';
import { sponsorWelcome } from '../email/templates.ts';
import { ServiceError } from '../result.ts';
import type { CheckoutSession, Subscription } from '../services/payments.ts';
import { DONATION_LISTING_DAYS, fromLookupKey } from './tiers.ts';

/** Subscription statuses that keep a sponsor listed. past_due is a grace period while Stripe retries. */
export const LISTED_STATUSES = new Set(['active', 'trialing', 'past_due']);

export interface SyncPayload {
  customer_id: string;
  email: string | null;
  attempt_id?: string;
  profile_token_hash?: string;
  sponsorship: {
    kind: 'subscription' | 'one_off';
    tier: string;
    interval: string | null;
    subscription_id: string | null;
    session_id: string | null;
    status: string;
    paid: boolean;
    amount_minor: number | null;
    currency: string | null;
    active_until: string | null;
    observed_at: string;
  };
  emails: ReturnType<typeof queued>[];
}

export type Plan =
  { action: 'save'; payload: SyncPayload; profileToken?: string } | { action: 'ignore'; reason: string };

/** What to save for a Checkout session (one-off donations, and the start of subscriptions). */
export function planFromSession(s: CheckoutSession, now: Date): Plan {
  if (!s.customer) return { action: 'ignore', reason: 'The session has no customer yet' };
  if (s.status !== 'complete') return { action: 'ignore', reason: `The session is ${s.status}` };
  const attempt =
    s.client_reference_id && /^[0-9a-f-]{36}$/.test(s.client_reference_id) ? s.client_reference_id : undefined;
  // A delayed payment method can complete Checkout before the money arrives:
  // only a paid session counts.
  const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
  const token = paid ? randomToken() : undefined;
  const profileLink = token ? new URL(`/sponsor/profile?token=${token}`, env().SITE_URL).href : '';
  const emails =
    token && s.customer_email
      ? [
          queued(
            'sponsor_welcome',
            `sponsor:welcome:${s.id}`,
            s.customer_email,
            sponsorWelcome(profileLink, s.mode === 'subscription'),
          ),
        ]
      : [];

  if (s.mode === 'subscription') {
    if (!s.subscription) return { action: 'ignore', reason: 'The session has no subscription' };
    // The subscription's own state comes from its events; this only records
    // the customer, the attempt and the welcome email.
    return {
      action: 'save',
      ...(token && { profileToken: token }),
      payload: {
        customer_id: s.customer,
        email: s.customer_email,
        ...(attempt && { attempt_id: attempt }),
        ...(token && { profile_token_hash: sha256(token) }),
        sponsorship: {
          kind: 'subscription',
          tier: s.metadata.tier ?? 'supporter',
          interval: s.metadata.interval || 'month',
          subscription_id: s.subscription,
          session_id: s.id,
          status: paid ? 'active' : 'incomplete',
          paid,
          amount_minor: s.amount_total,
          currency: s.currency,
          active_until: null,
          // Older than any fetched subscription, so the subscription's own state wins.
          observed_at: new Date(0).toISOString(),
        },
        emails,
      },
    };
  }

  return {
    action: 'save',
    ...(token && { profileToken: token }),
    payload: {
      customer_id: s.customer,
      email: s.customer_email,
      ...(attempt && { attempt_id: attempt }),
      ...(token && { profile_token_hash: sha256(token) }),
      sponsorship: {
        kind: 'one_off',
        tier: 'donation',
        interval: null,
        subscription_id: null,
        session_id: s.id,
        status: s.payment_status,
        paid,
        amount_minor: s.amount_total,
        currency: s.currency,
        active_until: paid ? new Date(now.getTime() + DONATION_LISTING_DAYS * 86_400_000).toISOString() : null,
        observed_at: now.toISOString(),
      },
      emails,
    },
  };
}

/** What to save for a subscription, from its current state at Stripe. */
export function planFromSubscription(sub: Subscription, now: Date): Plan {
  const plan = fromLookupKey(sub.lookup_key);
  if (!plan) return { action: 'ignore', reason: `Unknown price ${sub.lookup_key ?? '(none)'}` };
  return {
    action: 'save',
    payload: {
      customer_id: sub.customer,
      email: null,
      sponsorship: {
        kind: 'subscription',
        tier: plan.tier,
        interval: plan.interval,
        subscription_id: sub.id,
        session_id: null,
        status: sub.status,
        paid: LISTED_STATUSES.has(sub.status),
        amount_minor: sub.amount,
        currency: sub.currency,
        active_until: sub.period_end ? new Date(sub.period_end * 1000).toISOString() : null,
        observed_at: now.toISOString(),
      },
      emails: [],
    },
  };
}

/** Saves a plan. Returns 'duplicate' when this webhook event was already handled. */
export async function applyPlan(
  plan: Plan,
  event?: { id: string; type: string },
): Promise<'applied' | 'duplicate' | 'ignored'> {
  if (plan.action === 'ignore') {
    // Still record the event, so a repeat delivery doesn't do the work again.
    if (event) {
      const r = await db()
        .from('stripe_events')
        .upsert({ event_id: event.id, type: event.type }, { onConflict: 'event_id', ignoreDuplicates: true })
        .select('event_id');
      if (r.error)
        throw new ServiceError('supabase', `recording ignored Stripe event: ${r.error.message}`, r.error.code);
    }
    return 'ignored';
  }
  const { data, error } = await db().rpc('apply_stripe_sync', {
    p_event_id: event?.id ?? null,
    p_event_type: event?.type ?? 'sync',
    p: plan.payload,
  });
  if (error) throw new ServiceError('supabase', `saving Stripe state: ${error.message}`, error.code);
  if (data === 'applied' && plan.payload.emails.length) {
    try {
      await sendNow('sponsor:welcome:');
    } catch (err) {
      console.error('[sponsors] sending welcome email now failed; it will be retried', err);
    }
  }
  return data as 'applied' | 'duplicate';
}
