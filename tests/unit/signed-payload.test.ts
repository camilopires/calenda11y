import { describe, expect, it } from 'vitest';
import { signPayload, verifyPayload } from '../../src/lib/forms/signedPayload.ts';

describe('signed payloads', () => {
  it('round-trips data with a nonce', () => {
    const token = signPayload('event', { title: 'Café ünïcode' }, 'nonce-123456789012');
    expect(verifyPayload('event', token)).toEqual({ data: { title: 'Café ünïcode' }, nonce: 'nonce-123456789012' });
  });

  it('rejects tampering', () => {
    const token = signPayload('event', { title: 'A' });
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ data: { title: 'B' }, nonce: 'x' })).toString('base64url');
    expect(verifyPayload('event', `${forged}.${sig}`)).toBeNull();
    expect(verifyPayload('event', `${body}.${sig}x`)).toBeNull();
  });

  it('rejects a payload signed for a different purpose', () => {
    expect(verifyPayload('report', signPayload('event', { a: 1 }))).toBeNull();
  });

  it('rejects junk', () => {
    for (const junk of [null, '', '.', 'abc', 'a.b', 'x'.repeat(300_000)])
      expect(verifyPayload('event', junk)).toBeNull();
  });

  it('makes a new nonce each time', () => {
    const a = verifyPayload('event', signPayload('event', {}))!;
    const b = verifyPayload('event', signPayload('event', {}))!;
    expect(a.nonce).not.toBe(b.nonce);
  });
});
