import { describe, expect, it } from 'vitest';

import type { NewWatchZone } from '../../core/ports/watch-zone-store.js';
import {
  createPgWatchZoneStore,
  insertValues,
  WATCH_ZONE_SQL,
  type PgWatchZoneQueryable,
} from './pg-watch-zone-store.js';

const ACCOUNT = '44444444-0000-4000-8000-000000000001';
const ZONE = '44444444-0000-4000-8000-0000000000aa';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function stubDb(
  rows: readonly Record<string, unknown>[] = [],
  rowCount: number | null = 1,
): PgWatchZoneQueryable & { readonly queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return Promise.resolve({ rows: rows as Row[], rowCount });
    },
  };
}

function zone(overrides: Partial<NewWatchZone> = {}): NewWatchZone {
  return {
    id: ZONE,
    accountId: ACCOUNT,
    name: 'Home',
    radiusM: 10_000,
    minScore: 0.45,
    sealed: { ciphertext: new Uint8Array(44).fill(7), keyId: 'k2026a' },
    coarsened: true,
    gridVersion: 'zone_grid_v1',
    gridCell: '853:466',
    createdAtIso: '2026-08-20T05:20:00Z',
    ...overrides,
  };
}

describe('the statements', () => {
  it('never names the plaintext geometry column on the write path', () => {
    expect(WATCH_ZONE_SQL.insertZone).not.toMatch(/\barea\b/);
    expect(WATCH_ZONE_SQL.insertZone).not.toMatch(/ST_|geography|geometry/i);
  });

  it('never reads the plaintext geometry back either', () => {
    for (const sql of [WATCH_ZONE_SQL.selectForAccount, WATCH_ZONE_SQL.selectInCells]) {
      expect(sql).not.toMatch(/\barea\b/);
      expect(sql).toContain('centre_ciphertext IS NOT NULL');
      expect(sql).toContain('deleted_at IS NULL');
    }
  });

  it('reads quiet hours as HH:MM, the vocabulary the decision takes', () => {
    expect(WATCH_ZONE_SQL.selectAccountSettings).toContain("'HH24:MI'");
    expect(WATCH_ZONE_SQL.selectAccountSettings).toContain('deleted_at IS NULL');
  });
});

describe('the insert', () => {
  it('binds exactly the sealed centre, the flag and the cell — nothing numeric but radius and floor', () => {
    const values = insertValues(zone());
    expect(values).toHaveLength(11);
    const numbers = values.filter((value) => typeof value === 'number');
    expect(numbers).toEqual([10_000, 0.45]);
    expect(values[5]).toBeInstanceOf(Buffer);
  });

  it('refuses a write that did not land exactly one row', async () => {
    const db = stubDb([], 0);
    await expect(createPgWatchZoneStore(db).insert(zone())).rejects.toThrow(/exactly one row/);
  });
});

describe('reads', () => {
  const stored = {
    id: ZONE,
    account_id: ACCOUNT,
    name: 'Home',
    radius_m: 10_000,
    min_score: 0.45,
    centre_ciphertext: Buffer.alloc(44, 7),
    centre_key_id: 'k2026a',
    centre_coarsened: true,
    grid_version: 'zone_grid_v1',
    grid_cell: '853:466',
    created_at: new Date('2026-08-20T05:20:00Z'),
  };

  it('decodes a stored zone round to what was written', async () => {
    const db = stubDb([stored]);
    const [read] = await createPgWatchZoneStore(db).listForAccount(ACCOUNT);
    expect(read).toEqual(zone());
  });

  it('asks nothing of the database for an empty cell list', async () => {
    const db = stubDb([stored]);
    expect(await createPgWatchZoneStore(db).listLiveInCells('zone_grid_v1', [])).toEqual([]);
    expect(db.queries).toEqual([]);
  });

  it('refuses a row whose ciphertext is not bytes', async () => {
    const db = stubDb([{ ...stored, centre_ciphertext: 'not bytes' }]);
    await expect(createPgWatchZoneStore(db).listForAccount(ACCOUNT)).rejects.toThrow(/byte/);
  });

  it('returns null settings for a missing or deleted account', async () => {
    expect(await createPgWatchZoneStore(stubDb([])).loadAccountAlertSettings(ACCOUNT)).toBeNull();
  });
});
