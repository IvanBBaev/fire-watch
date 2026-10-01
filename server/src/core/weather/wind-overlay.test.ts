import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import type { WeatherContextValues } from '../config/weather-context.js';
import { WIND_OVERLAY } from '../config/wind-overlay.js';
import { VirtualClock, epochMsFromIso } from '../ports/clock.js';
import type { FeedAttempt, FeedStatusStore } from '../ports/feed-status-store.js';
import type { PayloadRead, PayloadReader } from '../ports/payload-reader.js';
import type { PayloadStore, PayloadWriteResult } from '../ports/payload-store.js';
import type { ForecastCycleRef, WeatherClient } from '../ports/weather-client.js';
import {
  REAL_10U_CCSDS,
  REAL_10U_EXPECTED,
  REAL_10V_CCSDS,
  REAL_10V_EXPECTED,
  fromBase64,
} from './__fixtures__/grib2-samples.js';
import { weatherFieldPath } from './weather-refresh.js';
import {
  WIND_CURRENT_META_PATH,
  WIND_CURRENT_PATH,
  deriveWindOverlay,
  directionFromDeg,
  parseWindDocument,
  runWeatherRefreshWithWind,
  selectWindStep,
  speedMs,
  windCycleAt,
  windGrid,
  type WindDocument,
  type WindDerivationDeps,
} from './wind-overlay.js';

/**
 * The fixtures are real ECMWF 00z 2026-09-30 step-0 messages cropped to exactly the
 * polling bbox, so the derivation below runs on the bytes production decodes. Steps 6
 * and 12 are the same message with its forecast time rewritten — the only field the
 * identity check reads that differs between steps.
 */
const CYCLE: ForecastCycleRef = { dateYmd: '20260930', hour: 0 };
const RUN_AT = '2026-09-30T00:00:00Z';
const U = fromBase64(REAL_10U_CCSDS);
const V = fromBase64(REAL_10V_CCSDS);

/** Walk the GRIB2 sections to section 4 and rewrite its forecast time (octets 19–22). */
function withForecastHours(bytes: Uint8Array, hours: number): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  let offset = 16;
  while (offset < out.byteLength - 4) {
    const length = view.getUint32(offset);
    if (out[offset + 4] === 4) {
      view.setUint32(offset + 18, hours);
      return out;
    }
    offset += length;
  }
  throw new Error('no section 4');
}

function fakeSha(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `fakesha-${hash.toString(16).padStart(8, '0')}-${String(bytes.byteLength)}`;
}

function textSha(text: string): string {
  return fakeSha(new TextEncoder().encode(text));
}

class MemoryStore implements PayloadStore, PayloadReader {
  readonly payloads = new Map<string, Uint8Array>();
  readonly texts = new Map<string, string>();
  failWriteOn: RegExp | null = null;
  failReadOn: RegExp | null = null;
  writes = 0;

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.payloads.has(path) || this.texts.has(path));
  }

  writePayload(path: string, bytes: Uint8Array): Promise<PayloadWriteResult> {
    if (this.failWriteOn?.test(path) === true) return Promise.reject(new Error('disk full'));
    this.payloads.set(path, bytes.slice());
    return Promise.resolve({ bytes: bytes.byteLength, sha256: fakeSha(bytes) });
  }

  writeText(path: string, text: string): Promise<PayloadWriteResult> {
    if (this.failWriteOn?.test(path) === true) return Promise.reject(new Error('disk full'));
    this.writes += 1;
    this.texts.set(path, text);
    return Promise.resolve({ bytes: text.length, sha256: textSha(text) });
  }

  readPayload(path: string): Promise<PayloadRead | null> {
    if (this.failReadOn?.test(path) === true) return Promise.reject(new Error('EIO'));
    const bytes = this.payloads.get(path);
    return Promise.resolve(bytes === undefined ? null : { bytes, sha256: fakeSha(bytes) });
  }

  readText(path: string): Promise<string | null> {
    if (this.failReadOn?.test(path) === true) return Promise.reject(new Error('EIO'));
    return Promise.resolve(this.texts.get(path) ?? null);
  }

  /** Record a field the way the weather refresh does: bytes plus a provenance sidecar. */
  record(cycle: ForecastCycleRef, step: number, param: string, bytes: Uint8Array): void {
    const path = weatherFieldPath(cycle, step, param);
    this.payloads.set(path, bytes);
    this.texts.set(
      path.replace(/\.grib2$/, '.meta.json'),
      JSON.stringify({
        sha256: fakeSha(bytes),
        available_at: `2026-09-30T0${String(7 + step / 6)}:40:00Z`,
      }),
    );
  }
}

