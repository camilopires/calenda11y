/** Turns checked event values into "Check your answers" rows. */
import {
  ACCESS_LABELS,
  FORMAT_LABELS,
  PRICE_LABELS,
  countryName,
  type AccessProvision,
  type Format,
  type Price,
} from '../events/model.ts';
import { describeWhen } from '../events/dates.ts';
import { fieldId } from './errors.ts';
import { languageName, type EventFormValues, type EventRecord } from './event.ts';

export interface AnswerRow {
  label: string;
  value: string | string[];
  /** Field id to return to, e.g. "f-title". */
  field: string;
  lang?: string | undefined;
}

export function eventAnswerRows(v: EventFormValues, r: EventRecord, localStart: string, localEnd: string): AnswerRow[] {
  const when = describeWhen({ ...r, local_start_date: localStart, local_end_date: localEnd });
  const place =
    r.format === 'online'
      ? 'Online'
      : [r.venue, r.city, r.country_code ? countryName(r.country_code) : null].filter(Boolean).join(', ');
  return [
    { label: 'Event name', value: r.title, field: fieldId('title'), lang: r.lang },
    { label: 'Summary', value: r.summary, field: fieldId('summary'), lang: r.lang },
    { label: 'More details', value: r.description ?? '', field: fieldId('description'), lang: r.lang },
    { label: 'Language', value: languageName(r.lang), field: fieldId('lang') },
    { label: 'Who is running it', value: r.organiser, field: fieldId('organiser') },
    { label: 'Event website', value: r.url, field: fieldId('url') },
    { label: 'When', value: `${when.date}, ${when.time}`, field: fieldId('timing') },
    { label: 'Time zone', value: v.timezone.replace(/_/g, ' '), field: fieldId('timezone') },
    { label: 'How people attend', value: FORMAT_LABELS[r.format as Format], field: fieldId('format') },
    { label: 'Where', value: place, field: fieldId(r.format === 'online' ? 'format' : 'country') },
    { label: 'Price', value: PRICE_LABELS[r.price as Price], field: fieldId('price') },
    {
      label: 'Access provisions',
      value: (Object.keys(ACCESS_LABELS) as AccessProvision[]).filter((a) => r[a]).map((a) => ACCESS_LABELS[a]),
      field: fieldId('access'),
    },
    { label: 'Access details', value: r.access_notes ?? '', field: fieldId('access_notes'), lang: r.lang },
  ];
}

/** The local first and last day of a checked event (what the database trigger would work out). */
export function localDates(r: EventRecord): { start: string; end: string } {
  if (r.all_day && r.start_date && r.end_date) {
    const end = new Date(`${r.end_date}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - 1);
    return { start: r.start_date, end: end.toISOString().slice(0, 10) };
  }
  const day = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: r.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  return { start: day(r.starts_at!), end: day(new Date(Date.parse(r.ends_at!) - 1).toISOString()) };
}
