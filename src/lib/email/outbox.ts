/**
 * The email outbox. Emails are written to the database in the same
 * transaction as whatever caused them, then sent from here. Each row is sent
 * under a lease, with its id as the provider's idempotency key, so a retry
 * never sends twice.
 */
import { db } from '../db.ts';
import { unwrap } from '../result.ts';
import { mailer, MailerError } from '../services/mailer.ts';
import type { EmailContent } from './render.ts';

export interface QueuedEmail {
  kind: string;
  dedupe_key: string;
  to_email: string;
  subject: string;
  html: string;
  text_body: string;
  headers?: Record<string, string>;
}

export function queued(
  kind: string,
  dedupeKey: string,
  to: string,
  content: EmailContent,
  headers?: Record<string, string>,
): QueuedEmail {
  return {
    kind,
    dedupe_key: dedupeKey,
    to_email: to,
    subject: content.subject,
    html: content.html,
    text_body: content.text,
    ...(headers && { headers }),
  };
}

interface OutboxRow {
  id: string;
  to_email: string;
  subject: string;
  html: string;
  text_body: string;
  headers: Record<string, string>;
  attempts: number;
}

export const LEASE_SECONDS = 120;
export const MAX_ATTEMPTS = 8;

/** Minutes to wait before the next try: 1, 4, 9, 16 … capped at 6 hours. */
export function backoffMinutes(attempts: number): number {
  return Math.min(attempts * attempts, 360);
}

export interface SendSummary {
  sent: number;
  retrying: number;
  failed: number;
}

/**
 * Sends due emails. With `ids`, only those (used to send right after queuing);
 * otherwise up to `limit` of whatever is due.
 */
export async function sendOutbox(options: { ids?: string[]; limit?: number } = {}): Promise<SendSummary> {
  const rows = unwrap(
    await db().rpc('claim_outbox', {
      p_limit: options.limit ?? 50,
      p_lease_seconds: LEASE_SECONDS,
      p_ids: options.ids ?? null,
    }),
    'supabase',
    'claiming emails',
  ) as OutboxRow[];

  const summary: SendSummary = { sent: 0, retrying: 0, failed: 0 };
  for (const row of rows) {
    try {
      const { id } = await mailer().send({
        to: row.to_email,
        subject: row.subject,
        html: row.html,
        text: row.text_body,
        headers: row.headers,
        idempotencyKey: row.id,
      });
      unwrap(
        await db()
          .from('email_outbox')
          .update({
            status: 'sent',
            provider_message_id: id,
            lease_until: null,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
          .select('id'),
        'supabase',
        'marking email sent',
      );
      summary.sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = (error instanceof MailerError && error.permanent) || row.attempts >= MAX_ATTEMPTS;
      console.error(`[outbox] ${permanent ? 'failed' : 'will retry'} ${row.id}: ${message}`);
      unwrap(
        await db()
          .from('email_outbox')
          .update({
            status: permanent ? 'failed' : 'queued',
            lease_until: null,
            last_error: message.slice(0, 1000),
            next_attempt_at: new Date(Date.now() + backoffMinutes(row.attempts) * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
          .select('id'),
        'supabase',
        'recording email failure',
      );
      if (permanent) summary.failed++;
      else summary.retrying++;
    }
  }
  return summary;
}

/** Sends the emails just queued for something, without waiting for the next scheduled run. */
export async function sendNow(dedupePrefix: string): Promise<SendSummary> {
  const rows = unwrap(
    await db().from('email_outbox').select('id').like('dedupe_key', `${dedupePrefix}%`).eq('status', 'queued'),
    'supabase',
    'finding queued emails',
  ) as Array<{ id: string }>;
  if (!rows.length) return { sent: 0, retrying: 0, failed: 0 };
  return sendOutbox({ ids: rows.map((r) => r.id) });
}
