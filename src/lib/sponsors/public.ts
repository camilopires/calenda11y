/** Sponsors shown on the site (the public_sponsors view), cached briefly. */
import { db } from '../db.ts';
import { sponsorshipOpen } from '../env.ts';
import { unwrap } from '../result.ts';
import { publicLogoUrl } from './profile.ts';

export interface PublicSponsor {
  id: string;
  name: string;
  url: string | null;
  logoUrl: string | null;
  logoAlt: string | null;
  tier: 'donation' | 'supporter' | 'bronze' | 'silver' | 'gold';
}

let cache: { at: number; sponsors: PublicSponsor[] } | undefined;
const TTL_MS = 5 * 60_000;

export async function publicSponsors(): Promise<PublicSponsor[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.sponsors;
  const rows = unwrap(
    await db().from('public_sponsors').select('id,name,url,logo_path,logo_alt,tier').order('name'),
    'supabase',
    'listing sponsors',
  ) as Array<{
    id: string;
    name: string;
    url: string | null;
    logo_path: string | null;
    logo_alt: string | null;
    tier: PublicSponsor['tier'];
  }>;
  const sponsors = rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    logoUrl: r.logo_path ? publicLogoUrl(r.logo_path) : null,
    logoAlt: r.logo_alt,
    tier: r.tier,
  }));
  cache = { at: Date.now(), sponsors };
  return sponsors;
}

export function clearSponsorCache(): void {
  cache = undefined;
}

/** For the footer: never let a problem with sponsors break a page. */
export async function footerSponsors(): Promise<Array<{ name: string; url: string | null }>> {
  // With sponsorship switched off, nobody is listed.
  if (!sponsorshipOpen()) return [];
  try {
    return (await publicSponsors()).map((s) => ({ name: s.name, url: s.url }));
  } catch (error) {
    console.error('[sponsors] could not load sponsors for the footer', error);
    return [];
  }
}
