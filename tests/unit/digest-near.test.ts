import { describe, expect, it } from 'vitest';
import { preferencesToValues, readPreferences, validatePreferences } from '../../src/lib/digest/form.ts';
import { prefsToRow, rowToPrefs, describePreferences, type Preferences } from '../../src/lib/digest/subscribers.ts';

const base: Preferences = {
  cadence: 'weekly',
  countries: [],
  formats: [],
  types: [],
  topics: [],
  include_cfp: false,
  near: null,
};
const chatham = {
  lat: 51.3807,
  lng: 0.5214,
  km: 40.2336,
  radius: 25,
  unit: 'mi' as const,
  label: 'Chatham, Kent',
  includeOnline: false,
};

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  fd.set('cadence', 'weekly');
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return readPreferences(fd);
};

describe('digest places', () => {
  it('reads a resolved place from its own fields, separate from the country "online" box', () => {
    const r = validatePreferences(
      form({
        near: 'Chatham, Kent',
        near_from: 'Chatham, Kent',
        near_at: '51.3807,0.5214',
        near_u: 'mi',
        near_within: '25',
        online: 'on',
      }),
    );
    expect(r.ok && r.prefs.near).toMatchObject({
      label: 'Chatham, Kent',
      radius: 25,
      unit: 'mi',
      includeOnline: false,
    });
    expect(r.ok && r.prefs.countries).toEqual(['online']);
  });

  it('asks for a lookup when typed or edited, and drops a cleared place', () => {
    expect(validatePreferences(form({ near: 'Medway' }))).toMatchObject({ ok: true, lookup: 'Medway' });
    expect(
      validatePreferences(form({ near: 'Maidstone', near_from: 'Chatham, Kent', near_at: '51.38,0.52', near_u: 'mi' })),
    ).toMatchObject({ lookup: 'Maidstone' });
    const cleared = validatePreferences(form({ near: '', near_from: 'Chatham, Kent', near_at: '51.38,0.52' }));
    expect(cleared.ok && cleared.prefs.near).toBeNull();
  });

  it('a picked place from "Which Medway?" wins', () => {
    const r = validatePreferences(form({ near: 'Medway', near_pick: '51.38,0.52|mi|Medway, Kent, United Kingdom' }));
    expect(r.ok && r.prefs.near).toMatchObject({ lat: 51.38, label: 'Medway, Kent, United Kingdom', unit: 'mi' });
    expect(r).not.toHaveProperty('lookup');
  });

  it('stores and reads a place as flat columns, and clears them all when removed', () => {
    const row = prefsToRow({ ...base, near: chatham });
    expect(row).toMatchObject({
      near_lat: 51.3807,
      near_lng: 0.5214,
      near_km: 40.2336,
      near_unit: 'mi',
      near_label: 'Chatham, Kent',
      near_online: false,
    });
    expect(row).not.toHaveProperty('near');
    expect(prefsToRow(base)).toMatchObject({
      near_lat: null,
      near_lng: null,
      near_km: null,
      near_unit: null,
      near_label: null,
    });
    const back = rowToPrefs({
      ...row,
      cadence: 'weekly',
      countries: [],
      formats: [],
      types: [],
      topics: [],
      include_cfp: false,
    });
    expect(back.near).toMatchObject({ lat: 51.3807, radius: 25, unit: 'mi' });
  });

  it('puts the place back on the form and describes it', () => {
    const v = preferencesToValues({ ...base, near: chatham });
    expect(v).toMatchObject({ near: 'Chatham, Kent', nearAt: '51.3807,0.5214', nearUnit: 'mi', nearWithin: '25' });
    expect(describePreferences({ ...base, near: chatham })).toBe(
      'a weekly email of events within 25 miles of Chatham, Kent',
    );
  });

  it('a picked place in another unit keeps the distance chosen in miles', () => {
    const r = validatePreferences(
      form({ near: 'Lisbon', near_pick: '38.7223,-9.1393|km|Lisbon, Portugal', near_within: '50' }),
    );
    expect(r.ok && r.prefs.near).toMatchObject({ unit: 'km', radius: 100, km: 100 });
  });

  it('a long place name saves again unchanged, without another search', () => {
    const label = `${'Long Place Name '.repeat(9)}, United Kingdom`.slice(0, 160);
    const values = preferencesToValues({ ...base, near: { ...chatham, label } });
    const r = validatePreferences(
      form({
        near: values.near,
        near_from: values.nearFrom!,
        near_at: values.nearAt,
        near_u: values.nearUnit,
        near_within: values.nearWithin,
      }),
    );
    expect(r.ok && r.lookup).toBeFalsy();
    expect(r.ok && r.prefs.near?.label).toBe(label);
  });
});
