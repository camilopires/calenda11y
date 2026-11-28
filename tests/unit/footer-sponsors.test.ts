/**
 * With sponsorship switched off, the footer lists no sponsors and doesn't
 * read the sponsor list at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const from = vi.fn(() => {
  throw new Error('the sponsor list was read');
});
vi.mock('../../src/lib/db.ts', () => ({ db: () => ({ from }) }));

const { resetEnvCache } = await import('../../src/lib/env.ts');
const { footerSponsors } = await import('../../src/lib/sponsors/public.ts');

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  from.mockClear();
});

describe('footerSponsors', () => {
  it('lists nobody, without reading the list, when sponsorship is off', async () => {
    vi.stubEnv('SPONSORSHIP', 'soon');
    resetEnvCache();
    expect(await footerSponsors()).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it('reads the list when sponsorship is open', async () => {
    vi.stubEnv('SPONSORSHIP', 'open');
    resetEnvCache();
    await footerSponsors();
    expect(from).toHaveBeenCalledWith('public_sponsors');
  });
});
