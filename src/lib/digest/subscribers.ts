/**
 * Signing up for, confirming, changing and leaving the digest.
 *
 * A sign-up never changes an existing subscription: if the address is
 * already on the list, we email it a "manage" link instead, so knowing
 * someone's email address isn't enough to change their settings. Every
 * sign-up gets the same answer on screen, so the form can't be used to find
 * out who is subscribed.
 */
import { db } from '../db.ts';
import { env } from '../env.ts';
import { queued, sendNow } from '../email/outbox.ts';
import { confirmSubscription, manageSubscription } from '../email/templates.ts';
import {
  countryName,
  FORMAT_LABELS,
  TYPE_PLURALS,
  type EventTopic,
  type EventType,
  type Format,
} from '../events/model.ts';
import { aboutTopics } from '../events/predicates.ts';
import { ServiceError, unwrap, unwrapMaybe } from '../result.ts';
import { LIMITS, allow } from '../security/ratelimit.ts';
import { randomToken, sha256 } from '../security/tokens.ts';
import { manageUrl, readSubscriberToken, type LinkKind } from './links.ts';
/** Weekly and monthly are digests; daily and instant are alerts about new and changed events. */
export const CADENCES = ['weekly', 'monthly', 'daily', 'instant'] as const;
export type SubscriptionCadence = (typeof CADENCES)[number];

export interface Preferences {
  cadence: SubscriptionCadence;
  countries: string[];
  formats: Format[];
  /** Any of these types; empty means every type. */
  types: EventType[];
  /** About any of these topics; empty means every topic. */
  topics: EventTopic[];
  /** Also send calls for speakers closing soon. */
  include_cfp: boolean;
}

export interface Subscriber extends Preferences {
  id: string;
  email: string;
  confirmed_at: string | null;
  suppressed_at: string | null;
  token_version: number;
}

const COLS = 'id,email,cadence,countries,formats,types,topics,include_cfp,confirmed_at,suppressed_at,token_version';
const CONFIRM_DAYS = 7;

export function describePreferences(p: Preferences): string {
  const formats = p.formats.length ? p.formats.map((f) => FORMAT_LABELS[f].toLowerCase()).join(' or ') + ' ' : '';
  const where = p.countries.length
    ? ` ${p.countries.map((c) => (c === 'online' ? 'you can join online' : `in ${countryName(c)}`)).join(', or ')}`
    : '';
  const kinds =
    (p.types.length ? p.types.map((t) => TYPE_PLURALS[t]).join(' or ') : 'events') +
    (p.topics.length ? ` ${aboutTopics(p.topics)}` : '');
  const cfp = p.include_cfp ? ', plus calls for speakers' : '';
  if (p.cadence === 'daily') return `a daily email of new and changed ${formats}${kinds}${where}${cfp}`;
  if (p.cadence === 'instant') return `an email as soon as ${formats}${kinds}${where} are added or changed${cfp}`;
  return `${p.cadence === 'weekly' ? 'a weekly' : 'a monthly'} email of ${formats}${kinds}${where}${cfp}`;
}

async function sendConfirmation(subscriberId: string, email: string, prefs: Preferences): Promise<void> {
  const token = randomToken();
  unwrap(
    await db()
      .from('tokens')
      .insert({
        purpose: 'subscribe_confirm',
        subject_id: subscriberId,
        hash: sha256(token),
        expires_at: new Date(Date.now() + CONFIRM_DAYS * 86_400_000).toISOString(),
      })
      .select('id'),
    'supabase',
    'saving confirmation token',
  );
  const link = new URL(`/subscribe/confirm?token=${token}`, env().SITE_URL).href;
  const key = `subscribe:confirm:${subscriberId}:${sha256(token).slice(0, 16)}`;
  unwrap(
    await db().rpc('enqueue_emails', {
      p_emails: [queued('subscribe_confirm', key, email, confirmSubscription(link, describePreferences(prefs)))],
    }),
    'supabase',
    'queueing confirmation',
  );
  unwrap(
    await db()
      .from('digest_subscribers')
      .update({ last_confirm_sent_at: new Date().toISOString() })
      .eq('id', subscriberId)
      .select('id'),
    'supabase',
    'recording confirmation',
  );
  await sendNow(key);
}

