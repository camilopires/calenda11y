import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../env.ts';

/** A URL-safe random token (32 bytes by default). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** HMAC with the app secret, separated by purpose so one token can't be reused for another. */
export function hmac(purpose: string, value: string, secret = env().APP_SECRET): string {
  return createHmac('sha256', secret).update(`${purpose}\u0000${value}`).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
