/** Creating a submitted event: the event, its private details and its emails, in one transaction. */
import { adminEmails } from '../admin/admins.ts';
import { db } from '../db.ts';
import { queued, sendNow } from '../email/outbox.ts';
import { newSubmissionForAdmins, submissionReceived } from '../email/templates.ts';
import { ServiceError } from '../result.ts';
import type { CaptchaResult } from '../services/captcha.ts';
import { randomUUID } from 'node:crypto';
import { randomToken } from '../security/tokens.ts';
import { localDates } from './answers.ts';
import { newSlug, type EventRecord, type SubmitterValues } from './event.ts';

export type SubmissionResult = { status: 'created'; id: string; slug: string } | { status: 'already_submitted' };

const shortId = () =>
  randomToken(6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 6)
    .padEnd(6, '0');

export async function createSubmission(
  record: EventRecord,
  submitter: SubmitterValues,
  captcha: CaptchaResult,
  nonce: string,
): Promise<SubmissionResult> {
  const id = randomUUID();
  const slug = newSlug(record.title, shortId);
  const flags = captcha === 'verified' ? [] : ['captcha_unverified'];
  const dates = localDates(record);
  const preview = { ...record, id, slug, local_start_date: dates.start, local_end_date: dates.end };
  const prefix = `submit:${nonce}:`;

  const admins = await adminEmails();
  const emails = [
    queued('submission_received', `${prefix}received`, submitter.email, submissionReceived(preview)),
    ...admins.map((to) =>
      queued('admin_new_submission', `${prefix}admin:${to}`, to, newSubmissionForAdmins(preview, flags)),
    ),
  ];

  const { data, error } = await db().rpc('create_submission', {
    p_event: { ...record, id, slug, flags },
    p_private: { submitter_email: submitter.email, submitter_name: submitter.name },
    p_nonce: nonce,
    p_emails: emails,
  });
  if (error?.message === 'already_submitted') return { status: 'already_submitted' };
  if (error || !data?.[0])
    throw new ServiceError('supabase', `creating submission: ${error?.message ?? 'no data'}`, error?.code);
  const row = data[0] as { id: string; slug: string };

  try {
    await sendNow(prefix);
  } catch (err) {
    // The emails stay queued and the scheduled sender retries them.
    console.error('[submit] sending emails now failed; they will be retried', err);
  }
  return { status: 'created', id: row.id, slug: row.slug };
}
