import { defineMiddleware } from 'astro:middleware';
import { DISPLAY_COOKIE, parseDisplay } from './lib/display.ts';
import { env } from './lib/env.ts';
import { checkCsrf } from './lib/security/csrf.ts';
import { securityHeaders, withHeaderOnlyCsp } from './lib/security/headers.ts';

export const onRequest = defineMiddleware(async (context, next) => {
  const config = env();
  const requestOrigin = new URL(context.request.url).origin;
  const allowedOrigins = [new URL(config.SITE_URL).origin, requestOrigin];

  const csrf = checkCsrf(context.request, allowedOrigins);
  if (!csrf.ok) {
    console.warn(`[csrf] blocked ${context.request.method} ${context.url.pathname}: ${csrf.reason}`);
    return new Response('This form was sent from another website, so it was blocked.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  context.locals.display = parseDisplay(context.cookies.get(DISPLAY_COOKIE)?.value);

  let response = await next();
  const isAdmin = context.url.pathname === '/admin' || context.url.pathname.startsWith('/admin/');
  const apply = (r: Response) => {
    for (const [name, value] of Object.entries(securityHeaders(config.APP_ENV === 'production'))) {
      if (!r.headers.has(name)) r.headers.set(name, value);
    }
    if (isAdmin) {
      // Admin pages show private data: never cache or index them.
      r.headers.set('Cache-Control', 'private, no-store');
      r.headers.set('X-Robots-Tag', 'noindex, nofollow');
    }
    r.headers.set('Content-Security-Policy', withHeaderOnlyCsp(r.headers.get('Content-Security-Policy')));
  };
  try {
    apply(response);
  } catch {
    // Some responses (e.g. Response.redirect) have immutable headers.
    response = new Response(response.body, response);
    apply(response);
  }
  return response;
});
