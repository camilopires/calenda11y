import { describe, expect, it } from 'vitest';
import { anon, rest, service, signedInUser } from './helpers.ts';

const TABLES = ['events', 'events_private', 'event_duplicates', 'import_sources', 'admins', 'countries'];
const VIEWS = ['public_events', 'public_country_counts'];

describe('database access for anon and signed-in users', () => {
  it.each([...TABLES, ...VIEWS])('anon cannot read %s through the REST API', async (name) => {
    const res = await rest(`${name}?select=*&limit=1`);
    // 401/403 with "permission denied", or 404 when the table is hidden from the schema cache.
    expect([401, 403, 404]).toContain(res.status);
  });

  it.each(TABLES)('anon cannot insert into %s', async (name) => {
    const res = await rest(name, { method: 'POST', body: JSON.stringify({}) });
    expect([401, 403, 404]).toContain(res.status);
  });

  it('a signed-in user who is not an admin cannot read anything either', async () => {
    const { token } = await signedInUser();
    for (const name of [...TABLES, ...VIEWS]) {
      const res = await rest(`${name}?select=*&limit=1`, { token });
      expect([401, 403, 404], name).toContain(res.status);
    }
  });

  it('anon cannot call database functions', async () => {
    const res = await rest('rpc/is_valid_timezone', { method: 'POST', body: JSON.stringify({ tz: 'UTC' }) });
    expect([401, 403, 404]).toContain(res.status);
  });

  it('the anon client gets an error, not data, for events', async () => {
    const { data, error } = await anon().from('events').select('id').limit(1);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe('public_events view', () => {
  it('only contains approved and cancelled events', async () => {
    const { data, error } = await service().from('public_events').select('status');
    expect(error).toBeNull();
    const statuses = new Set(data!.map((r) => r.status));
    expect([...statuses].sort()).toEqual(['approved', 'cancelled']);
  });

  it('never exposes private or moderation columns', async () => {
    for (const column of [
      'submitter_email',
      'pending_changes',
      'flags',
      'source_snapshot',
      'source_uid',
      'source_id',
    ]) {
      const { error } = await service().from('public_events').select(column).limit(1);
      expect(error?.message, column).toMatch(/does not exist/);
    }
  });
});
