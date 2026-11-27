import type { APIRoute } from 'astro';
import { env } from '../../../lib/env';
import { runTick } from '../../../lib/jobs/queue';
import '../../../lib/jobs/handlers';
import { safeEqual } from '../../../lib/security/tokens';

/**
 * The scheduler's entry point: pg_cron (POST) or Vercel Cron (GET), each with
 * "Authorization: Bearer <CRON_SECRET>".
 */
const handle: APIRoute = async ({ request }) => {
  const auth = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${env().CRON_SECRET}`;
  if (!safeEqual(auth, expected)) {
    return new Response(JSON.stringify({ error: 'unauthorised' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const summary = await runTick({ budgetMs: 45_000 });
  return new Response(JSON.stringify(summary), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

export const GET = handle;
export const POST = handle;
