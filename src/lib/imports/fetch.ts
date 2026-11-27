/**
 * Fetching import feeds safely. Admins add feed URLs, but a URL can still
 * point at (or redirect to) something internal, so every request:
 *  - must be https, on the default port;
 *  - resolves DNS itself and refuses private, loopback, link-local, CGNAT,
 *    multicast and cloud-metadata addresses (IPv4 and IPv6), then connects to
 *    the address it checked, so DNS can't change in between (rebinding);
 *  - follows at most 3 redirects, checking each one the same way;
 *  - times out after 20 seconds and stops reading after 5 MB.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 3;

export class FetchBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchBlocked';
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4-mapped addresses (::ffff:a.b.c.d) are checked as IPv4 in isBlockedAddress.
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True if an address must never be fetched from. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1): check the IPv4 part.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return blocked.check(address, 'ipv4');
}

/** Checks a URL before any network access. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlocked('Not a valid web address');
  }
  if (url.protocol !== 'https:') throw new FetchBlocked('Only https addresses can be fetched');
  if (url.username || url.password) throw new FetchBlocked('Addresses with a username or password are not allowed');
  if (url.port && url.port !== '443') throw new FetchBlocked('Only the standard https port is allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) throw new FetchBlocked('That address is on a private network');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new FetchBlocked('That address is on a private network');
  }
  return url;
}

type LookupFn = (
  hostname: string,
  options: object,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/** A DNS lookup that refuses private addresses. The connection then uses the address it approved. */
export const guardedLookup: LookupFn = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || list.length === 0) {
      return callback(
        Object.assign(new FetchBlocked(`${hostname} points to a private network address`), { code: 'EBLOCKED' }),
        [],
      );
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

const agent = new Agent({ connect: { lookup: guardedLookup as never, timeout: 10_000 }, maxRedirections: 0 } as never);

export interface FetchedText {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  /** For tests: replace the network. */
  fetcher?: typeof undiciFetch;
}

async function readLimited(res: Awaited<ReturnType<typeof undiciFetch>>): Promise<string> {
  if (!res.body) return '';
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw new FetchBlocked(`The response is too big (over ${MAX_BYTES / 1024 / 1024} MB)`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new FetchBlocked(`The response is too big (over ${MAX_BYTES / 1024 / 1024} MB)`);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedText> {
  const doFetch = options.fetcher ?? undiciFetch;
  let url = checkUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await doFetch(url, {
      method: options.method ?? 'GET',
      headers: { 'User-Agent': 'calenda11y-importer/1.0 (+https://calenda11y.org/about)', ...options.headers },
      ...(options.body !== undefined && { body: options.body }),
      redirect: 'manual',
      dispatcher: agent,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new FetchBlocked(`Redirect without a destination from ${url.host}`);
      if (hop === MAX_REDIRECTS) throw new FetchBlocked(`Too many redirects (more than ${MAX_REDIRECTS})`);
      url = checkUrl(new URL(location, url).href);
      continue;
    }
    const body = await readLimited(res);
    return { url: url.href, status: res.status, contentType: res.headers.get('content-type') ?? '', body };
  }
  throw new FetchBlocked('Too many redirects');
}
