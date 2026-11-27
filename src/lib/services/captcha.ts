/**
 * Cloudflare Turnstile. It runs in "managed" mode: most people never see a
 * challenge, and there's never a visual puzzle (WCAG 3.3.8/3.3.9).
 *
 * Without JavaScript the widget can't run, so a missing token doesn't block
 * anyone: the submission is accepted, flagged for closer review, and given a
 * tighter rate limit.
 */
import { env } from '../env.ts';

export type CaptchaResult = 'verified' | 'unverified';

export interface CaptchaVerifier {
  readonly siteKey: string | undefined;
  verify(token: string | null, ip: string, action: string): Promise<CaptchaResult>;
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

class Turnstile implements CaptchaVerifier {
  readonly siteKey: string;
  readonly #secret: string;
  readonly #hostname: string;
  constructor(siteKey: string, secret: string, hostname: string) {
    this.siteKey = siteKey;
    this.#secret = secret;
    this.#hostname = hostname;
  }

  async verify(token: string | null, ip: string, action: string): Promise<CaptchaResult> {
    if (!token || token.length > 2048) return 'unverified';
    try {
      const res = await fetch(SITEVERIFY, {
        method: 'POST',
        body: new URLSearchParams({ secret: this.#secret, response: token, remoteip: ip }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json()) as {
        success?: boolean;
        hostname?: string;
        action?: string;
        'error-codes'?: string[];
      };
      if (body.success && body.hostname === this.#hostname && body.action === action) return 'verified';
      console.warn(`[captcha] not verified: ${JSON.stringify(body['error-codes'] ?? [])}`);
      return 'unverified';
    } catch (error) {
      // If Cloudflare is down, don't block people; the submission is flagged instead.
      console.error('[captcha] verification request failed', error);
      return 'unverified';
    }
  }
}

/** Test fake: the token "pass" verifies; anything else doesn't. */
class FakeCaptcha implements CaptchaVerifier {
  readonly siteKey = undefined;
  async verify(token: string | null): Promise<CaptchaResult> {
    return token === 'pass' ? 'verified' : 'unverified';
  }
}

let instance: CaptchaVerifier | undefined;

export function captcha(): CaptchaVerifier {
  if (!instance) {
    const e = env();
    instance =
      e.APP_ENV !== 'test' && e.TURNSTILE_SITE_KEY && e.TURNSTILE_SECRET_KEY
        ? new Turnstile(e.TURNSTILE_SITE_KEY, e.TURNSTILE_SECRET_KEY, new URL(e.SITE_URL).hostname)
        : new FakeCaptcha();
  }
  return instance;
}

/** How long a captcha result carried between form steps is trusted. */
export const CARRIED_CAPTCHA_MS = 2 * 3600_000;

export interface CarriedCaptcha {
  result: CaptchaResult;
  at: number;
}

/** True if a signed result from an earlier step can stand in for a new check. */
export function trustCarried(carried: CarriedCaptcha | null | undefined, now = Date.now()): boolean {
  return carried?.result === 'verified' && now - carried.at >= 0 && now - carried.at < CARRIED_CAPTCHA_MS;
}
