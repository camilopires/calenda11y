/** Sponsor profiles: who can edit them, checking what's sent, and logos. */
import { randomUUID } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import type { AstroCookies } from 'astro';
import { db } from '../db.ts';
import { env } from '../env.ts';
import type { FieldErrors } from '../forms/errors.ts';
import { isHttpsUrl } from '../forms/event.ts';
import { ServiceError, unwrap, unwrapMaybe } from '../result.ts';
import { hmac, safeEqual, sha256 } from '../security/tokens.ts';

export const SESSION_COOKIE = 'sponsor_session';
// Long and renewed on every visit, so a sponsor in the middle of editing is
// never signed out (WCAG 2.2.5). It only grants editing their own profile.
const SESSION_HOURS = 24 * 30;
export const MAX_LOGO_BYTES = 1024 * 1024;
export const MAX_LOGO_PIXELS = 2000;

/**
 * After a one-time link is used, a signed cookie lets the sponsor edit their
 * profile. It carries the sponsor's session version: an admin can bump that
 * to sign the sponsor out everywhere. A fresh sign-in uses the current
 * version; renewing keeps the version the cookie already had, so a signed-out
 * browser can't renew itself back in.
 */
export function startSession(cookies: AstroCookies, sponsorId: string, version: number): void {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  const sig = hmac('sponsor-session', `${sponsorId}:${version}:${exp}`);
  cookies.set(SESSION_COOKIE, `${sponsorId}.${version}.${exp}.${sig}`, {
    path: '/sponsor',
    httpOnly: true,
    sameSite: 'lax',
    secure: env().APP_ENV === 'production',
    maxAge: SESSION_HOURS * 3600,
  });
}

/** The sponsor and session version the cookie was signed for, if it's genuine and unexpired. */
export function sessionSponsor(cookies: AstroCookies): { id: string; version: number } | null {
  const m = /^([0-9a-f-]{36})\.(\d{1,9})\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(cookies.get(SESSION_COOKIE)?.value ?? '');
  if (!m) return null;
  const [, id, version, exp, sig] = m;
  if (Number(exp) < Date.now()) return null;
  return safeEqual(sig!, hmac('sponsor-session', `${id}:${version}:${exp}`))
    ? { id: id!, version: Number(version) }
    : null;
}

/** The signed-in sponsor, if the cookie is valid and they haven't been signed out since. */
export async function signedInSponsor(cookies: AstroCookies): Promise<{ sponsor: SponsorRow; version: number } | null> {
  const session = sessionSponsor(cookies);
  if (!session) return null;
  const sponsor = await getSponsor(session.id);
  return sponsor && sponsor.session_version === session.version ? { sponsor, version: session.version } : null;
}

/** Uses a one-time profile or portal token. */
export async function redeem(purpose: 'sponsor_profile' | 'sponsor_portal', token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  return unwrapMaybe(
    await db().rpc('redeem_token', { p_purpose: purpose, p_hash: sha256(token) }),
    'supabase',
    'redeeming token',
  ) as string | null;
}

export interface SponsorRow {
  id: string;
  stripe_customer_id: string;
  contact_email: string | null;
  name: string | null;
  url: string | null;
  logo_alt: string | null;
  staged_logo_path: string | null;
  profile_status: 'none' | 'pending' | 'approved' | 'rejected';
  rejection_reason: string | null;
  approved_name: string | null;
  approved_url: string | null;
  approved_logo_path: string | null;
  approved_logo_alt: string | null;
  /** Changes on every profile edit; used to approve exactly what was reviewed. */
  updated_at: string;
  /** Bumped to sign the sponsor out everywhere. */
  session_version: number;
}

const COLS =
  'id,stripe_customer_id,contact_email,name,url,logo_alt,staged_logo_path,profile_status,rejection_reason,approved_name,approved_url,approved_logo_path,approved_logo_alt,updated_at,session_version';

export async function getSponsor(id: string): Promise<SponsorRow | null> {
  return unwrapMaybe(
    await db().from('sponsors').select(COLS).eq('id', id).maybeSingle(),
    'supabase',
    'reading sponsor',
  ) as SponsorRow | null;
}

export interface ProfileValues {
  name: string;
  url: string;
  logo_alt: string;
  remove_logo: boolean;
}

export function validateProfile(v: ProfileValues, hasLogo: boolean): FieldErrors {
  const errors: FieldErrors = {};
  if (!v.name) errors.name = 'Enter the name to show';
  else if (v.name.length > 120) errors.name = 'The name must be 120 characters or fewer';
  if (v.url && !isHttpsUrl(v.url)) errors.url = 'Enter the website address in full, starting with https://';
  if (hasLogo && !v.logo_alt)
    errors.logo_alt = "Describe the logo, usually with the organisation's name, for people who cannot see it";
  if (v.logo_alt.length > 200) errors.logo_alt = 'The description must be 200 characters or fewer';
  return errors;
}

