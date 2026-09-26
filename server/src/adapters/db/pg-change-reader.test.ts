import { describe, expect, it } from 'vitest';

import { isActiveMember } from '../../core/stream/change-projector.js';
import { changeRow } from '../../core/stream/test-rows.js';
import { SELECT_CHANGES, createPgChangeReader } from './pg-change-reader.js';
import { SELECT_ACTIVE_SET, type PgSnapshotReadable } from './pg-snapshot-reader.js';

interface Query {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface FakeDb extends PgSnapshotReadable {
  readonly queries: Query[];
}

function fakeDb(rows: readonly unknown[] = []): FakeDb {
  const queries: Query[] = [];
  return {
    queries,
    query(text, values) {
      queries.push({ text, values });
      return Promise.resolve({ rows });
    },
  };
}

/** A changed row exactly as `pg` hands it over: bigint as text, timestamptz as Date. */
function changedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    max_seq: '1042',
    public_id: 'fw-2026-abc123',
    seq: '1041',
    status: 'active',
    score: 0.55,
    lon: 25.123456,
    lat: 42.654321,
    started_at: new Date('2026-07-13T09:00:00Z'),
    last_detection_at: new Date('2026-07-14T09:40:00Z'),
    detection_count: 7,
    nearest_place: { name_bg: 'Карлово', name_en: 'Karlovo', lat: 42.64, lon: 24.8 },
    merged_into: null,
    display_tier: 'map',
    invalidated: false,
    ...overrides,
  };
}

const NO_CHANGE_MARKER = Object.fromEntries(
  Object.keys(changedRow()).map((key) => [key, key === 'max_seq' ? '1042' : null]),
);

describe('the change statement', () => {
  it('reads the mark and the page in one statement, bound by cursor and limit', async () => {
    const db = fakeDb([NO_CHANGE_MARKER]);
    await createPgChangeReader(db).readChangesSince(1000, 200);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toBe(SELECT_CHANGES);
    expect(db.queries[0]?.values).toEqual(['1000', 200]);
  });

  it('has no membership predicate: a row leaving the map is a change too', () => {
    const changed = /changed AS \(([\s\S]*?)\n\)/.exec(SELECT_CHANGES)?.[1] ?? '';
    expect(changed).toContain('WHERE e.seq > $1::bigint');
    expect(changed).not.toContain('display_tier =');
    expect(changed).not.toContain('merged_into IS NULL');
    expect(changed).not.toContain('NOT invalidated');
    expect(changed).toContain('ORDER BY e.seq');
    expect(changed).toContain('LIMIT $2::int');
  });

  it('resolves the survivor’s public id through a self-join, never exposing the bigint key', () => {
    expect(SELECT_CHANGES).toContain('LEFT JOIN fire_events s ON s.id = e.merged_into');
    expect(SELECT_CHANGES).toContain('s.public_id AS merged_into');
  });

  it('takes the mark over the whole registry, not over the page', () => {
    const bound = /WITH bound AS \(\s*SELECT[^)]*\)/.exec(SELECT_CHANGES)?.[0] ?? '';
    expect(bound).not.toContain('WHERE');
  });

  it('agrees with the snapshot statement on what "active" means', () => {
    // The projector decides membership in TypeScript from the three columns this statement
    // returns; the snapshot statement decides it in SQL. The two must be the same predicate,
    // or a client would be told of an event the snapshot then denies (D3 rule 2).
    const predicate = /WHERE\s+(.+?)\n\s+AND seq >/.exec(SELECT_ACTIVE_SET)?.[1];
    expect(predicate).toBe("display_tier = 'map' AND merged_into IS NULL AND NOT invalidated");
    expect(isActiveMember(changeRow())).toBe(true);
    expect(isActiveMember(changeRow({ displayTier: 'feed' }))).toBe(false);
    expect(isActiveMember(changeRow({ displayTier: 'archive' }))).toBe(false);
    expect(isActiveMember(changeRow({ mergedInto: 'fw-2026-other' }))).toBe(false);
    expect(isActiveMember(changeRow({ invalidated: true }))).toBe(false);
  });

  it('rejects a bad cursor or limit before touching the db', async () => {
    const db = fakeDb();
    const reader = createPgChangeReader(db);
    await expect(reader.readChangesSince(-1, 10)).rejects.toThrow(RangeError);
    await expect(reader.readChangesSince(1.5, 10)).rejects.toThrow(RangeError);
    await expect(reader.readChangesSince(0, 0)).rejects.toThrow(RangeError);
    await expect(reader.readChangesSince(0, 2.5)).rejects.toThrow(RangeError);
    expect(db.queries).toHaveLength(0);
  });
});

describe('decoding changes', () => {
  it('turns driver rows into change rows with the three projection columns', async () => {
    const read = await createPgChangeReader(
      fakeDb([
        changedRow(),
        changedRow({
          public_id: 'fw-2026-def456',
          seq: '1042',
          merged_into: 'fw-2026-abc123',
          display_tier: 'archive',
          invalidated: true,
        }),
      ]),
    ).readChangesSince(1040, 10);
    expect(read.maxSeq).toBe(1042);
    expect(read.rows).toEqual([
      {
        publicId: 'fw-2026-abc123',
        seq: 1041,
        status: 'active',
        score: 0.55,
        lon: 25.123456,
        lat: 42.654321,
        startedAt: Date.parse('2026-07-13T09:00:00Z'),
        lastDetectionAt: Date.parse('2026-07-14T09:40:00Z'),
        detectionCount: 7,
        nearestPlace: { name_bg: 'Карлово', name_en: 'Karlovo', lat: 42.64, lon: 24.8 },
        mergedInto: null,
        displayTier: 'map',
        invalidated: false,
      },
      expect.objectContaining({
        publicId: 'fw-2026-def456',
        seq: 1042,
        mergedInto: 'fw-2026-abc123',
        displayTier: 'archive',
        invalidated: true,
      }),
    ]);
  });

  it('reads the no-change marker as an empty page with the registry mark intact', async () => {
    const read = await createPgChangeReader(fakeDb([NO_CHANGE_MARKER])).readChangesSince(0, 10);
    expect(read).toEqual({ maxSeq: 1042, rows: [] });
  });

  it('refuses a tier outside the three, a non-boolean invalidated, or an empty result', async () => {
    await expect(
      createPgChangeReader(fakeDb([changedRow({ display_tier: 'hidden' })])).readChangesSince(0, 1),
    ).rejects.toThrow(/display_tier/);
    await expect(
      createPgChangeReader(fakeDb([changedRow({ invalidated: 'no' })])).readChangesSince(0, 1),
    ).rejects.toThrow(/invalidated/);
    await expect(createPgChangeReader(fakeDb([])).readChangesSince(0, 1)).rejects.toThrow(
      /no rows/,
    );
  });
});
