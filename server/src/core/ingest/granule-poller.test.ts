import { describe, expect, it } from 'vitest';

import { detectionUid } from '@fire-watch/contracts/node';

import type { DecodeResult, GranuleDecoder, GranuleRef } from '../ports/granule-decoder.js';
import type { GranuleFetch, GranuleSource } from '../ports/granule-source.js';
import { granuleDetectionRecords, granulePollAttempt } from './detection-records.js';
import { GRANULE_PAYLOAD_FORMAT } from './granule-payload.js';
import { pollGranuleSlot, type PollGranuleDeps } from './granule-poller.js';

const SOURCE = 'lsasaf:seviri:frp-pixel';
const SLOT = '2026-08-02T11:15:00Z';
const AVAILABLE_AT = 1_785_670_170_000;
const BYTES = new Uint8Array([0x89, 0x48, 0x44, 0x46]);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lat: 41.85012,
    lon: 26.14003,
    acq: SLOT,
    confidence: 'nominal',
    confidenceRaw: '2',
    frpMw: 42.5,
    scanKm: 4.8,
    trackKm: 5.6,
    brightnessK: null,
    brightnessBgK: null,
    ...overrides,
  };
}

function payload(rows: readonly Record<string, unknown>[] = [row()]): string {
  return JSON.stringify({
    format: GRANULE_PAYLOAD_FORMAT,
    source: SOURCE,
    kind: 'frp',
    slot: SLOT,
    detections: rows,
  });
}

function source(fetch: Partial<GranuleFetch> = {}): GranuleSource {
  return {
    fetchSlot: () =>
      Promise.resolve({
        outcome: 'ok',
        bytes: BYTES,
        name: 'HDF5_LSASAF_MSG_FRP-PIXEL_MSG-Disk_202608021115',
        availableAt: AVAILABLE_AT,
        error: null,
        ...fetch,
      }),
  };
}

function decoder(result: Partial<DecodeResult> = {}): GranuleDecoder {
  return {
    decode: (_ref: GranuleRef) =>
      Promise.resolve({
        outcome: 'ok',
        payload: payload(),
        error: null,
        durationMs: 12,
        bytesOut: 128,
        ...result,
      }),
  };
}

function deps(overrides: Partial<PollGranuleDeps> = {}): PollGranuleDeps {
  return { granules: source(), decoder: decoder(), detectionUid, ...overrides };
}

describe('a slot that decodes', () => {
  it('produces identified rows stamped with the moment the granule arrived', async () => {
    const run = await pollGranuleSlot(SOURCE, SLOT, deps());

    expect(run.outcome).toBe('ok');
    expect(run.availableAt).toBe(AVAILABLE_AT);
    expect(run.detections).toHaveLength(1);
    expect(run.detections[0]?.detectionUid).toBe(
      detectionUid({ source: SOURCE, acqTsIso: SLOT, lat: '41.85012', lon: '26.14003' }),
    );
    expect(run.quarantine).toBeNull();
  });

  it('drops the rest of the disk, which is most of it', async () => {
    // LSA-502 sees from Iceland to South Africa. Unfiltered, one slot would be thousands
    // of permanent rows about fires nobody here asked about.
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({
        decoder: decoder({
          payload: payload([
            row(),
            row({ lat: -1.5, lon: 30.0 }),
            row({ lat: 41.9, lon: 2.1 }),
            row({ lat: 45.0, lon: 30.9 }),
          ]),
        }),
      }),
    );

    expect(run.detections).toHaveLength(2);
    expect(run.outsideBbox).toBe(2);
  });

  it('collapses rows that canonicalize onto the same pixel and counts them', async () => {
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({ decoder: decoder({ payload: payload([row(), row({ lat: 41.850124 })]) }) }),
    );

    expect(run.detections).toHaveLength(1);
    expect(run.duplicatesWithinBatch).toBe(1);
  });

  it('rejects one unusable row without losing the granule', async () => {
    // The payload check knows nothing about the uid's rules, so the poller is the only
    // place where one row can be dropped without the rest of the slot going with it.
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({
        decoder: decoder({ payload: payload([row({ lon: 26.5 }), row()]) }),
        detectionUid: (parts) => {
          if (parts.lon === '26.50000') throw new RangeError('longitude is unusable');
          return detectionUid(parts);
        },
      }),
    );

    expect(run.outcome).toBe('ok');
    expect(run.detections).toHaveLength(1);
    expect(run.rejections).toEqual([{ rowIndex: 1, reason: 'longitude is unusable' }]);
  });

  it('orders the batch, so two runs of one slot are byte-identical', async () => {
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({
        decoder: decoder({
          payload: payload([row({ lon: 26.5 }), row({ lat: 41.0 }), row({ lon: 26.1 })]),
        }),
      }),
    );

    expect(run.detections.map((detection) => detection.latCanonical)).toEqual([
      '41.00000',
      '41.85012',
      '41.85012',
    ]);
    expect(run.detections.map((detection) => detection.lonCanonical)).toEqual([
      '26.14003',
      '26.10000',
      '26.50000',
    ]);
  });
});

