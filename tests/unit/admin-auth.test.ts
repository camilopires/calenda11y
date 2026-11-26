import { describe, expect, it } from 'vitest';
import { formToValues, safeNext, valuesToForm } from '../../src/lib/admin/auth.ts';

describe('safeNext', () => {
  it.each([
    ['/admin', '/admin'],
    ['/admin/events/123e4567-e89b-12d3-a456-426614174000', '/admin/events/123e4567-e89b-12d3-a456-426614174000'],
    ['/admin?status=pending', '/admin?status=pending'],
    ['https://evil.example/admin', '/admin'],
    ['//evil.example', '/admin'],
    ['/admin//evil.example', '/admin'],
    ['/submit', '/admin'],
    ['/admin/../submit', '/admin'],
    [null, '/admin'],
  ])('%s → %s', (input, out) => {
    expect(safeNext(input)).toBe(out);
  });
});

describe('form drafts', () => {
  it('keeps single and repeated values', () => {
    const f = new FormData();
    f.append('title', 'A');
    f.append('access', 'captions');
    f.append('access', 'step_free');
    const values = formToValues(f);
    expect(values).toEqual({ title: 'A', access: ['captions', 'step_free'] });
    const back = valuesToForm(values);
    expect(back.getAll('access')).toEqual(['captions', 'step_free']);
    expect(back.get('title')).toBe('A');
  });
});
