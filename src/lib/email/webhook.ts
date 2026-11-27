/**
 * Resend webhooks are signed with Svix: HMAC-SHA256 over "id.timestamp.body"
 * with the base64 secret after "whsec_". We check the signature and that the
 * timestamp is within 5 minutes, to stop replays.
 */
import { createHmac } from 'node:crypto';
import { safeEqual } from '../security/tokens.ts';

export const TOLERANCE_SECONDS = 300;

export function signSvix(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export function verifySvix(secret: string, headers: Headers, body: string, now = Date.now()): boolean {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatures = headers.get('svix-signature');
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = signSvix(secret, id, timestamp, body);
  return signatures.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && !!sig && safeEqual(sig, expected);
  });
}