describe('a slot that does not', () => {
  it('records an absent granule as a gap, not as a failure', async () => {
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({
        granules: source({ outcome: 'missing', bytes: null, name: null, error: 'HTTP 404' }),
      }),
    );

    expect(run.outcome).toBe('missing');
    expect(run.detections).toEqual([]);
    expect(run.quarantine).toBeNull();
  });

  it('records a fetch failure as ours', async () => {
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({
        granules: source({
          outcome: 'failed',
          bytes: null,
          availableAt: null,
          error: 'ETIMEDOUT after 30s',
        }),
      }),
    );

    expect(run.outcome).toBe('failed');
    expect(run.error).toBe('ETIMEDOUT after 30s');
    expect(run.availableAt).toBeNull();
  });

  it('survives a source port that throws instead of answering', async () => {
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({
        granules: {
          fetchSlot: () => Promise.reject(new Error('connection reset')),
        },
      }),
    );

    expect(run.outcome).toBe('failed');
    expect(run.error).toBe('connection reset');
  });

  it('keeps the bytes of a granule that killed the decoder', async () => {
    // The whole reason the sandbox reports instead of throwing: the cycle continues, and
    // the file that did it is still there to be looked at.
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({
        decoder: decoder({
          outcome: 'crashed',
          payload: null,
          error: 'decoder was terminated by SIGSEGV',
        }),
      }),
    );

    expect(run.outcome).toBe('undecodable');
    expect(run.quarantine?.bytes).toBe(BYTES);
    expect(run.quarantine?.reason).toContain('SIGSEGV');
    expect(run.detections).toEqual([]);
  });

  it('quarantines a payload that is not about this granule', async () => {
    const lying = JSON.stringify({
      format: GRANULE_PAYLOAD_FORMAT,
      source: 'firms:viirs:snpp',
      kind: 'frp',
      slot: SLOT,
      detections: [row()],
    });

    const run = await pollGranuleSlot(SOURCE, SLOT, deps({ decoder: decoder({ payload: lying }) }));

    expect(run.outcome).toBe('undecodable');
    expect(run.error).toMatch(/payload refused: payload source is/);
  });

  it('refuses to address a source that has no slot grid', async () => {
    await expect(pollGranuleSlot('firms:viirs:snpp', SLOT, deps())).rejects.toThrow(
      /not a geostationary/,
    );
  });
});

describe('the rows a slot writes', () => {
  it('are GEO rows, which is what makes them attach-only downstream', async () => {
    const run = await pollGranuleSlot(SOURCE, SLOT, deps());

    const [record] = granuleDetectionRecords(run);

    expect(record?.productTier).toBe('GEO');
    expect(record?.collectionVersion).toBe('LSA-502');
    expect(record?.dayNight).toBeNull();
    expect(record?.quarantined).toBe(false);
    expect(record?.lat).toBe('41.85012');
  });

  it('carry the breaker verdict, like every other batch', async () => {
    const run = await pollGranuleSlot(SOURCE, SLOT, deps());

    expect(granuleDetectionRecords(run, { quarantined: true })[0]?.quarantined).toBe(true);
  });
});

describe('the freshness a slot reports', () => {
  const NOW = 1_785_670_200_000;

  it('counts an absent slot as the provider answering, with no rows', async () => {
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({ granules: source({ outcome: 'missing', bytes: null, error: 'HTTP 404' }) }),
    );

    expect(granulePollAttempt(run, NOW)).toEqual({
      source: SOURCE,
      attemptAt: AVAILABLE_AT,
      succeeded: true,
      receivedRows: 0,
      error: 'HTTP 404',
    });
  });

  it('counts a fetch failure as an outage, timestamped from the clock', async () => {
    const run = await pollGranuleSlot(
      SOURCE,
      SLOT,
      deps({
        granules: source({ outcome: 'failed', bytes: null, availableAt: null, error: 'HTTP 502' }),
      }),
    );

    expect(granulePollAttempt(run, NOW)).toMatchObject({
      attemptAt: NOW,
      succeeded: false,
      error: 'HTTP 502',
    });
  });

  it('counts a decoded slot as data', async () => {
    const run = await pollGranuleSlot(SOURCE, SLOT, deps());

    expect(granulePollAttempt(run, NOW)).toEqual({
      source: SOURCE,
      attemptAt: AVAILABLE_AT,
      succeeded: true,
      receivedRows: 1,
      error: null,
    });
  });
});