export type LogoResult = { ok: true; webp: Buffer } | { ok: false; error: string };

/**
 * Checks an uploaded logo by actually decoding it (not trusting its name or
 * type), then re-encodes it as WebP, which also strips any metadata or
 * embedded content.
 */
export async function processLogo(file: File): Promise<LogoResult> {
  if (file.size === 0) return { ok: false, error: 'The file is empty' };
  if (file.size > MAX_LOGO_BYTES) return { ok: false, error: 'The logo must be 1 MB or smaller' };
  const input = Buffer.from(await file.arrayBuffer());
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_LOGO_PIXELS * MAX_LOGO_PIXELS }).metadata();
  } catch {
    return { ok: false, error: 'The logo must be a PNG, JPEG or WebP image' };
  }
  if (!meta.format || !['png', 'jpeg', 'webp'].includes(meta.format))
    return { ok: false, error: 'The logo must be a PNG, JPEG or WebP image' };
  if (!meta.width || !meta.height || meta.width > MAX_LOGO_PIXELS || meta.height > MAX_LOGO_PIXELS) {
    return { ok: false, error: `The logo must be at most ${MAX_LOGO_PIXELS} × ${MAX_LOGO_PIXELS} pixels` };
  }
  const webp = await sharp(input)
    .resize({ width: 800, height: 400, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 })
    .toBuffer();
  return { ok: true, webp };
}

/**
 * Saves a submitted profile for review. A new logo goes to the private
 * staging bucket under a new name. Returns false (nothing saved) if the
 * sponsor was signed out since the session was checked.
 */
export async function submitProfile(
  sponsor: SponsorRow,
  v: ProfileValues,
  logo: Buffer | null,
  sessionVersion: number,
): Promise<boolean> {
  let staged = v.remove_logo ? null : sponsor.staged_logo_path;
  if (logo) {
    staged = `${sponsor.id}/${randomUUID()}.webp`;
    const up = await db()
      .storage.from('sponsor-staging')
      .upload(staged, logo, { contentType: 'image/webp', upsert: false });
    if (up.error) throw new ServiceError('storage', `uploading logo: ${up.error.message}`);
  }
  const saved = unwrap(
    await db()
      .from('sponsors')
      .update({
        name: v.name,
        url: v.url || null,
        logo_alt: staged ? v.logo_alt : null,
        staged_logo_path: staged,
        profile_status: 'pending',
        rejection_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sponsor.id)
      .eq('session_version', sessionVersion)
      .select('id'),
    'supabase',
    'saving profile',
  ) as Array<{ id: string }>;
  if (saved.length) return true;
  // Signed out meanwhile: the new logo isn't used, so don't keep it.
  if (logo && staged) await db().storage.from('sponsor-staging').remove([staged]);
  return false;
}

/**
 * Publishes a reviewed profile, but only if it hasn't changed since the admin
 * saw it (`reviewedVersion` is its updated_at then). The logo is copied to
 * the public bucket under a name never used before. Returns false if the
 * profile changed, so the admin can look again.
 */
export async function approveProfile(sponsor: SponsorRow, reviewedVersion: string): Promise<boolean> {
  if (sponsor.updated_at !== reviewedVersion) return false;
  let publicPath: string | null = null;
  if (sponsor.staged_logo_path) {
    const file = await db().storage.from('sponsor-staging').download(sponsor.staged_logo_path);
    if (file.error) throw new ServiceError('storage', `reading staged logo: ${file.error.message}`);
    publicPath = `${randomUUID()}.webp`;
    const up = await db()
      .storage.from('sponsor-logos')
      .upload(publicPath, Buffer.from(await file.data.arrayBuffer()), { contentType: 'image/webp', upsert: false });
    if (up.error) throw new ServiceError('storage', `publishing logo: ${up.error.message}`);
  }
  const saved = unwrap(
    await db()
      .from('sponsors')
      .update({
        approved_name: sponsor.name,
        approved_url: sponsor.url,
        approved_logo_path: publicPath,
        approved_logo_alt: publicPath ? sponsor.logo_alt : null,
        approved_at: new Date().toISOString(),
        profile_status: 'approved',
      })
      .eq('id', sponsor.id)
      .eq('updated_at', reviewedVersion)
      .select('id'),
    'supabase',
    'approving profile',
  ) as Array<{ id: string }>;
  if (saved.length === 1) return true;
  // The profile changed between reading and saving: don't leave an unused public copy.
  if (publicPath) await db().storage.from('sponsor-logos').remove([publicPath]);
  return false;
}

export function publicLogoUrl(path: string): string {
  return db().storage.from('sponsor-logos').getPublicUrl(path).data.publicUrl;
}

export async function stagedLogoUrl(path: string): Promise<string | null> {
  const r = await db().storage.from('sponsor-staging').createSignedUrl(path, 600);
  return r.error ? null : r.data.signedUrl;
}
