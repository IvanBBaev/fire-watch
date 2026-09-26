import { describe, expect, it } from 'vitest';

import {
  createPgParityReader,
  decodeParityRow,
  PARITY_READER_SQL,
  type PgParityQueryable,
} from './pg-parity-reader.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgParityQueryable {
  readonly queries: RecordedQuery[];
}

function stubDb(...results: readonly (readonly Record<string, unknown>[])[]): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      const rows = results[queries.length] ?? [];
      queries.push({ text, values });
      return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
    },
  };
}

const WINDOW = {
  fromMs: Date.parse('2026-08-20T00:00:00Z'),
  toMs: Date.parse('2026-08-21T00:00:00Z'),
};

const ROW = {
  detection_uid: 'uid-1',
  source: 'firms:viirs:snpp',
  acq_ts: new Date('2026-08-20T11:24:00Z'),
  lat: '41.85012',
  lon: '26.14003',
  quarantined: false,
};

describe('createPgParityReader', () => {
  it('reads NRT rows of the requested sources over an acq_ts window', async () => {
    const db = stubDb([ROW]);
    const rows = await createPgParityReader(db).loadNrtDetections({
      sources: ['firms:viirs:snpp', 'firms:viirs:noaa20'],
      window: WINDOW,
    });
    expect(db.queries[0]?.text).toBe(PARITY_READER_SQL.selectNrtDetections);
    expect(PARITY_READER_SQL.selectNrtDetections).toContain("product_tier = 'NRT'");
    // Quarantined rows are not filtered: they count as ingested.
    expect(PARITY_READER_SQL.selectNrtDetections).not.toContain('quarantined =');
    expect(db.queries[0]?.values).toEqual([
      ['firms:viirs:snpp', 'firms:viirs:noaa20'],
      '2026-08-20T00:00:00.000Z',
      '2026-08-21T00:00:00.000Z',
    ]);
    expect(rows).toEqual([
      {
        detectionUid: 'uid-1',
        source: 'firms:viirs:snpp',
        acqTsMs: Date.parse('2026-08-20T11:24:00Z'),
        lat: 41.85012,
        lon: 26.14003,
        quarantined: false,
      },
    ]);
  });

  it('asks nothing for no sources', async () => {
    const db = stubDb();
    expect(
      await createPgParityReader(db).loadNrtDetections({ sources: [], window: WINDOW }),
    ).toEqual([]);
    expect(db.queries).toEqual([]);
  });
});

describe('decodeParityRow', () => {
  it.each([
    ['source', 'firms:nope'],
    ['lat', 'NaN'],
    ['lon', 26.1],
    ['quarantined', 'f'],
  ])('refuses %s = %j', (column, value) => {
    expect(() => decodeParityRow({ ...ROW, [column]: value })).toThrow();
  });
});
