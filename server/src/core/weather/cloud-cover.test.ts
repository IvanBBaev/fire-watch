import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CLOUD_COVER, type CloudCoverValues } from '../config/cloud-cover.js';
import { defineConfig } from '../config/versioned-config.js';
import type { WeatherContextValues } from '../config/weather-context.js';
import { VirtualClock, epochMsFromIso } from '../ports/clock.js';
import type { PayloadRead, PayloadReader } from '../ports/payload-reader.js';
import type { PayloadStore, PayloadWriteResult } from '../ports/payload-store.js';
import type { ForecastCycleRef, WeatherClient } from '../ports/weather-client.js';
import { REAL_10U_CCSDS, fromBase64 } from './__fixtures__/grib2-samples.js';
import { REAL_TCC_STEP12, REAL_TCC_STEP6, TCC_EXPECTED } from './__fixtures__/tcc-samples.js';
import {
  CLOUD_CURRENT_META_PATH,
  CLOUD_CURRENT_PATH,
  cloudAt,
  cloudGrid,
  deriveCloudCover,
  parseCloudDocument,
  previousCycle,
  runWeatherJob,
  type CloudDocument,
  type CloudDerivationDeps,
} from './cloud-cover.js';
import { weatherFieldPath } from './weather-refresh.js';

/**
 * The fixtures are the real `tcc` messages of the 2026-09-30 00z run, steps 6 and 12,
 * cropped to the polling bbox — the bytes production decodes. Other steps and runs are
 * those messages with their section-1 reference time or section-4 forecast time rewritten:
 * the only fields the identity check reads that differ between them.
 */
const CYCLE: ForecastCycleRef = { dateYmd: '20260930', hour: 0 };
const PREVIOUS: ForecastCycleRef = { dateYmd: '20260929', hour: 18 };
const RUN_AT = '2026-09-30T00:00:00Z';
const TCC6 = fromBase64(REAL_TCC_STEP6);
const TCC12 = fromBase64(REAL_TCC_STEP12);

const SOFIA = { lat: 42.75, lon: 23.25 } as const;
const EAST = { lat: 42.25, lon: 25.75 } as const;

/** A narrowed config: the two real steps, no previous run unless a test adds one. */
function config(overrides: Partial<CloudCoverValues> = {}) {
  return defineConfig('cloud_cover', 'cloud_cover_v1', {
    ...CLOUD_COVER.values,
    steps: [6, 12],
    previousRunSteps: [],
    ...overrides,
  });
}

function sectionOffset(bytes: Uint8Array, section: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 16;
  while (offset < bytes.byteLength - 4) {
    if (bytes[offset + 4] === section) return offset;
    offset += view.getUint32(offset);
  }
  throw new Error(`no section ${String(section)}`);
}

/** Rewrite section 4's forecast time (octets 19–22). */
function withForecastHours(bytes: Uint8Array, hours: number): Uint8Array {
  const out = bytes.slice();
  new DataView(out.buffer).setUint32(sectionOffset(out, 4) + 18, hours);
  return out;
}

/** Rewrite section 1's reference time (octets 13–19: year, month, day, hour, min, sec). */
function withReferenceTime(bytes: Uint8Array, iso: string): Uint8Array {
  const out = bytes.slice();
  const at = new Date(epochMsFromIso(iso));
  const offset = sectionOffset(out, 1);
  new DataView(out.buffer).setUint16(offset + 12, at.getUTCFullYear());
  out.set([at.getUTCMonth() + 1, at.getUTCDate(), at.getUTCHours(), 0, 0], offset + 14);
  return out;
}

function fakeSha(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `fakesha-${hash.toString(16).padStart(8, '0')}-${String(bytes.byteLength)}`;
}

