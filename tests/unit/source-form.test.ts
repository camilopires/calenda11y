import { describe, expect, it } from 'vitest';
import { validateSource, type SourceFormValues } from '../../src/lib/imports/sourceForm.ts';

const base: SourceFormValues = {
  name: 'A11y Lisbon',
  type: 'ics',
  enabled: true,
  url: 'https://example.org/cal.ics',
  default_timezone: 'Europe/Lisbon',
  default_country: 'PT',
  lang: 'en',
  organisation_id: '',
  token: '',
  query: '',
  refresh_token: '',
};

describe('validateSource', () => {
  it('accepts an iCalendar source', () => {
    expect(validateSource(base)).toEqual({
      ok: true,
      name: 'A11y Lisbon',
      type: 'ics',
      enabled: true,
      config: {
        url: 'https://example.org/cal.ics',
        default_timezone: 'Europe/Lisbon',
        default_country: 'PT',
        lang: 'en',
      },
    });
  });

  it('refuses private and non-https feed addresses', () => {
    const r = validateSource({ ...base, url: 'https://192.168.0.10/cal.ics' });
    expect(!r.ok && r.errors.url).toMatch(/private network/);
    const http = validateSource({ ...base, url: 'http://example.org/cal.ics' });
    expect(!http.ok && http.errors.url).toMatch(/https/);
  });

  it('keeps a saved secret when the field is left blank', () => {
    const r = validateSource({ ...base, type: 'eventbrite', url: '', organisation_id: '123' }, { token: 'saved' });
    expect(r.ok && r.config.token).toBe('saved');
    const missing = validateSource({ ...base, type: 'eventbrite', url: '', organisation_id: '123' });
    expect(!missing.ok && missing.errors.token).toMatch(/token/);
  });

  it('checks the defaults', () => {
    const r = validateSource({ ...base, default_timezone: 'Nowhere/Land', default_country: 'ZZ', lang: 'xx' });
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['default_country', 'default_timezone', 'lang']);
  });
});
