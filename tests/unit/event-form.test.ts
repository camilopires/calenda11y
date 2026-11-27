import { describe, expect, it } from 'vitest';
import {
  EMPTY_EVENT_FORM,
  isEmail,
  isHttpsUrl,
  newSlug,
  readEventForm,
  recordToForm,
  slugify,
  validateEvent,
  validateSubmitter,
  type EventFormValues,
} from '../../src/lib/forms/event.ts';

const NOW = new Date('2026-11-26T12:00:00Z');

const valid = (overrides: Partial<EventFormValues> = {}): EventFormValues => ({
  ...EMPTY_EVENT_FORM,
  title: 'Lisbon meetup',
  summary: 'Short talks.',
  organiser: 'A11y Lisboa',
  url: 'https://example.org/lisbon',
  timing: 'timed',
  start_date: '2026-12-03',
  start_time: '18:30',
  end_time: '20:30',
  timezone: 'Europe/Lisbon',
  format: 'in_person',
  country: 'PT',
  city: 'Lisbon',
  price: 'free',
  access: ['captions', 'step_free'],
  types: ['meetup', 'talk'],
  ...overrides,
});

describe('event types on the form', () => {
  it('keeps the chosen types, once each, in the order of the list', () => {
    const r = validateEvent(valid({ types: ['talk', 'meetup', 'talk'] }), { now: NOW });
    expect(r.ok && r.record.types).toEqual(['meetup', 'talk']);
  });

  it('needs at least one type', () => {
    const r = validateEvent(valid({ types: [] }), { now: NOW });
    expect(!r.ok && r.errors.type).toBe('Choose at least one type of event');
  });

  it('refuses types that are not on the list', () => {
    const r = validateEvent(valid({ types: ['party'] }), { now: NOW });
    expect(!r.ok && r.errors.type).toBe('Choose types from the list');
  });

  it('reads repeated type fields from the form, and turns stored types back into form values', () => {
    const fd = new FormData();
    fd.append('type', 'conference');
    fd.append('type', 'workshop');
    expect(readEventForm(fd).types).toEqual(['conference', 'workshop']);
    const r = validateEvent(valid({ types: ['conference', 'workshop'] }), { now: NOW });
    if (!r.ok) throw new Error('expected valid');
    expect(recordToForm(r.record).types).toEqual(['conference', 'workshop']);
    expect(EMPTY_EVENT_FORM.types).toEqual([]);
  });
});

