import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  dateWindow,
  effectiveFormats,
  filtersToParams,
  parseFilters,
  type FilterableQuery,
} from '../../src/lib/events/predicates.ts';

const parse = (qs: string) => parseFilters(new URLSearchParams(qs));

class Recorder implements FilterableQuery {
  calls: Array<[string, ...unknown[]]> = [];
  eq(c: string, v: unknown) {
    this.calls.push(['eq', c, v]);
    return this;
  }
  in(c: string, v: readonly unknown[]) {
    this.calls.push(['in', c, v]);
    return this;
  }
  gte(c: string, v: unknown) {
    this.calls.push(['gte', c, v]);
    return this;
  }
  lte(c: string, v: unknown) {
    this.calls.push(['lte', c, v]);
    return this;
  }
  gt(c: string, v: unknown) {
    this.calls.push(['gt', c, v]);
    return this;
  }
  lt(c: string, v: unknown) {
    this.calls.push(['lt', c, v]);
    return this;
  }
  textSearch(c: string, q: string, o: unknown) {
    this.calls.push(['textSearch', c, q, o]);
    return this;
  }
}

const NOW = '2026-11-26T12:00:00.000Z';
const TODAY = '2026-11-26';

describe('parseFilters', () => {
  it('defaults to all upcoming events', () => {
    const r = parse('');
    expect(r.errors).toEqual({});
    expect(r.active).toBe(false);
    expect(r.filters).toEqual({ formats: [], range: 'upcoming', access: [], when: 'upcoming', page: 1 });
  });

  it('parses every filter', () => {
    const r = parse('country=gb&format=hybrid&format=online&price=free&access=captions&access=step_free&q=pdf&page=2');
    expect(r.errors).toEqual({});
    expect(r.active).toBe(true);
    expect(r.filters).toMatchObject({
      country: 'GB',
      formats: ['hybrid', 'online'],
      price: 'free',
      access: ['captions', 'step_free'],
      q: 'pdf',
      page: 2,
    });
  });

  it('accepts "online" as a country choice', () => {
    expect(parse('country=online').filters.country).toBe('online');
  });

  it('reports invalid values against their fields and keeps the valid ones', () => {
    const r = parse('country=ZZ&format=space&price=cheap&access=jetpack&range=forever&page=0&country2=x&format=online');
    expect(r.errors).toEqual({
      country: 'Choose a country from the list',
      format: 'Choose a format from the list',
      price: 'Choose free or paid',
      access: 'Choose access provisions from the list',
      range: 'Choose when from the list',
      page: 'That page number does not exist',
    });
    expect(r.filters.formats).toEqual(['online']);
    expect(r.filters.country).toBeUndefined();
  });

  it('removes duplicate values', () => {
    expect(parse('format=online&format=online').filters.formats).toEqual(['online']);
  });

  it('handles custom date ranges', () => {
    expect(parse('range=custom&from=2027-01-01&to=2027-01-31').filters).toMatchObject({
      range: 'custom',
      from: '2027-01-01',
      to: '2027-01-31',
    });
    expect(parse('from=2027-01-01').filters).toMatchObject({ range: 'custom', from: '2027-01-01' });
    expect(parse('range=custom').errors).toEqual({ from: 'Enter a start date, an end date, or both' });
    expect(parse('from=2027-02-30').errors.from).toMatch(/real date/);
    expect(parse('from=2027-02-01&to=2027-01-01').errors.to).toMatch(/after the start date/);
  });

  it('limits the search length', () => {
    expect(parse(`q=${'a'.repeat(101)}`).errors.q).toMatch(/100 characters/);
  });

  it('switches to past events', () => {
    expect(parse('when=past').filters.when).toBe('past');
  });
});

describe('dateWindow', () => {
  it('covers the rest of this month', () => {
    expect(dateWindow(parse('range=this-month').filters, TODAY)).toEqual({ from: TODAY, to: '2026-11-30' });
  });
  it('covers the next 3 months', () => {
    expect(dateWindow(parse('range=3-months').filters, TODAY)).toEqual({ from: TODAY, to: '2027-02-25' });
  });
  it('is open for upcoming', () => {
    expect(dateWindow(parse('').filters, TODAY)).toEqual({});
  });
});

describe('applyFilters', () => {
  it('only shows events that have not ended', () => {
    const q = applyFilters(new Recorder(), parse('').filters, NOW, TODAY);
    expect(q.calls).toEqual([['gt', 'end_instant', NOW]]);
  });

  it('builds conditions for every filter', () => {
    const q = applyFilters(
      new Recorder(),
      parse('country=PT&format=in_person&from=2026-12-01&to=2026-12-31&price=paid&access=captions&q=design').filters,
      NOW,
      TODAY,
    );
    expect(q.calls).toEqual([
      ['eq', 'country_code', 'PT'],
      ['in', 'format', ['in_person']],
      ['gt', 'end_instant', NOW],
      ['gte', 'local_end_date', '2026-12-01'],
      ['lte', 'local_start_date', '2026-12-31'],
      ['eq', 'price', 'paid'],
      ['eq', 'captions', true],
      ['textSearch', 'search', 'design', { type: 'websearch', config: 'simple' }],
    ]);
  });

  it('treats "online" as online or hybrid events', () => {
    expect(effectiveFormats(parse('country=online').filters)).toEqual(['online', 'hybrid']);
    expect(effectiveFormats(parse('country=online&format=in_person').filters)).toEqual([]);
    expect(effectiveFormats(parse('country=online&format=hybrid').filters)).toEqual(['hybrid']);
  });

  it('shows past events', () => {
    const q = applyFilters(new Recorder(), parse('when=past').filters, NOW, TODAY);
    expect(q.calls).toEqual([['lt', 'end_instant', NOW]]);
  });
});

describe('filtersToParams', () => {
  it('round-trips through parseFilters', () => {
    const original = parse('country=GB&format=online&access=captions&q=pdf&from=2027-01-01&page=3').filters;
    const again = parseFilters(filtersToParams(original)).filters;
    expect(again).toEqual(original);
  });

  it('can drop or override the page', () => {
    const f = parse('country=GB&page=3').filters;
    expect(filtersToParams(f, { includePage: false }).toString()).toBe('country=GB');
    expect(filtersToParams(f, { page: 4 }).toString()).toBe('country=GB&page=4');
  });
});
