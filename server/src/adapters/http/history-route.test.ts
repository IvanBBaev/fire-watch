import { describe, expect, it } from 'vitest';

import { VirtualClock, epochMsFromIso } from '../../core/ports/clock.js';
import type { DatabaseProbe, FreshnessReader } from '../../core/ports/freshness-reader.js';
import type { HistoryDetectionRow, HistoryReader } from '../../core/ports/history-reader.js';
import { createHealthServer } from './health-server.js';
import { DEFAULT_HISTORY_MAX_IN_FLIGHT, type HistoryRouteDeps } from './history-route.js';
import { DEFAULT_MAX_HISTORY_DETECTIONS } from '../../core/history/history-frame.js';
import { PROBLEM_CONTENT_TYPE } from './problem.js';
import { SNAPSHOT_CACHE_CONTROL } from './snapshot-route.js';

const NOW = '2026-08-09T10:17:42Z';

function detection(overrides: Partial<HistoryDetectionRow> = {}): HistoryDetectionRow {
  return {
    uid: 'a'.repeat(64),
    sourceId: 'firms:viirs:noaa21',
    observedAt: epochMsFromIso('2026-08-09T01:02:00Z'),
    lon: 27.51634,
    lat: 41.97712,
    frpMw: 9.8,
    eventPublicId: 'fw-2026-b2n5c',
    ...overrides,
  };
}

interface FakeReader extends HistoryReader {
  readonly calls: { fromMs: number; toMs: number; limit: number }[];
}

function reader(rows: readonly HistoryDetectionRow[] | Error): FakeReader {
  const calls: { fromMs: number; toMs: number; limit: number }[] = [];
  return {
    calls,
    readHistory: (fromMs, toMs, limit) => {
      calls.push({ fromMs, toMs, limit });
      return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
    },
  };
}

const forbidden = {
  reader: {
    readObservations: () => Promise.reject(new Error('the probe reader must not be touched')),
  } satisfies FreshnessReader,
  probe: {
    ping: () => Promise.reject(new Error('the probe must not be touched')),
  } satisfies DatabaseProbe,
};

function server(
  deps: Partial<HistoryRouteDeps> & Pick<HistoryRouteDeps, 'reader'>,
  probeRateLimit?: { limit: number; windowMs: number },
) {
  return createHealthServer({
    reader: forbidden.reader,
    probe: forbidden.probe,
    clock: new VirtualClock(NOW),
    expected: [],
    ...(probeRateLimit === undefined ? {} : { rateLimit: probeRateLimit }),
    history: { clock: new VirtualClock(NOW), ...deps },
  });
}

describe('GET /api/v1/history', () => {
  it('serves the aligned window as the columnar playback document', async () => {
    const fake = reader([detection()]);
    const response = await server({ reader: fake }).inject({
      method: 'GET',
      url: '/api/v1/history?range=24h',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['cache-control']).toBe(SNAPSHOT_CACHE_CONTROL);
    expect(response.headers.etag).toMatch(/^"h1-[0-9a-f]{32}"$/);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      schema_version: 1,
      range: '24h',
      window_from: '2026-08-08T10:10:00Z',
      window_to: '2026-08-09T10:10:00Z',
      generated_at: '2026-08-09T10:10:00Z',
      truncated: false,
      count: 1,
      events: ['fw-2026-b2n5c'],
      detections: { t: [892], lon: [27.516], lat: [41.977], frp: [9.8], s: [0], e: [0] },
    });
    expect((body['attribution'] as unknown[]).length).toBeGreaterThan(0);
    expect(fake.calls).toEqual([
      {
        fromMs: epochMsFromIso('2026-08-08T10:10:00Z'),
        toMs: epochMsFromIso('2026-08-09T10:10:00Z'),
        limit: DEFAULT_MAX_HISTORY_DETECTIONS + 1,
      },
    ]);
  });

  it('answers a matching If-None-Match with a 304 and the same tag', async () => {
    const app = server({ reader: reader([detection()]) });
    const first = await app.inject({ method: 'GET', url: '/api/v1/history?range=7d' });
    const tag = String(first.headers.etag);
    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/history?range=7d',
      headers: { 'if-none-match': tag },
    });
    expect(again.statusCode).toBe(304);
    expect(again.headers.etag).toBe(tag);
    expect(again.body).toBe('');
  });

  it('moves the tag when the rows change', async () => {
    const a = await server({ reader: reader([detection()]) }).inject({
      method: 'GET',
      url: '/api/v1/history?range=3d',
    });
    const b = await server({ reader: reader([detection({ frpMw: 20 })]) }).inject({
      method: 'GET',
      url: '/api/v1/history?range=3d',
    });
    expect(a.headers.etag).not.toBe(b.headers.etag);
  });

  it.each([
    '/api/v1/history',
    '/api/v1/history?range=30d',
    '/api/v1/history?range=24h&cb=1',
    '/api/v1/history?range=24h&range=3d',
  ])('refuses %s with history_range_invalid before the database', async (url) => {
    const fake = reader([]);
    const response = await server({ reader: fake }).inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json<Record<string, unknown>>()['code']).toBe('history_range_invalid');
    expect(fake.calls).toEqual([]);
  });

  it('turns a database failure into a 503 with Retry-After, never an empty window', async () => {
    const response = await server({ reader: reader(new Error('connect ECONNREFUSED')) }).inject({
      method: 'GET',
      url: '/api/v1/history?range=24h',
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body).not.toContain('ECONNREFUSED');
  });

  it('sheds load past the in-flight cap', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: HistoryReader = {
      readHistory: async () => {
        await gate;
        return [];
      },
    };
    const app = server({ reader: slow });
    const held = Array.from({ length: DEFAULT_HISTORY_MAX_IN_FLIGHT }, () =>
      app.inject({ method: 'GET', url: '/api/v1/history?range=24h' }),
    );
    // Let the held requests reach the reader before the next one arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refused = await app.inject({ method: 'GET', url: '/api/v1/history?range=24h' });
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['retry-after']).toBe('1');
    release();
    for (const response of await Promise.all(held)) expect(response.statusCode).toBe(200);
  });

  it('has its own per-IP limit and is exempt from the probe limiter', async () => {
    const app = server(
      { reader: reader([]), rateLimit: { limit: 2, windowMs: 60_000 } },
      { limit: 1, windowMs: 60_000 },
    );
    const statuses: number[] = [];
    for (let n = 0; n < 3; n += 1) {
      statuses.push(
        (await app.inject({ method: 'GET', url: '/api/v1/history?range=24h' })).statusCode,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
    const limited = await app.inject({ method: 'GET', url: '/api/v1/history?range=24h' });
    expect(limited.json<Record<string, unknown>>()['code']).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('answers HEAD', async () => {
    const response = await server({ reader: reader([]) }).inject({
      method: 'HEAD',
      url: '/api/v1/history?range=24h',
    });
    expect(response.statusCode).toBe(200);
  });
});
