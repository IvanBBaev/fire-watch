import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_PREFERENCES_SQL,
  createPgAccountPreferencesStore,
  type PgAccountPreferencesQueryable,
} from './pg-account-preferences.js';

const ACCOUNT = '55555555-0000-4000-8000-000000000001';
const AT = '2026-10-27T08:00:00.000Z';
const DOCUMENT = { schema: 'account_preferences_v1', preferences: { theme: 'dark' } };

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function stubDb(
  rows: readonly Record<string, unknown>[] = [],
): PgAccountPreferencesQueryable & { readonly queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
    },
  };
}

describe('the statements', () => {
  it('only ever moves the row from the revision the client read', () => {
    expect(ACCOUNT_PREFERENCES_SQL.updateIfRevision).toContain('revision = $4::bigint');
    expect(ACCOUNT_PREFERENCES_SQL.updateIfRevision).toContain('revision = revision + 1');
  });

  it('creates the first row without ever overwriting one', () => {
    expect(ACCOUNT_PREFERENCES_SQL.insertFirst).toContain('ON CONFLICT (account_id) DO NOTHING');
    expect(ACCOUNT_PREFERENCES_SQL.insertFirst).not.toMatch(/DO UPDATE/i);
  });

  it('reads bigint revisions as text, so none rounds', () => {
    for (const sql of Object.values(ACCOUNT_PREFERENCES_SQL)) {
      expect(sql).toContain('revision::text AS revision');
    }
  });
});

describe('createPgAccountPreferencesStore', () => {
  it('reads nothing stored as null', async () => {
    const db = stubDb();
    await expect(createPgAccountPreferencesStore(db).read(ACCOUNT)).resolves.toBeNull();
    expect(db.queries[0]?.values).toEqual([ACCOUNT]);
  });

  it('reads a stored row', async () => {
    const db = stubDb([{ revision: '7', document: DOCUMENT }]);
    await expect(createPgAccountPreferencesStore(db).read(ACCOUNT)).resolves.toEqual({
      revision: 7,
      document: DOCUMENT,
    });
  });

  it('inserts the first document at revision 1', async () => {
    const db = stubDb([{ revision: '1' }]);
    await expect(createPgAccountPreferencesStore(db).write(ACCOUNT, DOCUMENT, 0, AT)).resolves.toBe(
      1,
    );
    expect(db.queries[0]).toEqual({
      text: ACCOUNT_PREFERENCES_SQL.insertFirst,
      values: [ACCOUNT, JSON.stringify(DOCUMENT), AT],
    });
  });

  it('updates from a named revision', async () => {
    const db = stubDb([{ revision: '4' }]);
    await expect(createPgAccountPreferencesStore(db).write(ACCOUNT, DOCUMENT, 3, AT)).resolves.toBe(
      4,
    );
    expect(db.queries[0]).toEqual({
      text: ACCOUNT_PREFERENCES_SQL.updateIfRevision,
      values: [ACCOUNT, JSON.stringify(DOCUMENT), AT, '3'],
    });
  });

  it('answers null when the statement moved nothing', async () => {
    const store = createPgAccountPreferencesStore(stubDb());
    await expect(store.write(ACCOUNT, DOCUMENT, 0, AT)).resolves.toBeNull();
    await expect(store.write(ACCOUNT, DOCUMENT, 9, AT)).resolves.toBeNull();
  });

  it.each([-1, 1.5, Number.NaN])('refuses expected revision %s before any query', async (rev) => {
    const db = stubDb();
    await expect(
      createPgAccountPreferencesStore(db).write(ACCOUNT, DOCUMENT, rev, AT),
    ).rejects.toThrow();
    expect(db.queries).toHaveLength(0);
  });
});
