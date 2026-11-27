import { describe, expect, it } from 'vitest';
import { FakeGeocoder, Nominatim, placeFromNominatim } from '../../src/lib/services/geocoder.ts';

const chatham = {
  lat: '51.3807',
  lon: '0.5214',
  name: 'Chatham',
  display_name: 'Chatham, Medway, Kent, England, ME4 4TR, United Kingdom',
  address: { town: 'Chatham', county: 'Kent', state: 'England', country: 'United Kingdom', country_code: 'gb' },
};

describe('Nominatim', () => {
  it('turns an answer into a short label with its country', () => {
    expect(placeFromNominatim(chatham)).toEqual({
      label: 'Chatham, Kent, United Kingdom',
      lat: 51.3807,
      lng: 0.5214,
      countryCode: 'GB',
    });
    expect(placeFromNominatim({ lat: 'x', lon: '0' })).toBeNull();
  });

  it('asks with an identifying User-Agent, in English, best match first', async () => {
    let seen: { url: URL; headers: Record<string, string> } | undefined;
    const fake = (async (url: URL, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify([chatham]), { status: 200 });
    }) as unknown as typeof fetch;
    const places = await new Nominatim('https://geo.example/search', 'https://calenda11y.org', fake).search('Chatham');
    expect(places[0]!.label).toBe('Chatham, Kent, United Kingdom');
    expect(seen!.url.searchParams.get('q')).toBe('Chatham');
    expect(seen!.url.searchParams.get('limit')).toBe('5');
    expect(seen!.headers['User-Agent']).toBe('calenda11y/1.0 (+https://calenda11y.org)');
    expect(seen!.headers['Accept-Language']).toBe('en');
  });

  it('reports HTTP errors and network failures as service errors', async () => {
    const down = (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch;
    await expect(new Nominatim('https://geo.example/search', 'https://x', down).search('a')).rejects.toThrow(
      'HTTP 429',
    );
    const broken = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(new Nominatim('https://geo.example/search', 'https://x', broken).search('a')).rejects.toThrow(
      'offline',
    );
  });
});

describe('FakeGeocoder', () => {
  it('knows a few places, case and spacing aside, and records each search', async () => {
    const g = new FakeGeocoder();
    expect(await g.search('  MEDWAY ')).toHaveLength(2);
    expect(await g.search('Atlantis')).toEqual([]);
    expect(g.calls).toEqual(['  MEDWAY ', 'Atlantis']);
  });
});
