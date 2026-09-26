import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import type { WeatherContextValues } from '../config/weather-context.js';
import { VirtualClock } from '../ports/clock.js';
import type { FeedAttempt, FeedStatusStore } from '../ports/feed-status-store.js';
import type { PayloadStore, PayloadWriteResult } from '../ports/payload-store.js';
import type {
  ByteRange,
  WeatherClient,
  WeatherIndexFetch,
  WeatherRangeFetch,
} from '../ports/weather-client.js';
import {
  runWeatherRefresh,
  weatherFieldPath,
  weatherRefreshFailed,
  type WeatherRefreshDeps,
} from './weather-refresh.js';

/**
 * A narrowed config so fixtures stay hand-sized: two params, two steps, a floor small
 * enough for toy GRIB bodies. Same version string as production — the sidecar cites
 * whatever config the run used, and that is what these tests verify.
 */
const TEST_CONTEXT = defineConfig('weather_context', 'weather_context_v1', {
  params: ['10u', '2t'],
  levtype: 'sfc',
  steps: [0, 6],
  cycleHours: [0, 6, 12, 18],
  publicationDelayHours: 8,
  byteFloorBytes: 32,
} as const satisfies WeatherContextValues);

/** Byte extents per param, identical for both steps: 10u first, 2t after it. */
const EXTENTS: Record<string, ByteRange> = {
  '10u': { offset: 0, length: 64 },
  '2t': { offset: 64, length: 48 },
};

const indexLine = (param: string, step: number): string =>
  JSON.stringify({
    domain: 'g',
    type: 'fc',
    stream: 'oper',
    step: String(step), // the provider writes step as a string
    levtype: 'sfc',
    param,
    _offset: EXTENTS[param]?.offset ?? 0,
    _length: EXTENTS[param]?.length ?? 0,
  });

const fullIndex = (step: number): string =>
  [indexLine('10u', step), indexLine('2t', step), indexLine('msl', step)].join('\n');

/** Structurally valid GRIB2 of the requested length: magic, trailer, filler between. */
const validGrib = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  bytes.set([0x47, 0x52, 0x49, 0x42], 0);
  bytes.set([0x37, 0x37, 0x37, 0x37], length - 4);
  return bytes;
};

const indexOk = (text: string): WeatherIndexFetch => ({ text, availableAt: null, error: null });
const indexDown = (error: string): WeatherIndexFetch => ({ text: null, availableAt: null, error });
const rangeOk = (bytes: Uint8Array): WeatherRangeFetch => ({
  bytes,
  availableAt: null,
  error: null,
});

class FakePayloadStore implements PayloadStore {
  readonly payloads = new Map<string, Uint8Array>();
  readonly texts = new Map<string, string>();
  failOn: RegExp | null = null;

  exists(relativePath: string): Promise<boolean> {
    return Promise.resolve(this.payloads.has(relativePath) || this.texts.has(relativePath));
  }

  writePayload(relativePath: string, bytes: Uint8Array): Promise<PayloadWriteResult> {
    if (this.failOn?.test(relativePath) === true) {
      return Promise.reject(new Error(`disk full: ${relativePath}`));
    }
    this.payloads.set(relativePath, bytes.slice());
    return Promise.resolve({ bytes: bytes.byteLength, sha256: fakeSha(bytes) });
  }

  writeText(relativePath: string, text: string): Promise<PayloadWriteResult> {
    if (this.failOn?.test(relativePath) === true) {
      return Promise.reject(new Error(`disk full: ${relativePath}`));
    }
    this.texts.set(relativePath, text);
    return Promise.resolve({ bytes: text.length, sha256: 'fakesha-text' });
  }
}

function fakeSha(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `fakesha-${hash.toString(16).padStart(8, '0')}-${String(bytes.byteLength)}`;
}

class FakeFeedStatusStore implements FeedStatusStore {
  readonly attempts: FeedAttempt[] = [];
  throws = false;

  recordAttempt(attempt: FeedAttempt): Promise<void> {
    if (this.throws) return Promise.reject(new Error('feed status disk unwritable'));
    this.attempts.push(attempt);
    return Promise.resolve();
  }
}

interface FakeClient {
  readonly client: WeatherClient;
  readonly rangeCalls: { step: number; offset: number; length: number }[];
}