/**
 * Handles a sign-up. Always resolves the same way for the caller; what it
 * does depends on whether the address is new, unconfirmed or confirmed.
 */
export async function signUp(email: string, prefs: Preferences): Promise<void> {
  // Stop the form being used to flood someone's inbox.
  if (!(await allow(LIMITS.emailPerRecipient, `digest:${email.toLowerCase()}`))) {
    console.info('[digest] sign-up email limit reached for a recipient; not sending');
    return;
  }
  const existing = unwrapMaybe(
    await db().from('digest_subscribers').select(COLS).eq('email', email).maybeSingle(),
    'supabase',
    'finding subscriber',
  ) as Subscriber | null;

  if (existing?.confirmed_at) {
    const key = `subscribe:manage:${existing.id}:${Date.now()}`;
    unwrap(
      await db().rpc('enqueue_emails', {
        p_emails: [
          queued('subscribe_manage', key, email, manageSubscription(manageUrl(existing.id, existing.token_version))),
        ],
      }),
      'supabase',
      'queueing manage link',
    );
    await sendNow(key);
    return;
  }
  if (existing) {
    // Not confirmed yet: send a fresh confirmation, keeping their original choices.
    await sendConfirmation(existing.id, email, existing);
    return;
  }
  const created = await db()
    .from('digest_subscribers')
    .insert({ email, ...prefs })
    .select('id')
    .single();
  if (created.error?.code === '23505') return signUp(email, prefs);
  const row = unwrap(created, 'supabase', 'adding subscriber') as { id: string };
  await sendConfirmation(row.id, email, prefs);
}

export async function confirm(token: string): Promise<Subscriber | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  // Uses the link and confirms in one transaction (see confirm_subscription).
  const subject = unwrapMaybe(
    await db().rpc('confirm_subscription', { p_hash: sha256(token) }),
    'supabase',
    'confirming subscription',
  ) as string | null;
  if (!subject) return null;
  return unwrapMaybe(
    await db().from('digest_subscribers').select(COLS).eq('id', subject).maybeSingle(),
    'supabase',
    'reading subscriber',
  ) as Subscriber | null;
}

/** Finds the subscriber a manage or unsubscribe link belongs to, if the link is still valid. */
export async function fromLink(kind: LinkKind, token: string | null | undefined): Promise<Subscriber | null> {
  const t = readSubscriberToken(kind, token);
  if (!t) return null;
  return unwrapMaybe(
    await db().from('digest_subscribers').select(COLS).eq('id', t.id).eq('token_version', t.version).maybeSingle(),
    'supabase',
    'reading subscriber',
  ) as Subscriber | null;
}

export async function updatePreferences(s: Subscriber, prefs: Preferences): Promise<void> {
  const r = await db()
    .from('digest_subscribers')
    .update({ ...prefs, updated_at: new Date().toISOString() })
    .eq('id', s.id)
    .eq('token_version', s.token_version)
    .select('id');
  if (r.error) throw new ServiceError('supabase', `saving preferences: ${r.error.message}`);
}

/** Digests and alerts already queued for an address, but not sent, are dropped. */
export async function dropQueuedDigests(email: string): Promise<void> {
  const r = await db()
    .from('email_outbox')
    .delete()
    .in('kind', ['digest', 'alert'])
    .eq('to_email', email)
    .eq('status', 'queued')
    .select('id');
  if (r.error) throw new ServiceError('supabase', `dropping queued digests: ${r.error.message}`);
}

/** Removes the subscriber entirely (we don't keep the address), and any digests waiting to go to them. */
export async function unsubscribe(s: Pick<Subscriber, 'id' | 'email'>): Promise<void> {
  const r = await db().from('digest_subscribers').delete().eq('id', s.id).select('id');
  if (r.error) throw new ServiceError('supabase', `unsubscribing: ${r.error.message}`);
  await dropQueuedDigests(s.email);
}
