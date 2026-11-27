/**
 * Admin sign-in (Supabase magic links) and the guard every admin page and
 * action goes through.
 *
 * The guard verifies the session with the auth server (getUser), checks the
 * user is still on the admins list, and marks the response private. If a
 * form is sent after the session has expired, its contents are saved as a
 * draft and restored after signing in again (WCAG 2.2.5), so nothing typed
 * is ever lost, with or without JavaScript.
 */
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { AstroCookies } from 'astro';
import { anonKey, db } from '../db.ts';
import { env } from '../env.ts';
import { unwrapMaybe } from '../result.ts';
import { LIMITS, allow, clientIp } from '../security/ratelimit.ts';

interface Ctx {
  request: Request;
  cookies: AstroCookies;
  url: URL;
  clientAddress?: string;
}

/** Drafts bigger than this aren't kept (admin forms are far smaller). */
export const MAX_DRAFT_BYTES = 100_000;

export function authClient(ctx: Pick<Ctx, 'request' | 'cookies'>) {
  const secure = env().APP_ENV === 'production';
  return createServerClient(env().SUPABASE_URL, anonKey(), {
    auth: { flowType: 'pkce' },
    cookies: {
      getAll() {
        return parseCookieHeader(ctx.request.headers.get('Cookie') ?? '').map((c) => ({
          name: c.name,
          value: c.value ?? '',
        }));
      },
      setAll(list) {
        for (const { name, value, options } of list) {
          ctx.cookies.set(name, value, { ...options, path: '/', httpOnly: true, secure, sameSite: 'lax' });
        }
      },
    },
  });
}

const NEXT = /^\/admin(\/[A-Za-z0-9/_-]*)?(\?[A-Za-z0-9=&%_.-]*)?$/;

/** Only ever redirect to our own admin pages after signing in. */
export function safeNext(next: string | null | undefined): string {
  return next && NEXT.test(next) && !next.includes('//') ? next : '/admin';
}

export const DRAFT_COOKIE = 'admin_draft';

export type FormValues = Record<string, string | string[]>;

export function formToValues(form: FormData): FormValues {
  const out: FormValues = {};
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key).filter((v): v is string => typeof v === 'string');
    out[key] = all.length > 1 ? all : (all[0] ?? '');
  }
  return out;
}

export function valuesToForm(values: FormValues): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(values)) for (const item of [v].flat()) form.append(k, item);
  return form;
}

export interface Admin {
  userId: string;
  email: string;
}

export type Guard = { ok: true; admin: Admin; form: FormData | null } | { ok: false; response: Response };

export async function isAdmin(userId: string): Promise<boolean> {
  const row = unwrapMaybe(
    await db().from('admins').select('user_id').eq('user_id', userId).maybeSingle(),
    'supabase',
    'checking admin',
  );
  return row !== null;
}

/**
 * Call first in every admin page and endpoint. On POST it also reads the
 * form, since a body can only be read once. Pages whose forms hold typed
 * input pass `keepDraft: true` and restore it with takeDraft() after sign-in.
 */
export async function requireAdmin(ctx: Ctx, options: { keepDraft?: boolean } = {}): Promise<Guard> {
  const form = ctx.request.method === 'POST' ? await ctx.request.formData() : null;
  const { data, error } = await authClient(ctx).auth.getUser();
  const user = error ? null : data.user;
  const path = ctx.url.pathname + ctx.url.search;

  if (!user) {
    const values = form ? formToValues(form) : null;
    // Anyone can send a POST here, so drafts are capped in size and number.
    const keep =
      options.keepDraft &&
      values &&
      NEXT.test(ctx.url.pathname) &&
      JSON.stringify(values).length <= MAX_DRAFT_BYTES &&
      (await allow(LIMITS.adminDraftPerIp, clientIp(ctx.request, ctx.clientAddress)));
    let kept = false;
    if (keep && values) {
      const saved = unwrapMaybe(
        await db().from('admin_drafts').insert({ path: ctx.url.pathname, payload: values }).select('id').single(),
        'supabase',
        'saving admin draft',
      ) as { id: string } | null;
      if (saved) {
        ctx.cookies.set(DRAFT_COOKIE, saved.id, {
          path: '/admin',
          httpOnly: true,
          sameSite: 'lax',
          secure: env().APP_ENV === 'production',
          maxAge: 86_400,
        });
        kept = true;
      }
    }
    // Only promise to bring work back when there's a draft to bring back.
    const reason = kept ? '&expired=1' : form ? '&signed_out_while_sending=1' : '';
    return {
      ok: false,
      response: new Response(null, {
        status: 303,
        headers: { Location: `/admin/login?next=${encodeURIComponent(path)}${reason}` },
      }),
    };
  }

  if (!(await isAdmin(user.id))) {
    return {
      ok: false,
      response: new Response('You are signed in, but you are not on the list of calenda11y admins.', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
      }),
    };
  }
  return { ok: true, admin: { userId: user.id, email: user.email ?? '' }, form };
}

/** If a draft was saved for this page before signing in, returns it (once) and deletes it. */
export async function takeDraft(ctx: Ctx): Promise<FormData | null> {
  const id = ctx.cookies.get(DRAFT_COOKIE)?.value;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  ctx.cookies.delete(DRAFT_COOKIE, { path: '/admin' });
  const row = unwrapMaybe(
    await db()
      .from('admin_drafts')
      .delete()
      .eq('id', id)
      .eq('path', ctx.url.pathname)
      .gt('expires_at', new Date().toISOString())
      .select('payload')
      .maybeSingle(),
    'supabase',
    'restoring admin draft',
  ) as { payload: FormValues } | null;
  return row ? valuesToForm(row.payload) : null;
}
