import { describe, expect, it } from 'vitest';
import { CARRIED_CAPTCHA_MS, trustCarried } from '../../src/lib/services/captcha.ts';

describe('trustCarried', () => {
  const now = 1_800_000_000_000;
  it('trusts a recent verified result', () => {
    expect(trustCarried({ result: 'verified', at: now - 60_000 }, now)).toBe(true);
  });
  it('does not trust an old one, a future one, or an unverified one', () => {
    expect(trustCarried({ result: 'verified', at: now - CARRIED_CAPTCHA_MS }, now)).toBe(false);
    expect(trustCarried({ result: 'verified', at: now + 60_000 }, now)).toBe(false);
    expect(trustCarried({ result: 'unverified', at: now }, now)).toBe(false);
    expect(trustCarried(null, now)).toBe(false);
  });
});
