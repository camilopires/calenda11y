import type { APIRoute } from 'astro';
import type { EmailOtpType } from '@supabase/supabase-js';
import { authClient, safeNext } from '../../../lib/admin/auth';

const OTP_TYPES = new Set<EmailOtpType>(['magiclink', 'email']);

/** Where sign-in links land. Handles both PKCE codes and token hashes. */
export const GET: APIRoute = async (ctx) => {
  const next = safeNext(ctx.url.searchParams.get('next'));
  const client = authClient(ctx);
  const code = ctx.url.searchParams.get('code');
  const tokenHash = ctx.url.searchParams.get('token_hash');
  const type = ctx.url.searchParams.get('type') as EmailOtpType | null;

  let ok = false;
  if (code) {
    ok = !(await client.auth.exchangeCodeForSession(code)).error;
  } else if (tokenHash && type && OTP_TYPES.has(type)) {
    ok = !(await client.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  }
  return ctx.redirect(ok ? next : `/admin/login?error=link&next=${encodeURIComponent(next)}`, 303);
};
