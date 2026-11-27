/** Transactional emails. Each returns subject, HTML and plain text. */
import { env } from '../env.ts';
import { describeWhen } from '../events/dates.ts';
import { zoneNote } from '../text/abbr.ts';
import { renderEmail, type Block, type EmailContent } from './render.ts';

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

/** A closing paragraph expanding UTC or GMT, if any of these times use them (WCAG 3.1.4). */
const zoneBlocks = (times: string[]): Block[] => {
  const note = zoneNote(times);
  return note ? [{ type: 'p', text: note }] : [];
};

export function submissionReceived(e: EventLike): EmailContent {
  return renderEmail(`We've got your event: ${e.title}`, 'Thanks, we have your event', [
    { type: 'p', text: `You added "${e.title}" (${whenText(e)}) to calenda11y.` },
    ...zoneBlocks([whenText(e)]),
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
    ...zoneBlocks([whenText(e)]),
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

// ---------------------------------------------------------------------------
// Digest emails
// ---------------------------------------------------------------------------

export function confirmSubscription(confirmLink: string, description: string): EmailContent {
  return renderEmail('Confirm your calenda11y emails', 'Confirm your emails', [
    { type: 'p', text: `Someone, hopefully you, asked to get emails from calenda11y about ${description}.` },
    { type: 'link', text: 'Confirm my emails', href: confirmLink },
    {
      type: 'p',
      text: 'The link works for 7 days. If you did not ask for this, ignore this email and you will not hear from us again.',
    },
  ]);
}

export function manageSubscription(manageLink: string): EmailContent {
  return renderEmail('Your calenda11y emails', 'You already get calenda11y emails', [
    {
      type: 'p',
      text: 'Someone asked to sign this address up for calenda11y emails, but it is already signed up, so nothing has changed.',
    },
    { type: 'p', text: 'To change what you get, or to stop getting emails, use this link:' },
    { type: 'link', text: 'Manage my emails', href: manageLink },
    { type: 'p', text: 'If you did not ask for this, you can ignore this email.' },
  ]);
}

export interface DigestItem {
  title: string;
  url: string;
  when: string;
  where: string;
  summary: string;
  /** "Call for speakers: apply by ...", when the event has one. */
  cfp?: string | null;
}

/** A call for speakers in the digest's "closing soon" section. */
export interface CfpItem {
  title: string;
  /** Where to apply. */
  url: string;
  /** "Apply by Monday 8 March 2027" or "Apply before the event starts". */
  deadline: string;
  /** When and where the event is. */
  event: string;
}

export function digestEmail(
  heading: string,
  items: DigestItem[],
  manageLink: string,
  unsubscribeLink: string,
  options: { total?: number; listUrl?: string; cfp?: CfpItem[] } = {},
): EmailContent {
  const total = options.total ?? items.length;
  const more = total > items.length;
  const calls = options.cfp ?? [];
  const intro = !items.length
    ? 'No events in this period match your choices, but these calls for speakers are open.'
    : more
      ? `${total} events match your choices. Here are the first ${items.length}.`
      : `${items.length} ${items.length === 1 ? 'event' : 'events'} for you.`;
  return renderEmail(
    heading,
    heading,
    [
      { type: 'p', text: intro },
      ...(items.length
        ? [
            {
              type: 'list' as const,
              items: items.map((i) => ({
                text: i.title,
                href: i.url,
                detail: `${i.when}. ${i.where}. ${i.summary}${i.cfp ? ` ${i.cfp}.` : ''}`,
              })),
            },
          ]
        : []),
      ...(calls.length
        ? [
            { type: 'h2' as const, text: 'Calls for speakers closing soon' },
            {
              type: 'list' as const,
              items: calls.map((c) => ({ text: `${c.deadline}: ${c.title}`, href: c.url, detail: `${c.event}.` })),
            },
          ]
        : []),
      more && options.listUrl
        ? { type: 'link', text: `See all ${total} events on calenda11y`, href: options.listUrl }
        : { type: 'link', text: 'See all events on calenda11y', href: options.listUrl ?? url('/') },
      ...zoneBlocks(items.map((i) => i.when)),
    ],
    [
      { type: 'p', text: 'You get this because you signed up for calenda11y emails.' },
      { type: 'link', text: 'Change what you get', href: manageLink },
      { type: 'link', text: 'Unsubscribe', href: unsubscribeLink },
    ],
  );
}

/** An event in an alert, with what changed (empty for new events). */
export interface AlertItem {
  title: string;
  url: string;
  when: string;
  where: string;
  summary: string;
  reasons: string[];
}

/** New and changed events since the person's last alert. */
export function alertEmail(
  added: AlertItem[],
  updated: AlertItem[],
  manageLink: string,
  unsubscribeLink: string,
  options: { total?: number; listUrl?: string } = {},
): EmailContent {
  const shown = added.length + updated.length;
  const total = options.total ?? shown;
  const list = (items: AlertItem[]): Block => ({
    type: 'list',
    items: items.map((i) => ({
      text: i.title,
      href: i.url,
      detail: [...i.reasons, `${i.when}. ${i.where}. ${i.summary}`].join('. '),
    })),
  });
  const heading = 'New and updated accessibility events';
  return renderEmail(
    heading,
    heading,
    [
      ...(added.length ? [{ type: 'h2' as const, text: 'New' }, list(added)] : []),
      ...(updated.length ? [{ type: 'h2' as const, text: 'Updated' }, list(updated)] : []),
      ...(total > shown && options.listUrl
        ? [
            { type: 'p' as const, text: `These are the first ${shown} of ${total}. See everything new on calenda11y:` },
            { type: 'link' as const, text: 'See all events on calenda11y', href: options.listUrl },
          ]
        : []),
      ...zoneBlocks([...added, ...updated].map((i) => i.when)),
    ],
    [
      { type: 'p', text: 'You get this because you asked for alerts from calenda11y.' },
      { type: 'link', text: 'Change what you get', href: manageLink },
      { type: 'link', text: 'Unsubscribe', href: unsubscribeLink },
    ],
  );
}

// ---------------------------------------------------------------------------
// Sponsor emails
// ---------------------------------------------------------------------------

export function sponsorWelcome(profileLink: string, recurring: boolean): EmailContent {
  return renderEmail('Thank you for sponsoring calenda11y', 'Thank you for sponsoring calenda11y', [
    {
      type: 'p',
      text: recurring
        ? 'Your sponsorship has started. Stripe will email you receipts.'
        : 'Your donation has gone through. Stripe will email you a receipt.',
    },
    {
      type: 'p',
      text: 'Add your name, website and logo to the sponsors page. A person checks them before they appear.',
    },
    { type: 'link', text: 'Set up your sponsor profile', href: profileLink },
    { type: 'p', text: 'The link works once and lasts 30 days. You can always get a new one from the sponsor page.' },
  ]);
}

export function sponsorLinks(profileLink: string, portalLink: string): EmailContent {
  return renderEmail('Your calenda11y sponsorship', 'Your calenda11y sponsorship', [
    { type: 'link', text: 'Change your sponsor profile', href: profileLink },
    { type: 'link', text: 'Manage payments, receipts or cancel', href: portalLink },
    { type: 'p', text: 'Each link works once and lasts 24 hours. If you did not ask for this, ignore this email.' },
  ]);
}
