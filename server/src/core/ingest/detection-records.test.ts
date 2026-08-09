import { describe, expect, it } from 'vitest';

import type { SourceId } from '@fire-watch/contracts';

import type { FirmsAreaQuery } from '../ports/firms-client.js';
import { detectionRecords, pollAttempt } from './detection-records.js';
import type { FirmsPollRun, IngestedDetection } from './firms-poller.js';

const QUERY: FirmsAreaQuery = {
  source: 'firms:viirs:snpp',
  product: 'VIIRS_SNPP_NRT',
  area: '20,39,31,46',
  dayRange: 2,
};

function detection(overrides: Partial<IngestedDetection> = {}): IngestedDetection {
  return {
    rowIndex: 1,
    raw: 'BGR,41.85012,26.14003,330.5,0.39,0.36,2026-08-02,1124,N,VIIRS,n,2.0NRT,295.1,12.5,D',
    source: 'firms:viirs:snpp',
    acqTsIso: '2026-08-02T11:24:00Z',
    latCanonical: '41.85012',
    lonCanonical: '26.14003',
    uidPreimage: 'firms:viirs:snpp|2026-08-02T11:24:00Z|41.85012|26.14003',
    confidence: 'nominal',
    confidenceRaw: 'n',
    frpMw: 12.5,
    dayNight: 'D',
    scanKm: 0.39,
    trackKm: 0.36,
    brightnessK: 330.5,
    brightnessSecondaryK: 295.1,
    satelliteRaw: 'N',
    instrumentRaw: 'VIIRS',
    versionRaw: '2.0NRT',
    detectionUid: 'a'.repeat(64),
    availableAt: 1_785_670_170_000,
    ...overrides,
  };
}

function run(overrides: Partial<FirmsPollRun> = {}): FirmsPollRun {
  return {
    source: 'firms:viirs:snpp',
    outcome: 'ok',
    query: QUERY,
    pollingBboxVersion: 'polling_bbox_v1',
    sourceRegistryVersion: 'source_registry_v1',
    availableAt: 1_785_670_170_000,
    detections: [detection()],
    rejections: [],
    duplicatesWithinBatch: 0,
    ...overrides,
  };
}

describe('detectionRecords', () => {
  it('carries every field the archive stores', () => {
    expect(detectionRecords(run())).toEqual([
      {
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
      },
    ]);
  });

  it('marks every row of a batch the breaker tripped on', () => {
    // The verdict is a property of the batch, not of the row: a flood is recognized by
    // its size, and there is no way to tell which of its rows are the suspect ones.
    const records = detectionRecords(
      run({ detections: [detection(), detection({ detectionUid: 'b'.repeat(64) })] }),
      { quarantined: true },
    );

    expect(records.map((record) => record.quarantined)).toEqual([true, true]);
  });

  it('stores the coordinates as the text that was hashed, not as numbers', () => {
    // A trailing zero that survives to the database is the difference between a row
    // whose uid can be recomputed from its columns and one whose uid cannot.
    const [record] = detectionRecords(
      run({ detections: [detection({ latCanonical: '41.85000', lonCanonical: '-0.10000' })] }),
    );

    expect(record?.lat).toBe('41.85000');
    expect(record?.lon).toBe('-0.10000');
  });

  it('takes the tier from the registry', () => {
    const [record] = detectionRecords(run({ source: 'firms:viirs:noaa21' }));

    expect(record?.productTier).toBe('NRT');
  });

  it('refuses to guess a tier for an archive-only source', () => {
    // MODIS is retired: any batch attributed to it is a backfill, and a backfill that
    // silently claimed NRT would put reprocessed rows in the archive as live ones.
    expect(() => detectionRecords(run({ source: 'firms:modis' }))).toThrow(/product tier/);
  });

  it('accepts an explicit tier for the backfill', () => {
    const [record] = detectionRecords(run({ source: 'firms:modis' }), { productTier: 'SP' });

    expect(record?.productTier).toBe('SP');
  });

  it('distinguishes a reported zero FRP from an unreported one', () => {
    const records = detectionRecords(
      run({ detections: [detection({ frpMw: 0 }), detection({ frpMw: null })] }),
    );

    expect(records.map((record) => record.frpMw)).toEqual([0, null]);
  });

  it('writes a missing collection version as null rather than an empty string', () => {
    const [record] = detectionRecords(run({ detections: [detection({ versionRaw: '' })] }));

    expect(record?.collectionVersion).toBeNull();
  });

  it('keeps the poll order, which is the fixed batch order', () => {
    const records = detectionRecords(
      run({
        detections: [
          detection({ detectionUid: 'b'.repeat(64), lonCanonical: '26.10000' }),
          detection({ detectionUid: 'c'.repeat(64), lonCanonical: '26.20000' }),
        ],
      }),
    );

    expect(records.map((record) => record.detectionUid)).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
  });

  it('produces nothing for a failed run', () => {
    expect(detectionRecords(run({ outcome: 'failed', availableAt: null, detections: [] }))).toEqual(
      [],
    );
  });
});

describe('pollAttempt', () => {
  const NOW = 1_785_670_200_000;

  it('timestamps a successful attempt from available_at, not from the clock', () => {
    // The two differ by however long the write path took, and `available_at` is the one
    // the freshness surface compares against.
    expect(pollAttempt(run(), NOW)).toEqual({
      source: 'firms:viirs:snpp',
      attemptAt: 1_785_670_170_000,
      succeeded: true,
      receivedRows: 1,
      error: null,
    });
  });

  it('timestamps an unanswered attempt from the clock, because nothing became available', () => {
    const attempt = pollAttempt(
      run({
        outcome: 'failed',
        error: 'ETIMEDOUT after 30s',
        availableAt: null,
        detections: [],
      }),
      NOW,
    );

    expect(attempt).toEqual({
      source: 'firms:viirs:snpp',
      attemptAt: NOW,
      succeeded: false,
      receivedRows: 0,
      error: 'ETIMEDOUT after 30s',
    });
  });

  it('reports a healthy empty poll as a success with no rows', () => {
    // Not an outage. February has empty polls all month and the archive must say so.
    const attempt = pollAttempt(run({ detections: [] }), NOW);

    expect(attempt.succeeded).toBe(true);
    expect(attempt.receivedRows).toBe(0);
    expect(attempt.error).toBeNull();
  });

  it('keeps a parse failure attributable to the moment the body arrived', () => {
    // The source answered — it just answered with something unreadable — so the attempt
    // is stamped with the response's own instant rather than with the clock.
    const attempt = pollAttempt(
      run({
        outcome: 'failed',
        error: 'missing column: latitude',
        availableAt: 1_785_670_100_000,
        detections: [],
      }),
      NOW,
    );

    expect(attempt.attemptAt).toBe(1_785_670_100_000);
    expect(attempt.succeeded).toBe(false);
  });

  it('is defined for every source the registry knows', () => {
    const sources: readonly SourceId[] = ['firms:viirs:noaa20', 'lsasaf:seviri:frp-pixel'];

    for (const source of sources) {
      expect(pollAttempt(run({ source }), NOW).source).toBe(source);
    }
  });
});
