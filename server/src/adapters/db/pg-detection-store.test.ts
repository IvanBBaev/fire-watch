import { describe, expect, it } from 'vitest';

import type { DetectionRecord, PollAttempt } from '../../core/ports/detection-store.js';
import {
  INSERT_DETECTIONS_SQL,
  UPSERT_SOURCE_STATUS_SQL,
  createPgDetectionStore,
  detectionArrays,
  type PgQueryable,
} from './pg-detection-store.js';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface StubDb extends PgQueryable {
  readonly queries: RecordedQuery[];
}

function stubDb(rowCount: number | null = 0): StubDb {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      return Promise.resolve({ rowCount });
    },
  };
}

function record(overrides: Partial<DetectionRecord> = {}): DetectionRecord {
  return {
    detectionUid: 'a'.repeat(64),
    source: 'firms:viirs:snpp',
    productTier: 'NRT',
    acqTsIso: '2026-08-02T11:24:00Z',
    availableAt: 1_785_670_170_000,
    lat: '41.85012',
    lon: '26.14003',
    scanKm: 0.39,
    trackKm: 0.36,
    frpMw: 12.5,
    brightnessK: 330.5,
    brightnessBgK: 295.1,
    confidenceRaw: 'n',
    confidence: 'nominal',
    dayNight: 'D',
    collectionVersion: '2.0NRT',
    sourceRegistryVersion: 'source_registry_v1',
    ingestConfigVersion: 'polling_bbox_v1',
    quarantined: false,
    ...overrides,
  };
}

function attempt(overrides: Partial<PollAttempt> = {}): PollAttempt {
  return {
    source: 'firms:viirs:snpp',
    attemptAt: 1_785_670_170_000,
    succeeded: true,
    receivedRows: 3,
    error: null,
    ...overrides,
  };
}

describe('the insert statement', () => {
  it('is an append that skips what is already there', () => {
    // The clause the whole of C1 rests on: a re-polled row is a no-op, not an update.
    expect(INSERT_DETECTIONS_SQL).toContain('ON CONFLICT (acq_ts, detection_uid) DO NOTHING');
    expect(INSERT_DETECTIONS_SQL).not.toMatch(/DO UPDATE/);
  });

  it('never writes the generated or defaulted columns', () => {
    // `geom` is GENERATED ALWAYS from lat/lon so the geometry cannot drift from the
    // hashed coordinates; supplying it would be rejected, and supplying `ingested_at`
    // would replace an observation of ours with a claim.
    expect(INSERT_DETECTIONS_SQL).not.toContain('geom');
    expect(INSERT_DETECTIONS_SQL).not.toContain('ingested_at');
  });

  it('sends one array per column, so batch size does not change the parameter count', () => {
    const parameters = new Set(INSERT_DETECTIONS_SQL.match(/\$\d+/g));

    expect(parameters.size).toBe(19);
    expect(INSERT_DETECTIONS_SQL).toContain('$18::text[]');
  });

  it('writes the breaker verdict as a column, since the runtime role cannot update it', () => {
    // ADR-002 A1.1: the app role holds SELECT and INSERT on `detections` and nothing
    // else, so `quarantined` has exactly one chance to be set — this statement.
    expect(INSERT_DETECTIONS_SQL).toContain('quarantined');
    expect(INSERT_DETECTIONS_SQL).toContain('$19::boolean[]');
  });

  it('casts the coordinates to numeric, which round-trips five decimals', () => {
    expect(INSERT_DETECTIONS_SQL).toContain('$6::numeric[], $7::numeric[]');
    expect(INSERT_DETECTIONS_SQL).not.toContain('double precision');
  });
});

describe('detectionArrays', () => {
  it('is one array per column, all of the same length', () => {
    const arrays = detectionArrays([record(), record({ detectionUid: 'b'.repeat(64) })]);

    expect(arrays).toHaveLength(19);
    for (const column of arrays) expect(column).toHaveLength(2);
  });

  it('renders available_at as a timestamp and leaves the coordinates as text', () => {
    const arrays = detectionArrays([record()]);

    expect(arrays[4]).toEqual(['2026-08-02T11:29:30.000Z']);
    expect(arrays[5]).toEqual(['41.85012']);
    expect(arrays[6]).toEqual(['26.14003']);
  });

  it('passes acq_ts through exactly as it was hashed', () => {
    expect(detectionArrays([record()])[3]).toEqual(['2026-08-02T11:24:00Z']);
  });

  it('keeps nulls null instead of collapsing them to zero', () => {
    const arrays = detectionArrays([
      record({ frpMw: null, scanKm: null, dayNight: null, collectionVersion: null }),
    ]);

    expect(arrays[7]).toEqual([null]);
    expect(arrays[9]).toEqual([null]);
    expect(arrays[14]).toEqual([null]);
    expect(arrays[15]).toEqual([null]);
  });

  it('keeps a reported zero FRP as a zero', () => {
    expect(detectionArrays([record({ frpMw: 0 })])[9]).toEqual([0]);
  });

  it('carries the breaker verdict per row, in the last column', () => {
    const arrays = detectionArrays([record({ quarantined: true }), record({ quarantined: false })]);

    expect(arrays[18]).toEqual([true, false]);
  });
});

