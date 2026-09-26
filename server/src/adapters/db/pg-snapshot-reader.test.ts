import { describe, expect, it } from 'vitest';

import {
  SELECT_ACTIVE_SET,
  SELECT_SOURCE_OBSERVATIONS,
  createPgSnapshotReader,
  type PgSnapshotReadable,
} from './pg-snapshot-reader.js';

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

/** A member row exactly as `pg` hands it over: bigint as text, timestamptz as Date. */
function memberRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    max_seq: '1042',
    public_id: 'fw-2026-abc123',
    seq: '1040',
    status: 'active',
    score: 0.55,
    lon: 25.123456,
    lat: 42.654321,
    started_at: new Date('2026-07-13T09:00:00Z'),
    last_detection_at: new Date('2026-07-14T09:40:00Z'),
    detection_count: 7,
    nearest_place: { name_bg: 'Карлово', name_en: 'Karlovo', lat: 42.64, lon: 24.8 },
    ...overrides,
  };
}

const EMPTY_MARKER = {
  max_seq: '1042',
  public_id: null,
  seq: null,
  status: null,
  score: null,
  lon: null,
  lat: null,
  started_at: null,
  last_detection_at: null,
  detection_count: null,
  nearest_place: null,
};

describe('the active-set statement', () => {
  it('reads the mark and the members in one statement, bound by the cursor', async () => {
    const db = fakeDb([EMPTY_MARKER]);
    await createPgSnapshotReader(db).readActiveSet(1000);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toBe(SELECT_ACTIVE_SET);
    expect(db.queries[0]?.values).toEqual(['1000']);
  });

  it('selects on the migration-004 projection and never on the clock', () => {
    expect(SELECT_ACTIVE_SET).toContain(
      "display_tier = 'map' AND merged_into IS NULL AND NOT invalidated",
    );
    expect(SELECT_ACTIVE_SET).toContain('seq > $1::bigint');
    expect(SELECT_ACTIVE_SET).toContain('coalesce(max(seq), 0)');
    expect(SELECT_ACTIVE_SET).not.toMatch(
      /now\(\)|interval|status_changed_at|last_detection_at\s*[<>]/,
    );
  });

  it('takes the mark over the whole registry, not over the members', () => {
    // The `bound` CTE has no WHERE: a removed event's bump must move the mark.
    const bound = /WITH bound AS \(\s*SELECT[^)]*\)/.exec(SELECT_ACTIVE_SET)?.[0] ?? '';
    expect(bound).not.toContain('WHERE');
  });

  it('rejects a cursor that is not a non-negative safe integer before touching the db', async () => {
    const db = fakeDb();
    const reader = createPgSnapshotReader(db);
    await expect(reader.readActiveSet(-1)).rejects.toThrow(RangeError);
    await expect(reader.readActiveSet(1.5)).rejects.toThrow(RangeError);
    expect(db.queries).toHaveLength(0);
  });
});

describe('decoding the active set', () => {
  it('turns driver rows into event rows with seq as a number and instants as epoch ms', async () => {
    const read = await createPgSnapshotReader(fakeDb([memberRow()])).readActiveSet(0);
    expect(read.maxSeq).toBe(1042);
    expect(read.events).toEqual([
      {
        publicId: 'fw-2026-abc123',
        seq: 1040,
        status: 'active',
        score: 0.55,
        lon: 25.123456,
        lat: 42.654321,
        startedAt: Date.parse('2026-07-13T09:00:00Z'),
        lastDetectionAt: Date.parse('2026-07-14T09:40:00Z'),
        detectionCount: 7,
        nearestPlace: { name_bg: 'Карлово', name_en: 'Karlovo', lat: 42.64, lon: 24.8 },
      },
    ]);
  });

  it('reads the empty marker as no events with the registry mark intact', async () => {
    const read = await createPgSnapshotReader(fakeDb([EMPTY_MARKER])).readActiveSet(0);
    expect(read).toEqual({ maxSeq: 1042, events: [] });
  });

  it('reads an empty registry as mark 0', async () => {
    const read = await createPgSnapshotReader(
      fakeDb([{ ...EMPTY_MARKER, max_seq: '0' }]),
    ).readActiveSet(0);
    expect(read).toEqual({ maxSeq: 0, events: [] });
  });

  it('tolerates a missing or malformed place as no place', async () => {
    const rows = [
      memberRow({ nearest_place: null }),
      memberRow({ public_id: 'b', seq: '1041', nearest_place: { name_bg: 'x' } }),
    ];
    const read = await createPgSnapshotReader(fakeDb(rows)).readActiveSet(0);
    expect(read.events.map((event) => event.nearestPlace)).toEqual([null, null]);
  });

  it('refuses a status outside the lifecycle vocabulary', async () => {
    const reader = createPgSnapshotReader(fakeDb([memberRow({ status: 'smouldering' })]));
    await expect(reader.readActiveSet(0)).rejects.toThrow(/outside the lifecycle/);
  });

  it('refuses a seq past the safe-integer range instead of rounding it', async () => {
    const reader = createPgSnapshotReader(fakeDb([memberRow({ seq: '9007199254740993' })]));
    await expect(reader.readActiveSet(0)).rejects.toThrow(/safe integer/);
  });

  it('refuses a result with no rows at all — the mark row must always be there', async () => {
    await expect(createPgSnapshotReader(fakeDb([])).readActiveSet(0)).rejects.toThrow(/no rows/);
  });
});

describe('source observations', () => {
  it('asks for the newest acq_ts per requested source, in request order', async () => {
    const db = fakeDb([
      { source: 'firms:viirs:snpp', acq_ts: new Date('2026-07-14T09:40:00Z') },
      { source: 'firms:modis', acq_ts: null },
    ]);
    const rows = await createPgSnapshotReader(db).readSourceObservations([
      'firms:viirs:snpp',
      'firms:modis',
    ]);
    expect(db.queries[0]?.text).toBe(SELECT_SOURCE_OBSERVATIONS);
    expect(db.queries[0]?.values).toEqual([['firms:viirs:snpp', 'firms:modis']]);
    expect(rows).toEqual([
      { sourceId: 'firms:viirs:snpp', lastObservedAt: Date.parse('2026-07-14T09:40:00Z') },
      { sourceId: 'firms:modis', lastObservedAt: null },
    ]);
  });

  it('reads observation time, never poll time', () => {
    expect(SELECT_SOURCE_OBSERVATIONS).toContain('ORDER BY acq_ts DESC LIMIT 1');
    expect(SELECT_SOURCE_OBSERVATIONS).not.toMatch(/ingested_at|available_at|source_status/);
  });

  it('skips the round trip for an empty request', async () => {
    const db = fakeDb();
    expect(await createPgSnapshotReader(db).readSourceObservations([])).toEqual([]);
    expect(db.queries).toHaveLength(0);
  });
});
