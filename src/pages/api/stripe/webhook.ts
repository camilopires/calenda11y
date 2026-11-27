import type { APIRoute } from 'astro';
import { env } from '../../../lib/env';
import { payments, verifyStripeWebhook } from '../../../lib/services/payments';
import { clearSponsorCache } from '../../../lib/sponsors/public';
import { applyPlan, planFromSession, planFromSubscription } from '../../../lib/sponsors/sync';

const SESSION_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
]);
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

/**
 * Stripe webhooks. Events can repeat and arrive out of order, so each one
 * only says *which* object changed: we fetch its current state from Stripe
 * and save that, in one transaction with the event id (see apply_stripe_sync).
 * If anything fails we answer 500 and Stripe tries again.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe webhook] STRIPE_WEBHOOK_SECRET is not set; refusing the request');
    return new Response('Webhook not configured', { status: 503 });
  }
  const raw = await request.text();
  let event;
  try {
    event = verifyStripeWebhook(raw, request.headers.get('stripe-signature'), secret);
  } catch (error) {
    console.warn('[stripe webhook] bad signature', error instanceof Error ? error.message : error);
    return new Response('Bad signature', { status: 400 });
  }

  const object = event.data.object as { id?: string };
  try {
    let outcome: string = 'ignored';
    // The time is taken after fetching, so whichever request saw the later
    // state at Stripe also has the later timestamp, and wins.
    if (SESSION_EVENTS.has(event.type) && object.id) {
      const session = await payments().retrieveSession(object.id);
      outcome = await applyPlan(planFromSession(session, new Date()), event);
    } else if (SUBSCRIPTION_EVENTS.has(event.type) && object.id) {
      const subscription = await payments().retrieveSubscription(object.id);
      outcome = await applyPlan(planFromSubscription(subscription, new Date()), event);
    }
    if (outcome === 'applied') clearSponsorCache();
    return new Response(JSON.stringify({ outcome }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error(`[stripe webhook] failed to handle ${event.type} ${event.id}`, error);
    return new Response('Could not process the event', { status: 500 });
  }
};
