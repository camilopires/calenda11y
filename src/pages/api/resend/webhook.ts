import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { env } from '../../../lib/env';
import { verifySvix } from '../../../lib/email/webhook';
import { suppressAddress } from '../../../lib/digest/subscribers';

interface ResendEvent {
  type: string;
  data?: { email_id?: string; to?: string[] | string };
}

/** Bounces and spam complaints stop digest emails to that address. */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.text();
  const secret = env().RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[resend webhook] RESEND_WEBHOOK_SECRET is not set; refusing the request');
    return new Response('Webhook not configured', { status: 503 });
  }
  if (!verifySvix(secret, request.headers, body)) return new Response('Bad signature', { status: 401 });

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  if (event.type !== 'email.bounced' && event.type !== 'email.complained')
    return new Response('Ignored', { status: 200 });

  const reason = event.type === 'email.bounced' ? 'bounced' : 'marked as spam';
  const recipients = [event.data?.to ?? []].flat();
  for (const to of recipients) {
    try {
      // Marks the address suppressed and removes its subscription emails, in one transaction.
      await suppressAddress(to, reason);
    } catch (error) {
      // Fail so Resend retries; nothing is lost.
      console.error('[resend webhook] could not suppress the address', error);
      return new Response('Could not record', { status: 500 });
    }
  }
  if (event.data?.email_id) {
    await db()
      .from('email_outbox')
      .update({ last_error: `Recipient ${reason}` })
      .eq('provider_message_id', event.data.email_id);
  }
  return new Response('OK', { status: 200 });
};