class MemoryStore implements PayloadStore, PayloadReader {
  readonly payloads = new Map<string, Uint8Array>();
  readonly texts = new Map<string, string>();
  failReadOn: RegExp | null = null;
  payloadReads = 0;
  writes = 0;

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.payloads.has(path) || this.texts.has(path));
  }

  writePayload(path: string, bytes: Uint8Array): Promise<PayloadWriteResult> {
    this.payloads.set(path, bytes.slice());
    return Promise.resolve({ bytes: bytes.byteLength, sha256: fakeSha(bytes) });
  }

  writeText(path: string, text: string): Promise<PayloadWriteResult> {
    this.writes += 1;
    this.texts.set(path, text);
    return Promise.resolve({
      bytes: text.length,
      sha256: fakeSha(new TextEncoder().encode(text)),
    });
  }

  readPayload(path: string): Promise<PayloadRead | null> {
    if (this.failReadOn?.test(path) === true) return Promise.reject(new Error('EIO'));
    this.payloadReads += 1;
    const bytes = this.payloads.get(path);
    return Promise.resolve(bytes === undefined ? null : { bytes, sha256: fakeSha(bytes) });
  }

  readText(path: string): Promise<string | null> {
    if (this.failReadOn?.test(path) === true) return Promise.reject(new Error('EIO'));
    return Promise.resolve(this.texts.get(path) ?? null);
  }

  record(cycle: ForecastCycleRef, step: number, bytes: Uint8Array, param = 'tcc'): void {
    const path = weatherFieldPath(cycle, step, param);
    this.payloads.set(path, bytes);
    this.texts.set(
      path.replace(/\.grib2$/, '.meta.json'),
      JSON.stringify({ sha256: fakeSha(bytes), available_at: '2026-09-30T08:10:00Z' }),
    );
  }
}

function realStore(): MemoryStore {
  const store = new MemoryStore();
  store.record(CYCLE, 6, TCC6);
  store.record(CYCLE, 12, TCC12);
  return store;
}

const deps = (store: MemoryStore, values?: Partial<CloudCoverValues>): CloudDerivationDeps => ({
  reader: store,
  payloads: store,
  cloudConfig: config(values),
});

function stored(store: MemoryStore): CloudDocument {
  const document = parseCloudDocument(store.texts.get(CLOUD_CURRENT_PATH) ?? '');
  if (document === null) throw new Error('no stored cloud document');
  return document;
}

const pct = (fraction: number): number => Math.round(fraction * 100);

describe('cloudGrid', () => {
  it('puts a point on every 0.5° pass-cell centre of the polling bbox', () => {
    expect(cloudGrid(CLOUD_COVER.values)).toEqual({
      west: 20.25,
      south: 39.25,
      east: 30.75,
      north: 45.75,
      resolution_deg: 0.5,
      cols: 22,
      rows: 14,
      order: 'north_to_south_west_to_east',
    });
  });
});

