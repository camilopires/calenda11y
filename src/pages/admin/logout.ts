import type { APIRoute } from 'astro';
import { authClient } from '../../lib/admin/auth';

export const POST: APIRoute = async (ctx) => {
  await authClient(ctx).auth.signOut();
  return ctx.redirect('/admin/login?signed_out=1', 303);
};