function fullStore(): MemoryStore {
  const store = new MemoryStore();
  for (const step of [0, 6, 12]) {
    store.record(CYCLE, step, '10u', withForecastHours(U, step));
    store.record(CYCLE, step, '10v', withForecastHours(V, step));
  }
  return store;
}

const deps = (store: MemoryStore): WindDerivationDeps => ({ reader: store, payloads: store });

function storedDocument(store: MemoryStore): WindDocument {
  const document = parseWindDocument(store.texts.get(WIND_CURRENT_PATH) ?? '');
  if (document === null) throw new Error('no stored wind document');
  return document;
}

describe('windGrid', () => {
  it('lays 0.5° points over the polling bbox, corners included', () => {
    expect(windGrid(WIND_OVERLAY.values)).toEqual({
      west: 20,
      south: 39,
      east: 31,
      north: 46,
      resolution_deg: 0.5,
      cols: 23,
      rows: 15,
      order: 'north_to_south_west_to_east',
    });
  });
});

describe('directionFromDeg / speedMs', () => {
  it('names the direction the wind blows from, clockwise from north', () => {
    expect(directionFromDeg(0, -5)).toBe(0); // blowing south → from the north
    expect(directionFromDeg(-5, 0)).toBe(90); // blowing west → from the east
    expect(directionFromDeg(0, 5)).toBe(180);
    expect(directionFromDeg(5, 0)).toBe(270);
    expect(directionFromDeg(-3, -3)).toBe(45);
  });

  it('is always a whole degree in 0..359, and speed is non-negative to 0.1', () => {
    const component = fc.double({ min: -60, max: 60, noNaN: true });
    fc.assert(
      fc.property(component, component, (u, v) => {
        const direction = directionFromDeg(u, v);
        const speed = speedMs(u, v);
        return (
          Number.isInteger(direction) &&
          direction >= 0 &&
          direction <= 359 &&
          speed >= 0 &&
          Math.abs(speed * 10 - Math.round(speed * 10)) < 1e-9
        );
      }),
      { numRuns: 500 },
    );
  });
});

