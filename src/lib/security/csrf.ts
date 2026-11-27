/**
 * Cross-site request forgery protection: every state-changing request must
 * come from our own origin. Endpoints that authenticate themselves another
 * way (signatures, bearer secrets, single-use tokens) are exempt, because
 * their callers (Stripe, Resend, pg_cron, mail clients doing RFC 8058
 * one-click unsubscribe) never send our Origin.
 */

export const CSRF_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  '/api/stripe/webhook',
  '/api/resend/webhook',
  '/api/cron/tick',
  '/api/unsubscribe',
  // Test-only (404 outside APP_ENV=test): lets tests set up the fake Stripe.
  '/api/test/stripe',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfResult = { ok: true } | { ok: false; reason: string };

export function checkCsrf(request: Request, allowedOrigins: readonly string[]): CsrfResult {
  if (SAFE_METHODS.has(request.method)) return { ok: true };
  const url = new URL(request.url);
  if (CSRF_EXEMPT_PATHS.has(url.pathname)) return { ok: true };

  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') {
    return allowedOrigins.includes(origin) ? { ok: true } : { ok: false, reason: `Origin ${origin} is not allowed` };
  }
  // Some privacy tools strip Origin; fall back to Referer.
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      return allowedOrigins.includes(refOrigin)
        ? { ok: true }
        : { ok: false, reason: `Referer origin ${refOrigin} is not allowed` };
    } catch {
      return { ok: false, reason: 'Referer is not a valid URL' };
    }
  }
  return { ok: false, reason: 'Missing Origin and Referer headers' };
}
