/** Security headers added to every response by the middleware. */
export function securityHeaders(isProduction: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (isProduction) headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains; preload';
  return headers;
}

/**
 * Adds directives that must be sent as a header (frame-ancestors is ignored in
 * a <meta> CSP) to the policy Astro generated for the page, if any.
 */
export function withHeaderOnlyCsp(existing: string | null): string {
  const extra = "frame-ancestors 'none'";
  if (!existing) return extra;
  return `${existing.trim().replace(/;?$/, ';')} ${extra}`;
}
