import type { APIRoute } from 'astro';
import { env } from '../../../lib/env';
import { payments } from '../../../lib/services/payments';
import { getSponsor, redeem } from '../../../lib/sponsors/profile';

/** Opens the Stripe customer portal from a one-time link we emailed. */
export const GET: APIRoute = async ({ url, redirect }) => {
  const sponsorId = await redeem('sponsor_portal', url.searchParams.get('token') ?? '');
  const sponsor = sponsorId ? await getSponsor(sponsorId) : null;
  if (!sponsor) return redirect('/sponsor/manage?expired=1', 303);
  return redirect(await payments().createPortal(sponsor.stripe_customer_id, `${env().SITE_URL}/sponsor`), 303);
};
