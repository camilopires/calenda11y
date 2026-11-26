/**
 * Carries form data from a "Check your answers" page to the final submit,
 * signed so it can't be changed in between. There's no expiry (WCAG 2.2.3 No
 * Timing); a one-time nonce inside it stops it being submitted twice.
 */
import { hmac, randomToken, safeEqual } from '../security/tokens.ts';

export interface Signed<T> {
  data: T;
  nonce: string;
}

export function signPayload<T>(purpose: string, data: T, nonce: string = randomToken(18)): string {
  const body = Buffer.from(JSON.stringify({ data, nonce }), 'utf8').toString('base64url');
  return `${body}.${hmac(`payload:${purpose}`, body)}`;
}

export function verifyPayload<T>(purpose: string, token: string | null | undefined): Signed<T> | null {
  if (!token || token.length > 200_000) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmac(`payload:${purpose}`, body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Signed<T>;
    return typeof parsed?.nonce === 'string' && parsed.data !== undefined ? parsed : null;
  } catch {
    return null;
  }
}
