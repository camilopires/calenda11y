import { describe, expect, it } from 'vitest';
import { validateReport } from '../../src/lib/forms/report.ts';

describe('validateReport', () => {
  it('needs a reason, and details for "something else"', () => {
    expect(validateReport({ reason: '', details: '', email: '' })).toEqual({ reason: 'Choose what the problem is' });
    expect(validateReport({ reason: 'other', details: '', email: '' })).toEqual({
      details: 'Tell us what the problem is',
    });
    expect(validateReport({ reason: 'cancelled', details: '', email: '' })).toEqual({});
  });
  it('checks the optional email', () => {
    expect(validateReport({ reason: 'spam', details: '', email: 'x' }).email).toMatch(/right format/);
  });
});
