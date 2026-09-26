import { describe, expect, it } from 'vitest';

import type { DailyLagHistogram } from '../../core/ingest/lag-histogram.js';
import {
  createPgLagHistogramStore,
  decodeDailyRow,
  decodeLagSample,
  LAG_HISTOGRAM_SQL,
  upsertParameters,
  type PgLagHistogramQueryable,
} from './pg-lag-histogram-store.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgLagHistogramQueryable {
  readonly queries: RecordedQuery[];
}

/** Answers each query with the next scripted result, in call order. */
function stubDb(
  ...results: readonly { rows?: readonly Record<string, unknown>[]; rowCount?: number }[]
): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      const result = results[queries.length] ?? {};
      queries.push({ text, values });
      const rows = (result.rows ?? []) as Row[];
      return Promise.resolve({ rows, rowCount: result.rowCount ?? rows.length });
    },
  };
}

const DAILY: DailyLagHistogram = {
  day: '2026-08-20',
  histogram: {
    source: 'firms:viirs:snpp',
    histogramVersion: 'nrt_lag_histogram_v0',
    histogramDigest: 'abcd1234',
    edgesMinutes: [0, 10, 60],
    counts: [3, 1],
    below: 0,
    overflow: 2,
    total: 6,
    minLagMs: 60_000,
    maxLagMs: 7_200_000,
  },
};

describe('loadLagSamples', () => {
  it('reads one half-open available_at window, SP excluded', async () => {
    const db = stubDb({
      rows: [
        {
          source: 'firms:viirs:snpp',
          acq_ts: new Date('2026-08-20T10:00:00Z'),
          available_at: new Date('2026-08-20T10:07:00Z'),
        },
      ],
    });
    const samples = await createPgLagHistogramStore(db).loadLagSamples({
      fromMs: Date.parse('2026-08-20T00:00:00Z'),
      toMs: Date.parse('2026-08-21T00:00:00Z'),
    });
    expect(db.queries[0]?.text).toBe(LAG_HISTOGRAM_SQL.selectLagSamples);
    expect(LAG_HISTOGRAM_SQL.selectLagSamples).toContain("product_tier <> 'SP'");
    expect(db.queries[0]?.values).toEqual(['2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z']);
    expect(samples).toEqual([
      {
        source: 'firms:viirs:snpp',
        acqTsMs: Date.parse('2026-08-20T10:00:00Z'),
        availableAtMs: Date.parse('2026-08-20T10:07:00Z'),
      },
    ]);
  });

  it('refuses a source outside the registry', () => {
    expect(() =>
      decodeLagSample({ source: 'firms:nope', acq_ts: new Date(0), available_at: new Date(0) }),
    ).toThrow('registry');
  });
});

describe('upsertDaily', () => {
  it('sends nothing for no rows', async () => {
    const db = stubDb();
    expect(await createPgLagHistogramStore(db).upsertDaily([])).toBe(0);
    expect(db.queries).toEqual([]);
  });

  it('binds one array per column, the array columns as integer[] literals', async () => {
    const db = stubDb({ rowCount: 1 });
    expect(await createPgLagHistogramStore(db).upsertDaily([DAILY])).toBe(1);
    expect(db.queries[0]?.text).toBe(LAG_HISTOGRAM_SQL.upsertDaily);
    expect(db.queries[0]?.values).toEqual([
      ['2026-08-20'],
      ['firms:viirs:snpp'],
      ['nrt_lag_histogram_v0'],
      ['abcd1234'],
      ['{0,10,60}'],
      ['{3,1}'],
      [0],
      [2],
      [6],
      [60_000],
      [7_200_000],
    ]);
  });

  it('only replaces a row stored under the same digest', () => {
    expect(LAG_HISTOGRAM_SQL.upsertDaily).toContain(
      'WHERE h.histogram_digest = EXCLUDED.histogram_digest',
    );
  });

  it('throws when a row was not written (same version, different digest)', async () => {
    const db = stubDb({ rowCount: 0 });
    await expect(createPgLagHistogramStore(db).upsertDaily([DAILY])).rejects.toThrow(
      'different digest',
    );
  });

  it('refuses a non-integer array element before binding', () => {
    expect(() =>
      upsertParameters([{ ...DAILY, histogram: { ...DAILY.histogram, counts: [1.5, 0] } }]),
    ).toThrow('non-integer');
  });
});

describe('loadDaily', () => {
  const stored = {
    day: '2026-08-20',
    source: 'firms:viirs:snpp',
    histogram_version: 'nrt_lag_histogram_v0',
    histogram_digest: 'abcd1234',
    edges_minutes: [0, 10, 60],
    counts: [3, 1],
    below: 0,
    overflow: 2,
    total: 6,
    min_lag_ms: '60000',
    max_lag_ms: '7200000',
  };

  it('round-trips what upsertDaily wrote', async () => {
    const db = stubDb({ rows: [stored] });
    const rows = await createPgLagHistogramStore(db).loadDaily({
      fromDay: '2026-08-19',
      toDay: '2026-08-20',
      histogramVersion: 'nrt_lag_histogram_v0',
    });
    expect(db.queries[0]?.text).toBe(LAG_HISTOGRAM_SQL.selectDaily);
    expect(db.queries[0]?.values).toEqual(['nrt_lag_histogram_v0', '2026-08-19', '2026-08-20']);
    expect(rows).toEqual([DAILY]);
  });

  it('decodes null extrema and negative lags', () => {
    expect(
      decodeDailyRow({ ...stored, min_lag_ms: '-5', max_lag_ms: null }).histogram,
    ).toMatchObject({ minLagMs: -5, maxLagMs: null });
  });

  it.each([
    ['min_lag_ms', '9007199254740993'],
    ['min_lag_ms', '1.5'],
    ['counts', [1, 'x']],
    ['edges_minutes', '{0,10}'],
  ])('refuses %s = %j', (column, value) => {
    expect(() => decodeDailyRow({ ...stored, [column]: value })).toThrow();
  });
});