describe('deriveWindOverlay', () => {
  it('writes a 23 × 15 grid for every recorded step, from the real ECMWF bytes', async () => {
    const store = fullStore();

    const result = await deriveWindOverlay(CYCLE, deps(store));

    expect(result).toEqual({
      outcome: 'written',
      runAt: RUN_AT,
      steps: [0, 6, 12].map((step) => ({ step, outcome: 'derived', detail: null })),
      error: null,
    });
    const document = storedDocument(store);
    expect(document.run_at).toBe(RUN_AT);
    expect(document.available_at).toBe('2026-09-30T09:40:00Z'); // latest input
    expect(document.steps.map((step) => step.valid_at)).toEqual([
      RUN_AT,
      '2026-09-30T06:00:00Z',
      '2026-09-30T12:00:00Z',
    ]);
    const [step0] = document.steps;
    expect(step0?.speed_ms).toHaveLength(23 * 15);
    // Cell 0 is the NW corner (46°N 20°E) — the crop's first value in both components.
    expect(step0?.speed_ms[0]).toBe(speedMs(REAL_10U_EXPECTED.first, REAL_10V_EXPECTED.first));
    expect(step0?.direction_from_deg[0]).toBe(
      directionFromDeg(REAL_10U_EXPECTED.first, REAL_10V_EXPECTED.first),
    );
    // The last cell is the SE corner — the crop's last value.
    expect(step0?.speed_ms.at(-1)).toBe(speedMs(REAL_10U_EXPECTED.last, REAL_10V_EXPECTED.last));
    const maxSpeed = Math.hypot(REAL_10U_EXPECTED.min, REAL_10V_EXPECTED.min);
    for (const speed of step0?.speed_ms ?? []) expect(speed).toBeLessThanOrEqual(maxSpeed + 0.1);

    const meta = JSON.parse(store.texts.get(WIND_CURRENT_META_PATH) ?? '') as Record<
      string,
      unknown
    >;
    expect(meta['sha256']).toBe(textSha(store.texts.get(WIND_CURRENT_PATH) ?? ''));
    expect(meta['run_at']).toBe(RUN_AT);
    expect(meta['wind_overlay_version']).toBe('wind_overlay_v1');
    expect(meta['inputs']).toHaveLength(6);
  });

  it('does not rewrite a document built from the same inputs', async () => {
    const store = fullStore();
    await deriveWindOverlay(CYCLE, deps(store));
    const writes = store.writes;

    const again = await deriveWindOverlay(CYCLE, deps(store));

    expect(again.outcome).toBe('unchanged');
    expect(store.writes).toBe(writes);
  });

  it('leaves out a step whose component is not recorded yet, and ships the rest', async () => {
    const store = fullStore();
    store.payloads.delete(weatherFieldPath(CYCLE, 12, '10v'));

    const result = await deriveWindOverlay(CYCLE, deps(store));

    expect(result.outcome).toBe('written');
    expect(result.steps[2]).toEqual({
      step: 12,
      outcome: 'missing',
      detail: '10v@12h not recorded',
    });
    expect(storedDocument(store).steps.map((step) => step.step_hours)).toEqual([0, 6]);
  });

  it('refuses bytes that do not hash to their sidecar', async () => {
    const store = fullStore();
    const path = weatherFieldPath(CYCLE, 0, '10u');
    const damaged = (store.payloads.get(path) ?? new Uint8Array()).slice();
    damaged[200] = (damaged[200] ?? 0) ^ 0xff;
    store.payloads.set(path, damaged);

    const result = await deriveWindOverlay(CYCLE, deps(store));

    expect(result.steps[0]?.outcome).toBe('integrity_mismatch');
  });

  it('treats an unreadable sidecar as an integrity failure', async () => {
    const store = fullStore();
    store.texts.set(weatherFieldPath(CYCLE, 6, '10u').replace(/\.grib2$/, '.meta.json'), '{');

    const result = await deriveWindOverlay(CYCLE, deps(store));

    expect(result.steps[1]).toEqual(
      expect.objectContaining({ step: 6, outcome: 'integrity_mismatch' }),
    );
  });

  it('refuses a message that is not what its path claims', async () => {
    const store = fullStore();
    // v bytes filed as u: decodes fine, but parameter number 3 is not 2.
    store.record(CYCLE, 0, '10u', V);
    // The right field, the wrong step: filed under 6 h, says 0 h.
    store.record(CYCLE, 6, '10v', V);
    // A different run filed under this one.
    store.record(CYCLE, 12, '10u', withForecastHours(U, 12));
    const otherRun = { dateYmd: '20260930', hour: 6 } as const;

    const result = await deriveWindOverlay(CYCLE, deps(store));
    expect(result.steps.map((step) => step.outcome)).toEqual([
      'identity_mismatch',
      'identity_mismatch',
      'derived',
    ]);
    expect(result.steps[0]?.detail).toBe('10u@0h parameter number is 3, expected 2');
    expect(result.steps[1]?.detail).toBe('10v@6h forecast hours is 0, expected 6');

    // Now derive the 06z run from 00z bytes: every step has the wrong reference time.
    for (const step of [0, 6, 12]) {
      store.record(otherRun, step, '10u', withForecastHours(U, step));
      store.record(otherRun, step, '10v', withForecastHours(V, step));
    }
    const wrongRun = await deriveWindOverlay(otherRun, deps(store));
    expect(wrongRun.outcome).toBe('no_steps');
    expect(wrongRun.steps[0]?.detail).toMatch(/^10u@0h reference time is \d+, expected \d+$/);
  });

  it('carries the decoder refusal reason for a corrupt message', async () => {
    const store = fullStore();
    store.record(CYCLE, 0, '10u', U.slice(0, 120));

    const result = await deriveWindOverlay(CYCLE, deps(store));

    expect(result.steps[0]?.outcome).toBe('refused');
    expect(result.steps[0]?.detail).toMatch(/^10u@0h: /);
  });

  it('writes nothing when no step is usable, keeping the previous document', async () => {
    const store = new MemoryStore();
    store.texts.set(WIND_CURRENT_PATH, 'previous');

    const result = await deriveWindOverlay(CYCLE, deps(store));

    expect(result.outcome).toBe('no_steps');
    expect(result.steps.every((step) => step.outcome === 'missing')).toBe(true);
    expect(store.texts.get(WIND_CURRENT_PATH)).toBe('previous');
  });

  it('reports store failures as outcomes, never throws', async () => {
    const reading = fullStore();
    reading.failReadOn = /10v/;
    expect(await deriveWindOverlay(CYCLE, deps(reading))).toEqual(
      expect.objectContaining({ outcome: 'read_failed', error: 'EIO' }),
    );

    const writing = fullStore();
    writing.failWriteOn = /^weather\/wind\//;
    expect(await deriveWindOverlay(CYCLE, deps(writing))).toEqual(
      expect.objectContaining({ outcome: 'write_failed', error: 'disk full' }),
    );
  });

  it('rewrites when the stored sidecar is unreadable', async () => {
    const store = fullStore();
    await deriveWindOverlay(CYCLE, deps(store));
    store.texts.set(WIND_CURRENT_META_PATH, 'not json');

    expect((await deriveWindOverlay(CYCLE, deps(store))).outcome).toBe('written');
  });
});

