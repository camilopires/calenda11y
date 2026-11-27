/** Sponsorship tiers. Prices are in pence (GBP); yearly is 10 × monthly. */

export const TIERS = {
  supporter: {
    name: 'Supporter',
    monthly: 500,
    logo: false,
    description: 'Your name on the sponsors page and in the site footer.',
  },
  bronze: {
    name: 'Bronze',
    monthly: 2_500,
    logo: true,
    description: 'Your logo on the sponsors page, and your name in the footer.',
  },
  silver: {
    name: 'Silver',
    monthly: 10_000,
    logo: true,
    description: 'A larger logo on the sponsors page, and your name in the footer.',
  },
  gold: {
    name: 'Gold',
    monthly: 25_000,
    logo: true,
    description: 'The largest logo, first on the sponsors page, and your name in the footer.',
  },
} as const;

export type Tier = keyof typeof TIERS;
export type Interval = 'month' | 'year';
export const TIER_ORDER: Tier[] = ['gold', 'silver', 'bronze', 'supporter'];

export const CURRENCY = 'gbp';
export const DONATION_MINIMUM = 100;
/** How long a one-off donation keeps a sponsor listed. */
export const DONATION_LISTING_DAYS = 365;

export function price(tier: Tier, interval: Interval): number {
  return interval === 'year' ? TIERS[tier].monthly * 10 : TIERS[tier].monthly;
}

export const lookupKey = (tier: Tier, interval: Interval) => `c11y_${tier}_${interval}`;
export const DONATION_LOOKUP_KEY = 'c11y_donation';

export function formatPounds(pence: number): string {
  return `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: pence % 100 ? 2 : 0 })}`;
}

export function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && v in TIERS;
}

/** Finds which tier and interval a price lookup key means. */
export function fromLookupKey(key: string | null | undefined): { tier: Tier; interval: Interval } | null {
  const m = /^c11y_(supporter|bronze|silver|gold)_(month|year)$/.exec(key ?? '');
  return m ? { tier: m[1] as Tier, interval: m[2] as Interval } : null;
}
