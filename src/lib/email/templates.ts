/** Transactional emails. Each returns subject, HTML and plain text. */
import { env } from '../env.ts';
import { describeWhen } from '../events/dates.ts';
import { renderEmail, type EmailContent } from './render.ts';

const site = () => env().SITE_URL;
const url = (path: string) => new URL(path, site()).href;

interface EventLike {
  title: string;
  slug: string;
  all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  local_start_date: string;
  local_end_date: string;
  timezone: string;
}

const whenText = (e: EventLike) => {
  const w = describeWhen(e);
  return `${w.date}, ${w.time}`;
};

export function submissionReceived(e: EventLike): EmailContent {
  return renderEmail(`We've got your event: ${e.title}`, 'Thanks, we have your event', [
    { type: 'p', text: `You added "${e.title}" (${whenText(e)}) to calenda11y.` },
    {
      type: 'p',
      text: 'A person will check it, usually within 2 working days. We will email you when it is published, or if there is a problem.',
    },
    { type: 'p', text: 'If you did not add this event, you can ignore this email.' },
  ]);
}

export function newSubmissionForAdmins(e: EventLike & { id: string }, flags: string[]): EmailContent {
  return renderEmail(`New event to check: ${e.title}`, 'A new event is waiting for review', [
    { type: 'p', text: `"${e.title}", ${whenText(e)}.` },
    ...(flags.length ? [{ type: 'p' as const, text: `Flags: ${flags.join(', ')}.` }] : []),
    { type: 'link', text: 'Review the event', href: url(`/admin/events/${e.id}`) },
  ]);
}

export function eventApproved(e: EventLike): EmailContent {
  return renderEmail(`Your event is published: ${e.title}`, 'Your event is published', [
    { type: 'p', text: `"${e.title}" is now on calenda11y.` },
    { type: 'link', text: 'See your event', href: url(`/events/${e.slug}`) },
    { type: 'p', text: 'If any details change, reply to this email or use "Report a problem" on the event page.' },
  ]);
}

export function eventRejected(e: EventLike, reason: string): EmailContent {
  return renderEmail(`Your event was not published: ${e.title}`, 'We did not publish your event', [
    { type: 'p', text: `We checked "${e.title}" and did not publish it, for this reason:` },
    { type: 'p', text: reason },
    { type: 'p', text: 'If you can fix this, you are welcome to add the event again.' },
    { type: 'link', text: 'Add an event', href: url('/submit') },
  ]);
}

export function reportForAdmins(
  e: { id: string; title: string },
  reason: string,
  details: string | null,
): EmailContent {
  return renderEmail(`Problem reported: ${e.title}`, 'Someone reported a problem with an event', [
    { type: 'p', text: `Event: "${e.title}".` },
    { type: 'p', text: `Reason: ${reason}.` },
    ...(details ? [{ type: 'p' as const, text: `Details: ${details}` }] : []),
    { type: 'link', text: 'See open reports', href: url('/admin/reports') },
  ]);
}