describe('selectWindStep', () => {
  async function document(): Promise<WindDocument> {
    const store = fullStore();
    await deriveWindOverlay(CYCLE, deps(store));
    return storedDocument(store);
  }

  it('serves the step nearest now, ties to the earlier one', async () => {
    const doc = await document();
    const at = (iso: string): number | undefined => {
      const selection = selectWindStep(doc, epochMsFromIso(iso));
      return selection.ok ? selection.body.step_hours : undefined;
    };
    expect(at('2026-09-30T02:59:00Z')).toBe(0);
    expect(at('2026-09-30T03:00:00Z')).toBe(0);
    expect(at('2026-09-30T03:01:00Z')).toBe(6);
    expect(at('2026-09-30T13:00:00Z')).toBe(12);
    expect(at('2026-09-29T19:00:00Z')).toBe(0);
  });

  it('carries the run, valid and available times with the chosen arrays', async () => {
    const doc = await document();
    const selection = selectWindStep(doc, epochMsFromIso('2026-09-30T07:00:00Z'));
    expect(selection.ok && selection.body).toEqual(
      expect.objectContaining({
        run_at: RUN_AT,
        step_hours: 6,
        valid_at: '2026-09-30T06:00:00Z',
        available_at: doc.available_at,
        speed_ms: doc.steps[1]?.speed_ms,
        wind_overlay_version: 'wind_overlay_v1',
      }),
    );
  });

  it('is stale beyond the step-distance bound, and empty without steps', async () => {
    const doc = await document();
    expect(selectWindStep(doc, epochMsFromIso('2026-09-30T18:00:00Z')).ok).toBe(true);
    expect(selectWindStep(doc, epochMsFromIso('2026-09-30T18:00:01Z'))).toEqual({
      ok: false,
      reason: 'stale',
      detail: 'the nearest recorded step is valid at 2026-09-30T12:00:00Z',
    });
    expect(selectWindStep({ ...doc, steps: [] }, 0)).toEqual(
      expect.objectContaining({ ok: false, reason: 'no_steps' }),
    );
  });
});

