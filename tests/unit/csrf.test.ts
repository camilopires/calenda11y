import { describe, expect, it } from 'vitest';
import { checkCsrf } from '../../src/lib/security/csrf.ts';

const ORIGINS = ['https://calenda11y.org'];
const req = (method: string, path: string, headers: Record<string, string> = {}) =>
  new Request(`https://calenda11y.org${path}`, { method, headers });

describe('checkCsrf', () => {
  it('allows safe methods without headers', () => {
    expect(checkCsrf(req('GET', '/submit'), ORIGINS).ok).toBe(true);
    expect(checkCsrf(req('HEAD', '/'), ORIGINS).ok).toBe(true);
  });

  it('allows same-origin POSTs', () => {
    expect(checkCsrf(req('POST', '/submit', { origin: 'https://calenda11y.org' }), ORIGINS).ok).toBe(true);
  });

  it('rejects cross-origin POSTs', () => {
    const r = checkCsrf(req('POST', '/submit', { origin: 'https://evil.example' }), ORIGINS);
    expect(r).toEqual({ ok: false, reason: 'Origin https://evil.example is not allowed' });
  });

  it('rejects an opaque "null" origin unless the Referer matches', () => {
    expect(checkCsrf(req('POST', '/submit', { origin: 'null' }), ORIGINS).ok).toBe(false);
    expect(
      checkCsrf(req('POST', '/submit', { origin: 'null', referer: 'https://calenda11y.org/submit' }), ORIGINS).ok,
    ).toBe(true);
  });

  it('falls back to Referer when Origin is missing', () => {
    expect(checkCsrf(req('POST', '/submit', { referer: 'https://calenda11y.org/submit' }), ORIGINS).ok).toBe(true);
    expect(checkCsrf(req('POST', '/submit', { referer: 'https://evil.example/x' }), ORIGINS).ok).toBe(false);
    expect(checkCsrf(req('POST', '/submit', { referer: 'not a url' }), ORIGINS).ok).toBe(false);
  });

  it('rejects POSTs with neither header', () => {
    expect(checkCsrf(req('POST', '/submit'), ORIGINS)).toEqual({
      ok: false,
      reason: 'Missing Origin and Referer headers',
    });
  });

  it.each(['/api/stripe/webhook', '/api/resend/webhook', '/api/cron/tick', '/api/unsubscribe'])(
    'exempts %s, which authenticates itself',
    (path) => {
      expect(checkCsrf(req('POST', path), ORIGINS).ok).toBe(true);
    },
  );

  it('does not exempt look-alike paths', () => {
    expect(checkCsrf(req('POST', '/api/stripe/webhook/x'), ORIGINS).ok).toBe(false);
  });
});

import { withHeaderOnlyCsp } from '../../src/lib/security/headers.ts';

describe('withHeaderOnlyCsp', () => {
  it('adds frame-ancestors to an existing policy', () => {
    expect(withHeaderOnlyCsp("default-src 'self'; style-src 'self' ;")).toBe(
      "default-src 'self'; style-src 'self' ; frame-ancestors 'none'",
    );
    expect(withHeaderOnlyCsp("default-src 'self'")).toBe("default-src 'self'; frame-ancestors 'none'");
  });
  it('sets it alone when there is no policy', () => {
    expect(withHeaderOnlyCsp(null)).toBe("frame-ancestors 'none'");
  });
});
