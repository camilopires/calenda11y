/** Rate limits, counted atomically in the database (see hit_rate_limit). */
import { db } from '../db.ts';
import { env } from '../env.ts';
import { unwrap } from '../result.ts';
import { hmac } from './tokens.ts';

export interface Limit {
  name: string;
  limit: number;
  windowSeconds: number;
}

export const LIMITS = {
  submitPerIp: { name: 'submit-ip', limit: 10, windowSeconds: 3600 },
  submitUnverifiedPerIp: { name: 'submit-unverified-ip', limit: 3, windowSeconds: 3600 },
  reportPerIp: { name: 'report-ip', limit: 10, windowSeconds: 3600 },
  subscribePerIp: { name: 'subscribe-ip', limit: 10, windowSeconds: 3600 },
  emailPerRecipient: { name: 'email-recipient', limit: 3, windowSeconds: 86_400 },
  adminLoginPerIp: { name: 'admin-login-ip', limit: 10, windowSeconds: 3600 },
  adminDraftPerIp: { name: 'admin-draft-ip', limit: 20, windowSeconds: 3600 },
  checkoutPerIp: { name: 'checkout-ip', limit: 20, windowSeconds: 3600 },
} as const satisfies Record<string, Limit>;

/**
 * The client's IP, from headers the hosting platform sets (never from ones a
 * client could add itself). In tests, a header lets each test use its own IP.
 */
export function clientIp(request: Request, clientAddress: string | undefined): string {
  if (env().APP_ENV === 'test') {
    const testIp = request.headers.get('x-test-client-ip');
    if (testIp) return testIp;
  }
  const vercel = request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-real-ip');
  if (vercel) return vercel.split(',')[0]!.trim();
  return clientAddress ?? 'unknown';
}

/** Returns true if this hit is within the limit. The key is hashed, so IPs and emails aren't stored. */
export async function allow(limit: Limit, key: string): Promise<boolean> {
  const bucket = `${limit.name}:${hmac('ratelimit', key)}`;
  return unwrap(
    await db().rpc('hit_rate_limit', { p_bucket: bucket, p_limit: limit.limit, p_window_seconds: limit.windowSeconds }),
    'supabase',
    'rate limit',
  ) as boolean;
}
