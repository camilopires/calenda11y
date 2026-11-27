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
const SESSION_HOURS = 24;
export const MAX_LOGO_BYTES = 1024 * 1024;
export const MAX_LOGO_PIXELS = 2000;

/** After a one-time link is used, a signed cookie lets the sponsor edit for 24 hours. */
export function startSession(cookies: AstroCookies, sponsorId: string): void {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  cookies.set(SESSION_COOKIE, `${sponsorId}.${exp}.${hmac('sponsor-session', `${sponsorId}:${exp}`)}`, {
    path: '/sponsor',
    httpOnly: true,
    sameSite: 'lax',
    secure: env().APP_ENV === 'production',
    maxAge: SESSION_HOURS * 3600,
  });
}

export function sessionSponsor(cookies: AstroCookies): string | null {
  const m = /^([0-9a-f-]{36})\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(cookies.get(SESSION_COOKIE)?.value ?? '');
  if (!m) return null;
  const [, id, exp, sig] = m;
  if (Number(exp) < Date.now()) return null;
  return safeEqual(sig!, hmac('sponsor-session', `${id}:${exp}`)) ? id! : null;
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
}

const COLS =
  'id,stripe_customer_id,contact_email,name,url,logo_alt,staged_logo_path,profile_status,rejection_reason,approved_name,approved_url,approved_logo_path,approved_logo_alt';

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

/** Saves a submitted profile for review. A new logo goes to the private staging bucket under a new name. */
export async function submitProfile(sponsor: SponsorRow, v: ProfileValues, logo: Buffer | null): Promise<void> {
  let staged = v.remove_logo ? null : sponsor.staged_logo_path;
  if (logo) {
    staged = `${sponsor.id}/${randomUUID()}.webp`;
    const up = await db()
      .storage.from('sponsor-staging')
      .upload(staged, logo, { contentType: 'image/webp', upsert: false });
    if (up.error) throw new ServiceError('storage', `uploading logo: ${up.error.message}`);
  }
  unwrap(
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
      .select('id'),
    'supabase',
    'saving profile',
  );
}

/** Publishes a reviewed profile. The logo is copied to the public bucket under a name never used before. */
export async function approveProfile(sponsor: SponsorRow): Promise<void> {
  let publicPath = sponsor.approved_logo_path;
  if (sponsor.staged_logo_path) {
    const file = await db().storage.from('sponsor-staging').download(sponsor.staged_logo_path);
    if (file.error) throw new ServiceError('storage', `reading staged logo: ${file.error.message}`);
    publicPath = `${randomUUID()}.webp`;
    const up = await db()
      .storage.from('sponsor-logos')
      .upload(publicPath, Buffer.from(await file.data.arrayBuffer()), { contentType: 'image/webp', upsert: false });
    if (up.error) throw new ServiceError('storage', `publishing logo: ${up.error.message}`);
  } else {
    publicPath = null;
  }
  unwrap(
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
      .select('id'),
    'supabase',
    'approving profile',
  );
}

export function publicLogoUrl(path: string): string {
  return db().storage.from('sponsor-logos').getPublicUrl(path).data.publicUrl;
}

export async function stagedLogoUrl(path: string): Promise<string | null> {
  const r = await db().storage.from('sponsor-staging').createSignedUrl(path, 600);
  return r.error ? null : r.data.signedUrl;
}