describe('parseWindDocument', () => {
  it('round-trips a stored document', async () => {
    const store = fullStore();
    await deriveWindOverlay(CYCLE, deps(store));
    const text = store.texts.get(WIND_CURRENT_PATH) ?? '';
    expect(parseWindDocument(text)).toEqual(JSON.parse(text));
  });

  it('rejects anything the route could draw wrongly', async () => {
    const store = fullStore();
    await deriveWindOverlay(CYCLE, deps(store));
    const good = JSON.parse(store.texts.get(WIND_CURRENT_PATH) ?? '') as Record<string, unknown>;
    const step0 = (good['steps'] as Record<string, unknown>[])[0] ?? {};
    const variants: unknown[] = [
      null,
      [],
      { ...good, schema_version: 2 },
      { ...good, provider: 'gfs' },
      { ...good, run_at: 'yesterday' },
      { ...good, wind_overlay_digest: 7 },
      { ...good, grid: { ...(good['grid'] as object), order: 'south_to_north' } },
      { ...good, grid: { ...(good['grid'] as object), cols: 0 } },
      { ...good, steps: 'none' },
      { ...good, steps: [{ ...step0, speed_ms: [1, 2, 3] }] },
      {
        ...good,
        steps: [
          { ...step0, direction_from_deg: [...(step0['speed_ms'] as number[]).slice(1), 'x'] },
        ],
      },
      { ...good, steps: [{ ...step0, valid_at: 12 }] },
    ];
    expect(parseWindDocument('{')).toBeNull();
    for (const variant of variants) expect(parseWindDocument(JSON.stringify(variant))).toBeNull();
  });
});

describe('runWeatherRefreshWithWind', () => {
  const CONTEXT = defineConfig('weather_context', 'weather_context_v1', {
    params: ['10u', '10v'],
    levtype: 'sfc',
    steps: [0],
    cycleHours: [0, 6, 12, 18],
    publicationDelayHours: 8,
    byteFloorBytes: 32,
  } as const satisfies WeatherContextValues);

  it('records the run, then derives the wind for exactly that run', async () => {
    const store = new MemoryStore();
    const attempts: FeedAttempt[] = [];
    const feedStatus: FeedStatusStore = {
      recordAttempt: (attempt) => {
        attempts.push(attempt);
        return Promise.resolve();
      },
    };
    const extents = { '10u': U, '10v': V } as const;
    const index = Object.entries(extents)
      .map(([param, bytes], i) =>
        JSON.stringify({
          step: '0',
          levtype: 'sfc',
          param,
          _offset: i * 100_000,
          _length: bytes.byteLength,
        }),
      )
      .join('\n');
    const client: WeatherClient = {
      fetchIndex: () => Promise.resolve({ text: index, availableAt: null, error: null }),
      fetchRange: (_cycle, _step, extent) =>
        Promise.resolve({
          bytes: extent.offset === 0 ? U : V,
          availableAt: null,
          error: null,
        }),
    };
    // 08:30 UTC minus the 8 h delay → the 00z run.
    const clock = new VirtualClock('2026-09-30T08:30:00Z');
    expect(windCycleAt(clock.now(), CONTEXT)).toEqual(CYCLE);

    const report = await runWeatherRefreshWithWind(
      { client, payloads: store, feedStatus, clock, contextConfig: CONTEXT },
      deps(store),
    );

    expect(report.cycle).toEqual(CYCLE);
    expect(report.wind).toEqual({
      outcome: 'written',
      runAt: RUN_AT,
      steps: [{ step: 0, outcome: 'derived', detail: null }],
      error: null,
    });
    expect(storedDocument(store).weather_context_version).toBe('weather_context_v1');
    expect(attempts).toHaveLength(1);
  });
});