describe('cloud_cover_v1', () => {
  it('reaches the furthest culmination the pass window can ask about', () => {
    // Latest run up to 14 h old + 24 h look-ahead + one 10-minute bucket.
    const furthest = 14 + 24 + 1 / 6;
    expect(Math.max(...CLOUD_COVER.values.steps)).toBeGreaterThanOrEqual(furthest);
    const gaps = CLOUD_COVER.values.steps
      .slice(1)
      .map((s, i) => s - (CLOUD_COVER.values.steps[i] ?? 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(CLOUD_COVER.values.maxBracketHours);
  });
});

describe('previousCycle', () => {
  it('steps back one run, across midnight', () => {
    expect(previousCycle(CYCLE)).toEqual(PREVIOUS);
    expect(previousCycle({ dateYmd: '20260930', hour: 12 })).toEqual({
      dateYmd: '20260930',
      hour: 6,
    });
  });
});

describe('deriveCloudCover', () => {
  it('writes whole percentages at the cell centres, from the real ECMWF bytes', async () => {
    const store = realStore();

    const result = await deriveCloudCover(CYCLE, deps(store));

    expect(result).toEqual({
      outcome: 'written',
      runAt: RUN_AT,
      steps: [6, 12].map((step) => ({ runAt: RUN_AT, step, outcome: 'derived', detail: null })),
      error: null,
    });
    const document = stored(store);
    expect(document.kind).toBe('forecast');
    expect(document.available_at).toBe('2026-09-30T08:10:00Z');
    expect(document.steps.map((step) => [step.run_at, step.valid_at])).toEqual([
      [RUN_AT, '2026-09-30T06:00:00Z'],
      [RUN_AT, '2026-09-30T12:00:00Z'],
    ]);
    const [step6, step12] = document.steps;
    expect(step6?.cloud_pct).toHaveLength(22 * 14);
    // Row 6, column 6 is the 42.75°N 23.25°E cell — ecCodes' value there, in percent.
    expect(step6?.cloud_pct[6 * 22 + 6]).toBe(pct(TCC_EXPECTED.step6['42.75,23.25']));
    expect(step12?.cloud_pct[6 * 22 + 6]).toBe(pct(TCC_EXPECTED.step12['42.75,23.25']));
    // The NE corner cell (45.75°N 30.75°E) and the SW one (39.25°N 20.25°E).
    expect(step6?.cloud_pct[21]).toBe(pct(TCC_EXPECTED.step6['45.75,30.75']));
    expect(step12?.cloud_pct[13 * 22]).toBe(pct(TCC_EXPECTED.step12['39.25,20.25']));

    const meta = JSON.parse(store.texts.get(CLOUD_CURRENT_META_PATH) ?? '') as Record<
      string,
      unknown
    >;
    expect(meta['run_at']).toBe(RUN_AT);
    expect(meta['cloud_cover_version']).toBe('cloud_cover_v1');
  });

  it('decides "unchanged" from the sidecars alone, without decoding a field', async () => {
    const store = realStore();
    await deriveCloudCover(CYCLE, deps(store));
    const writes = store.writes;
    const reads = store.payloadReads;

    const again = await deriveCloudCover(CYCLE, deps(store));

    expect(again.outcome).toBe('unchanged');
    expect(store.writes).toBe(writes);
    expect(store.payloadReads).toBe(reads);
  });

  it('merges the previous run only for valid times before the latest run', async () => {
    const store = realStore();
    const previous = (step: number): Uint8Array =>
      withReferenceTime(withForecastHours(TCC6, step), '2026-09-29T18:00:00Z');
    for (const step of [0, 3, 6]) store.record(PREVIOUS, step, previous(step));

    const result = await deriveCloudCover(CYCLE, deps(store, { previousRunSteps: [0, 3, 6] }));

    expect(result.outcome).toBe('written');
    // Step 6 of 18z is valid at 00z — the latest run's own time — so it is never read.
    expect(result.steps.map((step) => `${step.runAt}+${String(step.step)}`)).toEqual([
      `${RUN_AT}+6`,
      `${RUN_AT}+12`,
      '2026-09-29T18:00:00Z+0',
      '2026-09-29T18:00:00Z+3',
    ]);
    expect(stored(store).steps.map((step) => step.valid_at)).toEqual([
      '2026-09-29T18:00:00Z',
      '2026-09-29T21:00:00Z',
      '2026-09-30T06:00:00Z',
      '2026-09-30T12:00:00Z',
    ]);
  });

  it('keeps the stored document when the latest run has no usable step', async () => {
    const store = new MemoryStore();
    store.record(
      PREVIOUS,
      0,
      withReferenceTime(withForecastHours(TCC6, 0), '2026-09-29T18:00:00Z'),
    );

    const result = await deriveCloudCover(CYCLE, deps(store, { previousRunSteps: [0] }));

    expect(result.outcome).toBe('no_steps');
    expect(store.texts.has(CLOUD_CURRENT_PATH)).toBe(false);
  });

  it('refuses a field that is not the one its path claims, and ships the others', async () => {
    const store = realStore();
    store.record(CYCLE, 12, TCC6); // step 6's message filed as step 12
    store.record(CYCLE, 9, withForecastHours(fromBase64(REAL_10U_CCSDS), 9)); // wind as cloud

    const result = await deriveCloudCover(CYCLE, deps(store, { steps: [6, 9, 12] }));

    expect(result.outcome).toBe('written');
    expect(result.steps.find((step) => step.step === 9)).toEqual(
      expect.objectContaining({
        outcome: 'identity_mismatch',
        detail: 'tcc@9h parameter category is 2, expected 6',
      }),
    );
    expect(result.steps.find((step) => step.step === 12)).toEqual(
      expect.objectContaining({
        outcome: 'identity_mismatch',
        detail: 'tcc@12h forecast hours is 6, expected 12',
      }),
    );
    expect(stored(store).steps.map((step) => step.step_hours)).toEqual([6]);
  });

  it('refuses bytes that do not hash to their sidecar', async () => {
    const store = realStore();
    const damaged = TCC12.slice();
    damaged[200] = (damaged[200] ?? 0) ^ 0xff;
    store.payloads.set(weatherFieldPath(CYCLE, 12, 'tcc'), damaged);

    const result = await deriveCloudCover(CYCLE, deps(store));

    expect(result.steps.find((step) => step.step === 12)?.outcome).toBe('integrity_mismatch');
    expect(stored(store).steps).toHaveLength(1);
  });

  it('reports a store that cannot be read as read_failed, never a throw', async () => {
    const store = realStore();
    store.failReadOn = /12h/;
    const result = await deriveCloudCover(CYCLE, deps(store));
    expect(result).toEqual(expect.objectContaining({ outcome: 'read_failed', error: 'EIO' }));
  });
});

describe('cloudAt', () => {
  async function document(values?: Partial<CloudCoverValues>): Promise<CloudDocument> {
    const store = realStore();
    await deriveCloudCover(CYCLE, deps(store, values));
    return stored(store);
  }
  const at = (iso: string) => epochMsFromIso(iso);

  it('is exact on a step and linear in time between two', async () => {
    const doc = await document();
    const six = pct(TCC_EXPECTED.step6['42.75,23.25']);
    const twelve = pct(TCC_EXPECTED.step12['42.75,23.25']);
    expect(cloudAt(doc, SOFIA, at('2026-09-30T06:00:00Z'))).toEqual({ pct: six, runs: [RUN_AT] });
    expect(cloudAt(doc, SOFIA, at('2026-09-30T12:00:00Z'))?.pct).toBe(twelve);
    expect(cloudAt(doc, SOFIA, at('2026-09-30T09:00:00Z'))?.pct).toBe(
      Math.round((six + twelve) / 2),
    );
    expect(cloudAt(doc, EAST, at('2026-09-30T10:00:00Z'))?.pct).toBe(
      Math.round(
        pct(TCC_EXPECTED.step6['42.25,25.75']) +
          ((pct(TCC_EXPECTED.step12['42.25,25.75']) - pct(TCC_EXPECTED.step6['42.25,25.75'])) * 4) /
            6,
      ),
    );
  });

  it('never extrapolates, never bridges a wide gap, never answers off a cell centre', async () => {
    const doc = await document();
    expect(cloudAt(doc, SOFIA, at('2026-09-30T05:59:59Z'))).toBeNull();
    expect(cloudAt(doc, SOFIA, at('2026-09-30T12:00:01Z'))).toBeNull();
    expect(cloudAt(doc, { lat: 42.7, lon: 23.25 }, at('2026-09-30T06:00:00Z'))).toBeNull();
    expect(cloudAt(doc, { lat: 46.25, lon: 23.25 }, at('2026-09-30T06:00:00Z'))).toBeNull();
    const narrow = { ...CLOUD_COVER.values, maxBracketHours: 3 };
    expect(cloudAt(doc, SOFIA, at('2026-09-30T09:00:00Z'), narrow)).toBeNull();
    expect(cloudAt(doc, SOFIA, at('2026-09-30T06:00:00Z'), narrow)).not.toBeNull();
  });

  it('always lies between the two bracketing values', async () => {
    const doc = await document();
    const from = at('2026-09-30T06:00:00Z');
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 21 }),
        fc.integer({ min: 0, max: 13 }),
        fc.integer({ min: 0, max: 6 * 3_600_000 }),
        (col, row, offset) => {
          const point = { lat: 45.75 - row * 0.5, lon: 20.25 + col * 0.5 };
          const value = cloudAt(doc, point, from + offset)?.pct;
          const a = doc.steps[0]?.cloud_pct[row * 22 + col] ?? NaN;
          const b = doc.steps[1]?.cloud_pct[row * 22 + col] ?? NaN;
          return (
            value !== undefined &&
            Number.isInteger(value) &&
            value >= Math.min(a, b) &&
            value <= Math.max(a, b)
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('parseCloudDocument', () => {
  it('round-trips a stored document and rejects what could answer for the wrong cell', async () => {
    const store = realStore();
    await deriveCloudCover(CYCLE, deps(store));
    const text = store.texts.get(CLOUD_CURRENT_PATH) ?? '';
    expect(parseCloudDocument(text)).toEqual(JSON.parse(text));

    const good = JSON.parse(text) as Record<string, unknown>;
    const [first, second] = good['steps'] as Record<string, unknown>[];
    const cells = first?.['cloud_pct'] as number[];
    const variants: unknown[] = [
      null,
      { ...good, schema_version: 2 },
      { ...good, kind: 'observation' },
      { ...good, param: 'lcc' },
      { ...good, available_at: 'soon' },
      { ...good, grid: { ...(good['grid'] as object), resolution_deg: 0 } },
      { ...good, steps: [{ ...first, cloud_pct: cells.slice(1) }] },
      { ...good, steps: [{ ...first, cloud_pct: [...cells.slice(1), 101] }] },
      { ...good, steps: [{ ...first, cloud_pct: [...cells.slice(1), 0.5] }] },
      { ...good, steps: [{ ...first, run_at: 'x' }] },
      { ...good, steps: [second, first] },
      { ...good, steps: [first, first] },
    ];
    expect(parseCloudDocument('{')).toBeNull();
    for (const variant of variants) expect(parseCloudDocument(JSON.stringify(variant))).toBeNull();
  });
});

describe('runWeatherJob', () => {
  const CONTEXT = defineConfig('weather_context', 'weather_context_v1', {
    params: ['tcc'],
    levtype: 'sfc',
    steps: [6],
    cycleHours: [0, 6, 12, 18],
    publicationDelayHours: 8,
    byteFloorBytes: 32,
  } as const satisfies WeatherContextValues);

  it('records the extra tcc steps, then derives cloud for exactly that run', async () => {
    const store = new MemoryStore();
    const bytes: Record<number, Uint8Array> = { 6: TCC6, 12: TCC12 };
    const indexed: number[] = [];
    const client: WeatherClient = {
      fetchIndex: (_cycle, step) => {
        indexed.push(step);
        const field = bytes[step];
        return Promise.resolve(
          field === undefined
            ? { text: null, availableAt: null, error: `404 for step ${String(step)}` }
            : {
                text: JSON.stringify({
                  step: String(step),
                  levtype: 'sfc',
                  param: 'tcc',
                  _offset: 0,
                  _length: field.byteLength,
                }),
                availableAt: null,
                error: null,
              },
        );
      },
      fetchRange: (_cycle, step) =>
        Promise.resolve({ bytes: bytes[step] ?? null, availableAt: null, error: null }),
    };

    const report = await runWeatherJob(
      {
        client,
        payloads: store,
        feedStatus: { recordAttempt: () => Promise.resolve() },
        clock: new VirtualClock('2026-09-30T08:30:00Z'),
        contextConfig: CONTEXT,
      },
      { reader: store, payloads: store },
      { reader: store, payloads: store, cloudConfig: config() },
    );

    expect(report.cycle).toEqual(CYCLE);
    // Step 6 is the context's own; only 12 is fetched for the cloud config.
    expect(indexed).toEqual([6, 12]);
    expect(report.cloud.outcome).toBe('written');
    expect(stored(store).steps).toHaveLength(2);
    expect(report.wind.outcome).toBe('no_steps');
  });

  it('asks for every cloud_cover_v1 step by default', async () => {
    const store = new MemoryStore();
    const indexed: number[] = [];
    const client: WeatherClient = {
      fetchIndex: (_cycle, step) => {
        indexed.push(step);
        return Promise.resolve({ text: '', availableAt: null, error: null });
      },
      fetchRange: () => Promise.resolve({ bytes: null, availableAt: null, error: 'unused' }),
    };
    const report = await runWeatherJob(
      {
        client,
        payloads: store,
        feedStatus: { recordAttempt: () => Promise.resolve() },
        clock: new VirtualClock('2026-09-30T08:30:00Z'),
      },
      { reader: store, payloads: store },
    );
    expect(indexed).toEqual([0, 6, 12, 3, 9, 15, 18, 21, 24, 27, 30, 33, 36, 39]);
    expect(report.cloud.outcome).toBe('no_steps');
  });
});
