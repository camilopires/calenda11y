import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { env, sponsorshipOpen } from '../../../lib/env';
import { unwrap } from '../../../lib/result';
import { LIMITS, allow, clientIp } from '../../../lib/security/ratelimit';
import { randomToken, sha256 } from '../../../lib/security/tokens';
import { payments } from '../../../lib/services/payments';
import { isTier, type Interval, type Tier } from '../../../lib/sponsors/tiers';

export const ATTEMPT_COOKIE = 'sponsor_attempt';

/** Starts Stripe Checkout for a tier (monthly or yearly) or a one-off donation. */
export const POST: APIRoute = async ({ request, cookies, clientAddress, redirect }) => {
  if (!sponsorshipOpen()) return new Response(null, { status: 404 });
  const form = await request.formData();
  const tier = String(form.get('tier') ?? '');
  const interval = String(form.get('interval') ?? 'month');
  const donation = tier === 'donation';
  if (!donation && (!isTier(tier) || (interval !== 'month' && interval !== 'year'))) {
    return redirect('/sponsor?error=choice', 303);
  }
  if (!(await allow(LIMITS.checkoutPerIp, clientIp(request, clientAddress))))
    return redirect('/sponsor?error=busy', 303);

  // A secret in a cookie ties the Checkout session to this browser.
  const secret = randomToken();
  const attempt = unwrap(
    await db()
      .from('sponsorship_attempts')
      .insert({
        browser_secret_hash: sha256(secret),
        tier: donation ? 'donation' : tier,
        billing_interval: donation ? null : interval,
      })
      .select('id')
      .single(),
    'supabase',
    'starting sponsorship',
  ) as { id: string };

  const site = env().SITE_URL;
  const session = await payments().createCheckout({
    attemptId: attempt.id,
    plan: donation ? null : { tier: tier as Tier, interval: interval as Interval },
    successUrl: `${site}/sponsor/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${site}/sponsor?cancelled=1`,
  });
  unwrap(
    await db()
      .from('sponsorship_attempts')
      .update({ checkout_session_id: session.id })
      .eq('id', attempt.id)
      .select('id'),
    'supabase',
    'saving checkout session',
  );
  cookies.set(ATTEMPT_COOKIE, `${attempt.id}.${secret}`, {
    path: '/sponsor',
    httpOnly: true,
    sameSite: 'lax',
    secure: env().APP_ENV === 'production',
    maxAge: 86_400,
  });
  return redirect(session.url, 303);
};
