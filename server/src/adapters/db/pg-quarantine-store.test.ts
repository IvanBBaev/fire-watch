import { describe, expect, it } from 'vitest';

import type { IngestBatchRecord, QuarantineEntry } from '../../core/ports/quarantine-store.js';
import {
  INSERT_BATCH_SQL,
  INSERT_QUARANTINE_SQL,
  SELECT_RECENT_BATCHES_SQL,
  createPgQuarantineStore,
  quarantineArrays,
  type PgReadable,
} from './pg-quarantine-store.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgReadable {
  readonly queries: RecordedQuery[];
}

function stubDb(rows: readonly unknown[] = []): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return Promise.resolve({ rows });
    },
  };
}

const AVAILABLE_AT = 1_785_670_170_000; // 2026-08-02T11:29:30Z

function batch(overrides: Partial<IngestBatchRecord> = {}): IngestBatchRecord {
  return {
    source: 'firms:viirs:snpp',
    availableAt: AVAILABLE_AT,
    received: 2100,
    inserted: 37,
    alreadyPresent: 2063,
    rejected: 0,
    quarantined: 0,
    anomalyVerdict: 'within_baseline',
    anomalyTripped: false,
    baseline: 2000,
    ratio: 1.05,
    ingestConfigVersion: 'ingest_anomaly_v1',
    pollingBboxVersion: 'polling_bbox_v1',
    sourceRegistryVersion: 'source_registry_v1',
    ...overrides,
  };
}

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    source: 'firms:viirs:snpp',
    availableAt: AVAILABLE_AT,
    scope: 'row',
    rowIndex: 4,
    detectionUid: null,
    reason: 'latitude is not a number: "N/A"',
    raw: 'BGR,N/A,26.140027,330.5',
    ...overrides,
  };
}

describe('the batch statement', () => {
  it('is idempotent on the pair that identifies a response', () => {
    // A cycle re-run after a crash between the append and the batch record must not
    // append a second history entry — the breaker's baseline is built from these rows.
    expect(INSERT_BATCH_SQL).toContain('ON CONFLICT (source, available_at) DO NOTHING');
  });

  it('never updates, because a recorded verdict is evidence', () => {
    expect(INSERT_BATCH_SQL).not.toContain('DO UPDATE');
  });
});

describe('the quarantine statement', () => {
  it('inserts through unnest, so a wholly invalid response fits in one statement', () => {
    // The case that produces thousands of entries at once is exactly the case that must
    // not run into the 65,535-parameter wire limit.
    expect(INSERT_QUARANTINE_SQL).toContain('unnest(');
    expect(INSERT_QUARANTINE_SQL).toContain('$7::text[]');
    expect(INSERT_QUARANTINE_SQL).not.toContain('$8');
  });

  it('skips an entry it has already recorded', () => {
    expect(INSERT_QUARANTINE_SQL).toContain(
      'ON CONFLICT (source, available_at, scope, row_index) DO NOTHING',
    );
  });
});

describe('recordBatch', () => {
  it('binds the counts and the verdict in the statement order', async () => {
    const db = stubDb();

    await createPgQuarantineStore(db).recordBatch(batch());

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.values).toEqual([
      'firms:viirs:snpp',
      '2026-08-02T11:29:30.000Z',
      2100,
      37,
      2063,
      0,
      0,
      'within_baseline',
      false,
      2000,
      1.05,
      'ingest_anomaly_v1',
      'polling_bbox_v1',
      'source_registry_v1',
    ]);
  });

  it('passes an absent baseline through as null rather than a zero', async () => {
    // Zero is a real baseline — twelve successful polls that all came back empty — and
    // the CHECK on ingest_batches would reject it against `not_enough_history` anyway.
    const db = stubDb();

    await createPgQuarantineStore(db).recordBatch(
      batch({ anomalyVerdict: 'not_enough_history', baseline: null, ratio: null }),
    );

    expect(db.queries[0]?.values.slice(9, 11)).toEqual([null, null]);
  });

  it('refuses an available_at that is not an instant', async () => {
    const db = stubDb();

    await expect(
      createPgQuarantineStore(db).recordBatch(batch({ availableAt: Number.NaN })),
    ).rejects.toThrow(RangeError);
    expect(db.queries).toHaveLength(0);
  });
});

describe('quarantine', () => {
  it('does not open a round trip for the healthy case', async () => {
    const db = stubDb();

    await createPgQuarantineStore(db).quarantine([]);

    expect(db.queries).toHaveLength(0);
  });

  it('sends one array per column', async () => {
    const db = stubDb();

    await createPgQuarantineStore(db).quarantine([entry(), entry({ rowIndex: 9 })]);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.values).toHaveLength(7);
    expect(db.queries[0]?.values[3]).toEqual([4, 9]);
  });

  it('keeps the delivered bytes verbatim', () => {
    const raw = 'BGR,999.5,26.140027,330.5,0.39,0.36,2026-08-02,1124,N,VIIRS,n,2.0NRT,295.1,12.5,D';

    const [, , , , , , raws] = quarantineArrays([entry({ raw })]);

    expect(raws).toEqual([raw]);
  });

  it('carries a batch-scope entry with nothing to point at', () => {
    const arrays = quarantineArrays([
      entry({ scope: 'batch', rowIndex: null, raw: null, reason: 'above_baseline: 45× of 2000' }),
    ]);

    expect(arrays[2]).toEqual(['batch']);
    expect(arrays[3]).toEqual([null]);
    expect(arrays[6]).toEqual([null]);
  });

  it('truncates a reason that has stopped being a reason', () => {
    const [, , , , , reasons] = quarantineArrays([entry({ reason: 'x'.repeat(1500) })]);
    const [reason] = reasons as string[];

    expect(reason).toHaveLength(1001);
    expect(reason?.endsWith('…')).toBe(true);
  });
});

describe('recentBatchSizes', () => {
  it('reads the newest polls first, capped at the window', async () => {
    const db = stubDb([{ received: 2100 }, { received: 1980 }]);

    const sizes = await createPgQuarantineStore(db).recentBatchSizes('firms:viirs:snpp', 24);

    expect(sizes).toEqual([2100, 1980]);
    expect(db.queries[0]?.text).toBe(SELECT_RECENT_BATCHES_SQL);
    expect(db.queries[0]?.values).toEqual(['firms:viirs:snpp', 24]);
    expect(SELECT_RECENT_BATCHES_SQL).toContain('ORDER BY available_at DESC');
  });

  it('is empty for a source that has never been polled', async () => {
    const db = stubDb([]);

    expect(await createPgQuarantineStore(db).recentBatchSizes('firms:viirs:noaa21', 24)).toEqual(
      [],
    );
  });

  it('refuses a window that is not a window', async () => {
    const db = stubDb([]);
    const store = createPgQuarantineStore(db);

    await expect(store.recentBatchSizes('firms:viirs:snpp', 0)).rejects.toThrow(RangeError);
    await expect(store.recentBatchSizes('firms:viirs:snpp', 2.5)).rejects.toThrow(RangeError);
  });

  it('refuses a count the driver handed back as something other than a number', async () => {
    // A `bigint` column, or a type parser change, would otherwise make every baseline NaN
    // and quietly disarm the breaker for good.
    const db = stubDb([{ received: '2100' }]);

    await expect(
      createPgQuarantineStore(db).recentBatchSizes('firms:viirs:snpp', 24),
    ).rejects.toThrow(TypeError);
  });
});
