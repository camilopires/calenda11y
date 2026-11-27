import type { APIRoute } from 'astro';
import { fromLink, unsubscribe } from '../../lib/digest/subscribers';

/**
 * RFC 8058 one-click unsubscribe. Mail apps POST "List-Unsubscribe=One-Click"
 * here with no cookies and from no web page, so this endpoint authenticates
 * by its signed token alone (it's exempt from the CSRF check). GET never
 * changes anything: it shows a confirmation page instead.
 */
export const GET: APIRoute = ({ url, redirect }) =>
  redirect(`/subscribe/unsubscribe?token=${encodeURIComponent(url.searchParams.get('token') ?? '')}`, 303);

export const POST: APIRoute = async ({ url, request }) => {
  const body = await request.text();
  const oneClick = new URLSearchParams(body).get('List-Unsubscribe') === 'One-Click';
  const sub = await fromLink('unsubscribe', url.searchParams.get('token'));
  // An unknown or already-used link: the address is not on the list either way.
  if (sub) await unsubscribe(sub);
  if (oneClick)
    return new Response('Unsubscribed', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(null, { status: 303, headers: { Location: '/subscribe/unsubscribed' } });
};
