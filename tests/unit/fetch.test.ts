import { describe, expect, it } from 'vitest';
import { FetchBlocked, checkUrl, guardedLookup, isBlockedAddress, safeFetch } from '../../src/lib/imports/fetch.ts';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    // 6to4 and Teredo carry an IPv4 address inside; local NAT64 reaches IPv4 networks.
    '2002:0a00:0001::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '64:ff9b:1::a00:1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('checkUrl', () => {
  it.each([
    ['http://example.org/feed.ics', /https/],
    ['ftp://example.org', /https/],
    ['https://user:pw@example.org', /username/],
    ['https://example.org:8443/', /port/],
    ['https://127.0.0.1/', /private/],
    ['https://[::1]/', /private/],
    ['https://[2002:a00:1::1]/', /private/],
    ['https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', /private/],
    ['https://localhost/', /private/],
    ['https://metadata.internal/', /private/],
    ['not a url', /valid/],
  ])('refuses %s', (url, message) => {
    expect(() => checkUrl(url)).toThrow(message);
  });

  it('accepts public https URLs', () => {
    expect(checkUrl('https://example.org/cal.ics').href).toBe('https://example.org/cal.ics');
  });
});

describe('guardedLookup', () => {
  it('refuses a name that resolves to a private address', async () => {
    const err = await new Promise<Error | null>((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)));
    expect(err).toBeInstanceOf(FetchBlocked);
  });
});

const response = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers }) as unknown as Awaited<ReturnType<typeof import('undici').fetch>>;

describe('safeFetch', () => {
  it('follows redirects to allowed addresses', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: URL) => {
      calls.push(String(url));
      return calls.length === 1
        ? response(302, '', { location: '/moved.ics' })
        : response(200, 'BEGIN:VCALENDAR', { 'content-type': 'text/calendar' });
    }) as never;
    const r = await safeFetch('https://example.org/cal.ics', { fetcher });
    expect(calls).toEqual(['https://example.org/cal.ics', 'https://example.org/moved.ics']);
    expect(r.body).toBe('BEGIN:VCALENDAR');
  });

  it('refuses a redirect to a private address', async () => {
    const fetcher = (async () => response(302, '', { location: 'https://169.254.169.254/latest/meta-data' })) as never;
    await expect(safeFetch('https://example.org/cal.ics', { fetcher })).rejects.toThrow(/private network/);
  });

  it('refuses a redirect to a 6to4 address', async () => {
    const fetcher = (async () => response(302, '', { location: 'https://[2002:a9fe:a9fe::1]/x' })) as never;
    await expect(safeFetch('https://example.org/cal.ics', { fetcher })).rejects.toThrow(/private network/);
  });

  it('refuses a redirect to http', async () => {
    const fetcher = (async () => response(301, '', { location: 'http://example.org/cal.ics' })) as never;
    await expect(safeFetch('https://example.org/cal.ics', { fetcher })).rejects.toThrow(/https/);
  });

  it('stops after too many redirects', async () => {
    const fetcher = (async () => response(302, '', { location: '/again' })) as never;
    await expect(safeFetch('https://example.org/', { fetcher })).rejects.toThrow(/Too many redirects/);
  });

  it('refuses responses over 5 MB, even without a Content-Length', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 10);
    const fetcher = (async () => response(200, big)) as never;
    await expect(safeFetch('https://example.org/', { fetcher })).rejects.toThrow(/too big/);
  });
});
