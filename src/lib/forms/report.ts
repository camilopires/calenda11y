import { adminEmails } from '../admin/admins.ts';
import { db } from '../db.ts';
import { queued, sendNow } from '../email/outbox.ts';
import { reportForAdmins } from '../email/templates.ts';
import { ServiceError } from '../result.ts';
import type { FieldErrors } from './errors.ts';
import { isEmail } from './event.ts';

export const REPORT_REASONS = {
  wrong_details: 'Some details are wrong, like the date, time or place',
  cancelled: 'The event has been cancelled or moved',
  access_problem: 'The access information is wrong',
  not_accessibility: "It isn't about accessibility",
  spam: "It's spam or not a real event",
  other: 'Something else',
} as const;
export type ReportReason = keyof typeof REPORT_REASONS;

export interface ReportValues {
  reason: string;
  details: string;
  email: string;
}

export function validateReport(v: ReportValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!(v.reason in REPORT_REASONS)) errors.reason = 'Choose what the problem is';
  if (v.reason === 'other' && !v.details) errors.details = 'Tell us what the problem is';
  if (v.details.length > 2000) errors.details = 'Your description must be 2,000 characters or fewer';
  if (v.email && !isEmail(v.email)) errors.email = 'Enter an email address in the right format, like name@example.com';
  return errors;
}

export async function createReport(
  event: { id: string; title: string },
  v: ReportValues,
  nonce: string,
): Promise<'created' | 'already_submitted'> {
  const reasonText = REPORT_REASONS[v.reason as ReportReason];
  const prefix = `report:${nonce}:`;
  const emails = (await adminEmails()).map((to) =>
    queued('admin_report', `${prefix}${to}`, to, reportForAdmins(event, reasonText, v.details || null)),
  );
  const { error } = await db().rpc('create_report', {
    p_report: { event_id: event.id, reason: v.reason, details: v.details, reporter_email: v.email },
    p_nonce: nonce,
    p_emails: emails,
  });
  if (error?.message === 'already_submitted') return 'already_submitted';
  if (error) throw new ServiceError('supabase', `creating report: ${error.message}`, error.code);
  try {
    await sendNow(prefix);
  } catch (err) {
    console.error('[report] sending emails now failed; they will be retried', err);
  }
  return 'created';
}
