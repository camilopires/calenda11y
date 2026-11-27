import type { APIRoute } from 'astro';
import { env } from '../../../lib/env';
import { fakeState, type CheckoutSession, type Subscription } from '../../../lib/services/payments';

/** Test-only: read and change the fake Stripe's objects (APP_ENV=test). */
export const POST: APIRoute = async ({ request }) => {
  if (env().APP_ENV !== 'test') return new Response(null, { status: 404 });
  const body = (await request.json()) as {
    session?: Partial<CheckoutSession> & { id: string };
    subscription?: Subscription;
  };
  const st = fakeState();
  if (body.session)
    st.sessions.set(body.session.id, {
      ...(st.sessions.get(body.session.id) as CheckoutSession & { url: string }),
      ...body.session,
    });
  if (body.subscription) st.subscriptions.set(body.subscription.id, body.subscription);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};

export const GET: APIRoute = ({ url }) => {
  if (env().APP_ENV !== 'test') return new Response(null, { status: 404 });
  const st = fakeState();
  const id = url.searchParams.get('session') ?? '';
  return new Response(JSON.stringify(st.sessions.get(id) ?? null), { headers: { 'Content-Type': 'application/json' } });
};
