import { createClient } from '@supabase/supabase-js';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

export const service = () =>
  createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/** Gives the page its own client IP, so rate limits don't carry over between tests. */
export async function ownIp(page: Page): Promise<void> {
  const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  await page.setExtraHTTPHeaders({ 'x-test-client-ip': ip });
}

export async function ensureUser(email: string): Promise<string> {
  const db = service();
  const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
  const existing = list.users.find((u) => u.email === email);
  if (existing) return existing.id;
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  return data.user.id;
}

export async function ensureAdmin(email = 'admin@calenda11y.test'): Promise<string> {
  const id = await ensureUser(email);
  const { error } = await service().from('admins').upsert({ user_id: id });
  if (error) throw error;
  return email;
}

/** Signs in with a magic link, the way clicking the link in the email would. */
export async function signIn(page: Page, email: string, next = '/admin'): Promise<void> {
  const { data, error } = await service().auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const token = data.properties.hashed_token;
  await page.goto(
    `/admin/auth/callback?token_hash=${encodeURIComponent(token)}&type=magiclink&next=${encodeURIComponent(next)}`,
  );
}

const OUTBOX = '.test-outbox';

export interface SentEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

export function clearOutbox(): void {
  if (existsSync(OUTBOX)) rmSync(OUTBOX, { recursive: true });
}

export function sentEmails(): SentEmail[] {
  if (!existsSync(OUTBOX)) return [];
  return readdirSync(OUTBOX)
    .sort()
    .map((f) => JSON.parse(readFileSync(join(OUTBOX, f), 'utf8')) as SentEmail);
}

export const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A date N days from today, as YYYY-MM-DD. */
export const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Fills in the event form fields (works with or without JavaScript). */
export async function fillEventForm(
  page: Page,
  o: { title: string; online?: boolean; email?: string; startDate?: string; types?: string[] } = {
    title: 'Test event',
  },
): Promise<void> {
  await page.getByLabel('Event name').fill(o.title);
  await page.getByLabel('Summary').fill('A friendly evening about accessible design.');
  for (const t of o.types ?? ['Meetup']) await page.getByRole('checkbox', { name: t, exact: true }).check();
  await page.getByLabel('Who is running it').fill('Test Org');
  await page.getByLabel('Event website').fill('https://example.org/event');
  await page.getByRole('radio', { name: 'Yes, it has times' }).check();
  await page.getByLabel('Date', { exact: true }).fill(o.startDate ?? inDays(20));
  await page.getByLabel('Start time').fill('18:30');
  await page.getByLabel('End time').fill('20:00');
  await page.getByLabel('Time zone').selectOption('Europe/Lisbon');
  if (o.online) {
    await page.getByRole('radio', { name: 'Online', exact: true }).check();
  } else {
    await page.getByRole('radio', { name: 'In person', exact: true }).check();
    await page.getByLabel('Country').selectOption('PT');
    await page.getByLabel('Town or city').fill('Porto');
  }
  await page.getByRole('radio', { name: 'Yes, it is free' }).check();
  await page.getByRole('checkbox', { name: 'Live captions' }).check();
  await page.getByLabel('Your email address').fill(o.email ?? 'organiser@example.test');
}

/** Adds a pending event straight to the database, as an import does, with no type unless given. */
export async function insertPendingEvent(title: string, fields: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await service()
    .from('events')
    .insert({
      slug: `pending-${uniq()}`,
      title,
      summary: 'Added for a test.',
      timezone: 'UTC',
      format: 'online',
      starts_at: `${inDays(30)}T10:00:00Z`,
      ends_at: `${inDays(30)}T11:00:00Z`,
      url: 'https://example.org/pending',
      organiser: 'Test Org',
      status: 'pending',
      flags: ['needs_type'],
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  await frontOfQueue(data!.id);
  return data!.id;
}

/**
 * The review queue shows the oldest events first, 50 to a page, and earlier
 * local runs leave events behind. Giving a test's event a creation time
 * that is earlier than every earlier run's puts it on the first page.
 */
export async function frontOfQueue(id: string): Promise<void> {
  const createdAt = new Date(Date.UTC(2000, 0, 1) - (Date.now() - Date.UTC(2026, 0, 1)));
  const { error } = await service().from('events').update({ created_at: createdAt.toISOString() }).eq('id', id);
  if (error) throw error;
}