function fakeClient(behaviour: {
  index: (step: number) => WeatherIndexFetch;
  range?: (step: number, range: ByteRange) => WeatherRangeFetch;
}): FakeClient {
  const rangeCalls: { step: number; offset: number; length: number }[] = [];
  const range = behaviour.range ?? ((_step, extent) => rangeOk(validGrib(extent.length)));
  return {
    rangeCalls,
    client: {
      fetchIndex: (_cycle, step) => Promise.resolve(behaviour.index(step)),
      fetchRange: (_cycle, step, extent) => {
        rangeCalls.push({ step, offset: extent.offset, length: extent.length });
        return Promise.resolve(range(step, extent));
      },
    },
  };
}

interface Harness {
  readonly payloads: FakePayloadStore;
  readonly feedStatus: FakeFeedStatusStore;
  readonly deps: (client: WeatherClient) => WeatherRefreshDeps;
}

function harness(): Harness {
  // 15:00 UTC minus the 8 h delay → today's 06z run is the latest published one.
  const clock = new VirtualClock('2026-08-13T15:00:00Z');
  const payloads = new FakePayloadStore();
  const feedStatus = new FakeFeedStatusStore();
  return {
    payloads,
    feedStatus,
    deps: (client) => ({ client, payloads, feedStatus, clock, contextConfig: TEST_CONTEXT }),
  };
}

const CYCLE = { dateYmd: '20260813', hour: 6 } as const;

