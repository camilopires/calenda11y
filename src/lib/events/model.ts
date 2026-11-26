/** The shape of a row in the public_events view, and labels for its values. */

export const FORMATS = ['in_person', 'online', 'hybrid'] as const;
export type Format = (typeof FORMATS)[number];

export const PRICES = ['free', 'paid'] as const;
export type Price = (typeof PRICES)[number];

export const ACCESS_PROVISIONS = [
  'captions',
  'sign_language',
  'step_free',
  'quiet_room',
  'hearing_loop',
  'remote_attendance',
] as const;
export type AccessProvision = (typeof ACCESS_PROVISIONS)[number];

export const FORMAT_LABELS: Record<Format, string> = {
  in_person: 'In person',
  online: 'Online',
  hybrid: 'In person and online',
};

export const PRICE_LABELS: Record<Price, string> = { free: 'Free', paid: 'Paid' };

export const ACCESS_LABELS: Record<AccessProvision, string> = {
  captions: 'Live captions',
  sign_language: 'Sign language interpretation',
  step_free: 'Step-free venue',
  quiet_room: 'Quiet room',
  hearing_loop: 'Hearing loop',
  remote_attendance: 'Can join online',
};

export interface PublicEvent {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string | null;
  lang: string;
  all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string;
  local_start_date: string;
  local_end_date: string;
  start_instant: string;
  end_instant: string;
  format: Format;
  country_code: string | null;
  city: string | null;
  venue: string | null;
  url: string | null;
  organiser: string | null;
  price: Price;
  captions: boolean;
  sign_language: boolean;
  step_free: boolean;
  quiet_room: boolean;
  hearing_loop: boolean;
  remote_attendance: boolean;
  access_notes: string | null;
  status: 'approved' | 'cancelled';
  sequence: number;
  approved_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
}

/** Columns selected from public_events (everything except the search vector). */
export const PUBLIC_EVENT_COLUMNS =
  'id,slug,title,summary,description,lang,all_day,starts_at,ends_at,start_date,end_date,timezone,' +
  'local_start_date,local_end_date,start_instant,end_instant,format,country_code,city,venue,url,organiser,price,' +
  'captions,sign_language,step_free,quiet_room,hearing_loop,remote_attendance,access_notes,status,sequence,' +
  'approved_at,cancelled_at,updated_at';

export function accessProvisions(e: Pick<PublicEvent, AccessProvision>): AccessProvision[] {
  return ACCESS_PROVISIONS.filter((p) => e[p]);
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}
