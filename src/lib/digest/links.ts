/**
 * Manage and unsubscribe links. They're HMAC-signed (not stored), so every
 * digest can include them, and they stop working when the subscriber's
 * token_version is bumped.
 */
import { env } from '../env.ts';
import { hmac, safeEqual } from '../security/tokens.ts';

export type LinkKind = 'manage' | 'unsubscribe';

export function subscriberToken(kind: LinkKind, id: string, version: number): string {
  return `${id}.${version}.${hmac(`digest:${kind}`, `${id}:${version}`)}`;
}

export function readSubscriberToken(
  kind: LinkKind,
  token: string | null | undefined,
): { id: string; version: number } | null {
  const m = /^([0-9a-f-]{36})\.(\d{1,6})\.([A-Za-z0-9_-]{20,})$/.exec(token ?? '');
  if (!m) return null;
  const id = m[1]!;
  const version = Number(m[2]);
  return safeEqual(m[3]!, hmac(`digest:${kind}`, `${id}:${version}`)) ? { id, version } : null;
}

export const manageUrl = (id: string, version: number) =>
  new URL(`/subscribe/manage?token=${subscriberToken('manage', id, version)}`, env().SITE_URL).href;

export const unsubscribeUrl = (id: string, version: number) =>
  new URL(`/api/unsubscribe?token=${subscriberToken('unsubscribe', id, version)}`, env().SITE_URL).href;

/** RFC 8058 one-click unsubscribe headers. */
export function unsubscribeHeaders(id: string, version: number): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(id, version)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