describe('runWeatherRefresh', () => {
  it('records every configured field of the latest published run, with provenance', async () => {
    const h = harness();
    const { client } = fakeClient({ index: (step) => indexOk(fullIndex(step)) });

    const report = await runWeatherRefresh(h.deps(client));

    expect(report.cycle).toEqual(CYCLE);
    for (const step of TEST_CONTEXT.values.steps) {
      const outcomes = report.steps.find((s) => s.step === step)?.fields;
      expect(outcomes?.map((field) => field.outcome)).toEqual(['stored', 'stored']);
    }
    expect(h.payloads.payloads.has('weather/ecmwf/20260813/06z/0h/10u.grib2')).toBe(true);
    expect(h.payloads.payloads.has('weather/ecmwf/20260813/06z/6h/2t.grib2')).toBe(true);

    const meta = JSON.parse(
      h.payloads.texts.get('weather/ecmwf/20260813/06z/0h/10u.meta.json') ?? '',
    ) as Record<string, unknown>;
    expect(meta['feed']).toBe('weather:context');
    expect(meta['provider']).toBe('ecmwf-open-data');
    expect(meta['offset']).toBe(0);
    expect(meta['length']).toBe(64);
    expect(meta['sha256']).toBe(fakeSha(validGrib(64)));
    expect(meta['available_at']).toBe('2026-08-13T15:00:00Z');
    expect(meta['weather_context_version']).toBe('weather_context_v1');

    expect(h.feedStatus.attempts).toEqual([
      expect.objectContaining({ row: 'weather:context', succeeded: true, hadData: true }),
    ]);
    expect(weatherRefreshFailed(report)).toBe(false);
  });

  it('never refetches a field already on disk — a published run is immutable', async () => {
    const h = harness();
    const first = fakeClient({ index: (step) => indexOk(fullIndex(step)) });
    await runWeatherRefresh(h.deps(first.client));
    expect(first.rangeCalls).toHaveLength(4); // 2 params × 2 steps

    const second = fakeClient({ index: (step) => indexOk(fullIndex(step)) });
    const report = await runWeatherRefresh(h.deps(second.client));

    expect(second.rangeCalls).toHaveLength(0);
    const outcomes = report.steps.flatMap((step) => step.fields.map((field) => field.outcome));
    expect(outcomes).toEqual([
      'already_recorded',
      'already_recorded',
      'already_recorded',
      'already_recorded',
    ]);
    // Still a success — but hadData is false: nothing *new* arrived this cycle.
    expect(h.feedStatus.attempts[1]).toEqual(
      expect.objectContaining({ row: 'weather:context', succeeded: true, hadData: false }),
    );
  });

  it('names a param the index does not list and degrades the feed row', async () => {
    const h = harness();
    const { client } = fakeClient({
      index: (step) => indexOk(indexLine('10u', step)), // 2t absent
    });

    const report = await runWeatherRefresh(h.deps(client));

    const step0 = report.steps.find((step) => step.step === 0);
    const missing = step0?.fields.find((field) => field.param === '2t');
    expect(missing?.outcome).toBe('missing_from_index');
    expect(missing?.error).toBe('param 2t is not in the index for step 0');
    expect(h.feedStatus.attempts[0]).toEqual(
      expect.objectContaining({ row: 'weather:context', succeeded: false, hadData: true }),
    );
    // The loop itself did its job; only the feed row degrades.
    expect(weatherRefreshFailed(report)).toBe(false);
  });

  it('records nothing for a ranged body that fails GRIB sanity', async () => {
    const h = harness();
    const html = new TextEncoder().encode('<html>Bad Gateway</html>'.repeat(4));
    const { client } = fakeClient({
      index: (step) => indexOk(fullIndex(step)),
      range: (step, extent) =>
        step === 0 && extent.offset === 0 ? rangeOk(html) : rangeOk(validGrib(extent.length)),
    });

    const report = await runWeatherRefresh(h.deps(client));

    const unsound = report.steps[0]?.fields.find((field) => field.param === '10u');
    expect(unsound?.outcome).toBe('unsound');
    expect(unsound?.error).toContain('GRIB magic');
    expect(h.payloads.payloads.has('weather/ecmwf/20260813/06z/0h/10u.grib2')).toBe(false);
    expect(h.payloads.texts.has('weather/ecmwf/20260813/06z/0h/10u.meta.json')).toBe(false);
    expect(h.feedStatus.attempts[0]?.succeeded).toBe(false);
  });

  it('marks a step whose index is unreachable and fails only when all of them are', async () => {
    const h = harness();
    const oneDown = fakeClient({
      index: (step) =>
        step === 0
          ? indexDown('ECMWF returned 503 for 20260813/6z step 0')
          : indexOk(fullIndex(step)),
    });
    const partial = await runWeatherRefresh(h.deps(oneDown.client));
    expect(partial.steps[0]).toEqual(expect.objectContaining({ indexFetched: false, fields: [] }));
    expect(partial.steps[0]?.error).toContain('503');
    expect(weatherRefreshFailed(partial)).toBe(false); // step 6 still landed

    const allDown = fakeClient({ index: () => indexDown('connect timeout') });
    const dark = await runWeatherRefresh(harness().deps(allDown.client));
    expect(weatherRefreshFailed(dark)).toBe(true);
  });

  it('contains a client that throws instead of returning a failure value', async () => {
    const h = harness();
    const report = await runWeatherRefresh(
      h.deps({
        fetchIndex: () => Promise.reject(new Error('socket hang up')),
        fetchRange: () => Promise.reject(new Error('socket hang up')),
      }),
    );
    expect(report.steps.every((step) => !step.indexFetched)).toBe(true);
    expect(report.steps[0]?.error).toBe('socket hang up');
    // The feed row still got recorded — the report survived the failure it reports.
    expect(h.feedStatus.attempts).toHaveLength(1);
  });

  it('marks a good body the store could not keep as write_failed', async () => {
    const h = harness();
    h.payloads.failOn = /10u\.grib2$/;
    const { client } = fakeClient({ index: (step) => indexOk(fullIndex(step)) });

    const report = await runWeatherRefresh(h.deps(client));

    const failed = report.steps[0]?.fields.find((field) => field.param === '10u');
    expect(failed?.outcome).toBe('write_failed');
    expect(failed?.error).toContain('disk full');
    expect(h.feedStatus.attempts[0]?.succeeded).toBe(false);
  });

  it('treats an unwritable feed status store as a failed refresh', async () => {
    const h = harness();
    h.feedStatus.throws = true;
    const { client } = fakeClient({ index: (step) => indexOk(fullIndex(step)) });
    const report = await runWeatherRefresh(h.deps(client));
    expect(report.feedStatusError).toContain('unwritable');
    expect(weatherRefreshFailed(report)).toBe(true);
  });
});

describe('weatherFieldPath', () => {
  it('addresses a field by run, step and param with a zero-padded cycle hour', () => {
    expect(weatherFieldPath({ dateYmd: '20260813', hour: 6 }, 0, '10u')).toBe(
      'weather/ecmwf/20260813/06z/0h/10u.grib2',
    );
    expect(weatherFieldPath({ dateYmd: '20260812', hour: 18 }, 12, 'tcc')).toBe(
      'weather/ecmwf/20260812/18z/12h/tcc.grib2',
    );
  });
});