describe('appendDetections', () => {
  it('reports what landed and what was already there', async () => {
    const db = stubDb(2);

    const result = await createPgDetectionStore(db).appendDetections([
      record(),
      record({ detectionUid: 'b'.repeat(64) }),
      record({ detectionUid: 'c'.repeat(64) }),
    ]);

    expect(result).toEqual({ received: 3, inserted: 2, alreadyPresent: 1 });
  });

  it('does not query at all for an empty batch', async () => {
    const db = stubDb(0);

    const result = await createPgDetectionStore(db).appendDetections([]);

    expect(db.queries).toHaveLength(0);
    expect(result).toEqual({ received: 0, inserted: 0, alreadyPresent: 0 });
  });

  it('treats an unknown row count as nothing inserted rather than as a crash', async () => {
    const db = stubDb(null);

    const result = await createPgDetectionStore(db).appendDetections([record()]);

    expect(result.inserted).toBe(0);
  });

  it('refuses an available_at that is not a real instant', async () => {
    const db = stubDb(1);

    await expect(
      createPgDetectionStore(db).appendDetections([record({ availableAt: Number.NaN })]),
    ).rejects.toThrow(/available_at/);
    expect(db.queries).toHaveLength(0);
  });

  it('sends the whole batch in one statement', async () => {
    const db = stubDb(2);

    await createPgDetectionStore(db).appendDetections([
      record(),
      record({ detectionUid: 'b'.repeat(64) }),
    ]);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toBe(INSERT_DETECTIONS_SQL);
    expect(db.queries[0]?.values[0]).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });
});

describe('recordPollAttempt', () => {
  it('marks a success as a success, with data', async () => {
    const db = stubDb(1);

    await createPgDetectionStore(db).recordPollAttempt(attempt());

    expect(db.queries[0]?.text).toBe(UPSERT_SOURCE_STATUS_SQL);
    expect(db.queries[0]?.values).toEqual([
      'firms:viirs:snpp',
      '2026-08-02T11:29:30.000Z',
      '2026-08-02T11:29:30.000Z',
      '2026-08-02T11:29:30.000Z',
      true,
      null,
    ]);
  });

  it('advances last_success_at but not last_data_at on a healthy empty poll', async () => {
    // February: the source is answering, there is simply nothing burning. Conflating
    // the two would make a quiet season indistinguishable from an outage.
    const db = stubDb(1);

    await createPgDetectionStore(db).recordPollAttempt(attempt({ receivedRows: 0 }));

    expect(db.queries[0]?.values[2]).toBe('2026-08-02T11:29:30.000Z');
    expect(db.queries[0]?.values[3]).toBeNull();
  });

  it('advances neither on a failure, and keeps the reason', async () => {
    const db = stubDb(1);

    await createPgDetectionStore(db).recordPollAttempt(
      attempt({ succeeded: false, receivedRows: 0, error: 'ETIMEDOUT after 30s' }),
    );

    expect(db.queries[0]?.values[2]).toBeNull();
    expect(db.queries[0]?.values[3]).toBeNull();
    expect(db.queries[0]?.values[4]).toBe(false);
    expect(db.queries[0]?.values[5]).toBe('ETIMEDOUT after 30s');
  });

  it('truncates a long failure message instead of storing a whole error page', async () => {
    const db = stubDb(1);

    await createPgDetectionStore(db).recordPollAttempt(
      attempt({ succeeded: false, error: 'x'.repeat(5000) }),
    );

    const stored = db.queries[0]?.values[5];
    expect(typeof stored).toBe('string');
    expect((stored as string).length).toBeLessThan(600);
    expect(stored as string).toContain('…');
  });

  it('carries the previous success forward rather than overwriting it', () => {
    // The statement, not the parameters, is what protects this: a failed attempt sends
    // null and COALESCE keeps whatever the row already held.
    expect(UPSERT_SOURCE_STATUS_SQL).toContain(
      'COALESCE(EXCLUDED.last_success_at, source_status.last_success_at)',
    );
    expect(UPSERT_SOURCE_STATUS_SQL).toContain(
      'COALESCE(EXCLUDED.last_data_at, source_status.last_data_at)',
    );
  });

  it('never touches the outage freeze, which is a policy decision elsewhere', () => {
    // A2.3 freezes a source's expected overpasses; that is a judgement about a sustained
    // outage, not something a single poll may flip.
    expect(UPSERT_SOURCE_STATUS_SQL).not.toContain('outage_frozen');
  });

  it('stamps updated_at from the attempt, so one cycle tells one time', () => {
    expect(UPSERT_SOURCE_STATUS_SQL).toContain('updated_at           = EXCLUDED.updated_at');
  });
});
