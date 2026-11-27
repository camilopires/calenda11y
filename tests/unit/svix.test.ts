import { describe, expect, it } from 'vitest';
import { signSvix, verifySvix } from '../../src/lib/email/webhook.ts';

const secret = `whsec_${Buffer.from('a test signing key for svix').toString('base64')}`;
const body = '{"type":"email.bounced"}';

function headers(ts: number, sig = signSvix(secret, 'msg_1', String(ts), body)) {
  return new Headers({ 'svix-id': 'msg_1', 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` });
}

describe('verifySvix', () => {
  const now = Date.parse('2027-01-01T00:00:00Z');
  it('accepts a valid signature', () => {
    expect(verifySvix(secret, headers(now / 1000), body, now)).toBe(true);
  });
  it('rejects a changed body or bad signature', () => {
    expect(verifySvix(secret, headers(now / 1000), `${body} `, now)).toBe(false);
    expect(verifySvix(secret, headers(now / 1000, 'bm9wZQ=='), body, now)).toBe(false);
  });
  it('rejects old timestamps (replays)', () => {
    expect(verifySvix(secret, headers(now / 1000 - 600), body, now)).toBe(false);
  });
  it('accepts any of several signatures (key rotation)', () => {
    const h = headers(now / 1000);
    h.set('svix-signature', `v1,bm9wZQ== ${h.get('svix-signature')}`);
    expect(verifySvix(secret, h, body, now)).toBe(true);
  });
});