describe('validateEvent', () => {
  it('accepts a complete timed event and converts the times to UTC', () => {
    const r = validateEvent(valid(), { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record).toMatchObject({
      all_day: false,
      starts_at: '2026-12-03T18:30:00.000Z',
      ends_at: '2026-12-03T20:30:00.000Z',
      country_code: 'PT',
      captions: true,
      step_free: true,
      sign_language: false,
      description: null,
    });
  });

  it('accepts an all-day event and stores an exclusive end date', () => {
    const r = validateEvent(valid({ timing: 'all_day', start_time: '', end_time: '', end_date: '2026-12-04' }), {
      now: NOW,
    });
    expect(r.ok && r.record).toMatchObject({
      all_day: true,
      start_date: '2026-12-03',
      end_date: '2026-12-05',
      starts_at: null,
    });
  });

  it('treats a blank end date as the same day', () => {
    const r = validateEvent(valid({ timing: 'all_day', start_time: '', end_time: '' }), { now: NOW });
    expect(r.ok && r.record.end_date).toBe('2026-12-04');
  });

  it('handles events that run past midnight', () => {
    const r = validateEvent(valid({ end_date: '2026-12-04', end_time: '01:00' }), { now: NOW });
    expect(r.ok && r.record.ends_at).toBe('2026-12-04T01:00:00.000Z');
  });

  it('drops the place for online events', () => {
    const r = validateEvent(valid({ format: 'online', country: '', city: 'Ignored', venue: 'Ignored' }), { now: NOW });
    expect(r.ok && r.record).toMatchObject({ country_code: null, city: null, venue: null });
  });

  it('reports every missing required field', () => {
    const r = validateEvent({ ...EMPTY_EVENT_FORM, lang: 'en' }, { now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors)).toEqual(
      expect.arrayContaining([
        'title',
        'summary',
        'organiser',
        'url',
        'timing',
        'start_date',
        'type',
        'timezone',
        'format',
        'price',
      ]),
    );
  });

  it.each<[string, Partial<EventFormValues>, string, RegExp]>([
    ['an http URL', { url: 'http://example.org' }, 'url', /starting with https/],
    ['a URL with credentials', { url: 'https://user:pw@example.org' }, 'url', /https/],
    ['a summary over 280 characters', { summary: 'x'.repeat(281) }, 'summary', /280 characters/],
    ['an unknown language', { lang: 'xx' }, 'lang', /language/],
    ['a bad time', { start_time: '25:00' }, 'start_time', /24-hour clock/],
    ['an end before the start', { end_time: '17:00' }, 'end_time', /end after it starts/],
    ['an end date before the start date', { end_date: '2026-12-01' }, 'end_date', /same as or after/],
    ['a past event', { start_date: '2026-11-20' }, 'end_time', /already ended/],
    [
      'a time skipped by daylight saving',
      { start_date: '2027-03-28', start_time: '01:30', timezone: 'Europe/London', country: 'GB' },
      'start_time',
      /clocks change/,
    ],
    ['an unknown time zone', { timezone: 'Mars/Base' }, 'timezone', /from the list/],
    ['no country for an in-person event', { country: '' }, 'country', /country the event is in/],
    ['an unknown country', { country: 'ZZ' }, 'country', /from the list/],
    ['no city for an in-person event', { city: '' }, 'city', /town or city/],
    ['an unknown access provision', { access: ['teleport'] }, 'access', /from the list/],
    ['no timing choice', { timing: '' }, 'timing', /start and end times/],
  ])('rejects %s', (_label, overrides, field, message) => {
    const r = validateEvent(valid(overrides), { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[field]).toMatch(message);
  });

  it('lets admins save events that have ended', () => {
    expect(validateEvent(valid({ start_date: '2026-11-20' }), { now: NOW, allowPast: true }).ok).toBe(true);
  });
});

describe('validateSubmitter', () => {
  it('needs a valid email', () => {
    expect(validateSubmitter({ name: '', email: '' })).toEqual({ submitter_email: 'Enter your email address' });
    expect(validateSubmitter({ name: '', email: 'nope' }).submitter_email).toMatch(/right format/);
    expect(validateSubmitter({ name: 'Ana', email: 'ana@example.org' })).toEqual({});
  });
});

describe('helpers', () => {
  it('checks emails and URLs', () => {
    expect(isEmail('a.b+c@example.co.uk')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(isEmail('<a>@example.org')).toBe(false);
    expect(isHttpsUrl('https://example.org/path?q=1')).toBe(true);
    expect(isHttpsUrl('https://localhost')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
  });

  it('makes readable slugs', () => {
    expect(slugify('Encontro de Acessibilidade — São Paulo!')).toBe('encontro-de-acessibilidade-sao-paulo');
    expect(slugify('ウェブ')).toBe('event');
    expect(newSlug('A B', () => 'k3x9q2')).toBe('a-b-k3x9q2');
  });

  it('turns a stored event back into the same form values', () => {
    const r = validateEvent(valid({ end_date: '2026-12-04', end_time: '01:00' }), { now: NOW });
    if (!r.ok) throw new Error('expected valid');
    const back = recordToForm(r.record);
    expect(back).toMatchObject({
      start_date: '2026-12-03',
      start_time: '18:30',
      end_date: '2026-12-04',
      end_time: '01:00',
      access: ['captions', 'step_free'],
    });

    const allDay = validateEvent(valid({ timing: 'all_day', start_time: '', end_time: '', end_date: '2026-12-04' }), {
      now: NOW,
    });
    if (!allDay.ok) throw new Error('expected valid');
    expect(recordToForm(allDay.record)).toMatchObject({
      timing: 'all_day',
      start_date: '2026-12-03',
      end_date: '2026-12-04',
    });
  });
});

describe('call for speakers on the form', () => {
  // NOW is 2026-11-26; the event is on 2026-12-03 in Lisbon.
  it('is optional, and saved when given', () => {
    const none = validateEvent(valid(), { now: NOW });
    expect(none.ok && none.record).toMatchObject({ cfp_url: null, cfp_closes_on: null });
    const r = validateEvent(valid({ cfp_url: 'https://cfp.example/apply', cfp_closes_on: '2026-11-30' }), { now: NOW });
    expect(r.ok && r.record).toMatchObject({ cfp_url: 'https://cfp.example/apply', cfp_closes_on: '2026-11-30' });
  });

  it.each([
    [{ cfp_url: 'http://cfp.example' }, 'cfp_url', 'Enter the link in full, starting with https://'],
    [{ cfp_url: `https://e.example/${'a'.repeat(483)}` }, 'cfp_url', 'The link must be 500 characters or fewer'],
    [{ cfp_closes_on: '2026-11-30' }, 'cfp_closes_on', 'Add the link to apply, or remove the date'],
    [
      { cfp_url: 'https://cfp.example', cfp_closes_on: '2026-02-30' },
      'cfp_closes_on',
      'Enter the last day as a real date',
    ],
    [
      { cfp_url: 'https://cfp.example', cfp_closes_on: '2026-12-04' },
      'cfp_closes_on',
      'The last day to apply must be on or before the day the event starts',
    ],
    [
      { cfp_url: 'https://cfp.example', cfp_closes_on: '2026-11-25' },
      'cfp_closes_on',
      'That call for speakers has already closed',
    ],
  ])('%j → %s: %s', (over, field, message) => {
    const r = validateEvent(valid(over), { now: NOW });
    expect(!r.ok && r.errors[field]).toBe(message);
  });

  it('allows exactly 500 characters', () => {
    const url = `https://e.example/${'a'.repeat(500 - 'https://e.example/'.length)}`;
    expect(url).toHaveLength(500);
    expect(validateEvent(valid({ cfp_url: url }), { now: NOW }).ok).toBe(true);
  });

  it('stores the link in its standard form, so odd spellings and hidden line breaks never reach the database', () => {
    const upper = validateEvent(valid({ cfp_url: 'HTTPS://CFP.example/Apply' }), { now: NOW });
    expect(upper.ok && upper.record.cfp_url).toBe('https://cfp.example/Apply');
    const sneaky = validateEvent(valid({ cfp_url: 'https://cfp.example/apply\nSTATUS:CANCELLED' }), { now: NOW });
    expect(sneaky.ok && sneaky.record.cfp_url).not.toMatch(/[\r\n]/);
  });

  it('admins can keep a date that has passed', () => {
    const r = validateEvent(valid({ cfp_url: 'https://cfp.example', cfp_closes_on: '2026-11-25' }), {
      now: NOW,
      allowPast: true,
    });
    expect(r.ok).toBe(true);
  });

  it('round-trips through the form', () => {
    const r = validateEvent(valid({ cfp_url: 'https://cfp.example', cfp_closes_on: '2026-11-30' }), { now: NOW });
    if (!r.ok) throw new Error('expected valid');
    expect(recordToForm(r.record)).toMatchObject({ cfp_url: 'https://cfp.example/', cfp_closes_on: '2026-11-30' });
    expect(EMPTY_EVENT_FORM).toMatchObject({ cfp_url: '', cfp_closes_on: '' });
  });
});

describe('topics on the form', () => {
  it('are optional, kept in list order, once each', () => {
    const none = validateEvent(valid(), { now: NOW });
    expect(none.ok && none.record.topics).toEqual([]);
    const r = validateEvent(valid({ topics: ['law', 'testing', 'law'] }), { now: NOW });
    expect(r.ok && r.record.topics).toEqual(['testing', 'law']);
  });

  it('refuses topics that are not on the list', () => {
    const r = validateEvent(valid({ topics: ['cooking'] }), { now: NOW });
    expect(!r.ok && r.errors.topic).toBe('Choose topics from the list');
  });

  it('are read from repeated fields and round-trip', () => {
    const fd = new FormData();
    fd.append('topic', 'mobile');
    fd.append('topic', 'content');
    expect(readEventForm(fd).topics).toEqual(['mobile', 'content']);
    const r = validateEvent(valid({ topics: ['mobile'] }), { now: NOW });
    if (!r.ok) throw new Error('expected valid');
    expect(recordToForm(r.record).topics).toEqual(['mobile']);
    expect(EMPTY_EVENT_FORM.topics).toEqual([]);
  });
});
