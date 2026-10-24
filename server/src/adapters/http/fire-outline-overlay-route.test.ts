import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type {
  ActiveFireOutline,
  ActiveFireOutlinesRead,
} from '../../core/ports/fire-outline-store.js';
import {
  DEFAULT_MAX_OUTLINES,
  DEFAULT_OUTLINE_STALE_AFTER_MS,
  FIRE_OUTLINE_OVERLAY_PATH,
  type FireOutlineOverlayRouteDeps,
} from './fire-outline-overlay-route.js';
import { createHealthServer } from './health-server.js';

// Synthetic outlines only.
const NOW = Date.parse('2026-10-24T12:00:00Z');
const MINUTE = 60_000;

function outline(overrides: Partial<ActiveFireOutline> = {}): ActiveFireOutline {
  return {
    publicId: 'fw-2026-aaaaa',
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [25.1, 42.6],
            [25.11, 42.6],
            [25.11, 42.61],
            [25.1, 42.61],
            [25.1, 42.6],
          ],
        ],
      ],
    },
    areaHa: 120.5,
    areaLowHa: 40.2,
    areaHighHa: 260.1,
    edgeUncertaintyKm: 0.5,
    footprints: 4,
    lastDetectionAt: NOW - 30 * MINUTE,
    ...overrides,
  };
}

function current(outlines: readonly ActiveFireOutline[] = [outline()]): ActiveFireOutlinesRead {
  return {
    pass: { paramsVersion: 'fire_outline_params_v1', completedAt: NOW - MINUTE },
    outlines,
    truncated: false,
  };
}

function server(
  answer: ActiveFireOutlinesRead | Error | (() => Promise<ActiveFireOutlinesRead>),
  extra: Partial<FireOutlineOverlayRouteDeps> = {},
  limits: number[] = [],
) {
  return createHealthServer({
    reader: { readObservations: () => Promise.reject(new Error('unused')) },
    probe: { ping: () => Promise.reject(new Error('unused')) },
    clock: new VirtualClock(NOW),
    expected: [],
    fireOutlineOverlay: {
      reader: {
        readActiveOutlines: (limit) => {
          limits.push(limit);
          if (typeof answer === 'function') return answer();
          return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        },
      },
      clock: new VirtualClock(NOW),
      ...extra,
    },
  });
}

describe(`GET ${FIRE_OUTLINE_OVERLAY_PATH}`, () => {
  it('serves the outlines as estimated GeoJSON with the FIRMS credit', async () => {
    const limits: number[] = [];
    const response = await server(current(), {}, limits).inject({
      method: 'GET',
      url: FIRE_OUTLINE_OVERLAY_PATH,
    });
    expect(response.statusCode).toBe(200);
    expect(limits).toEqual([DEFAULT_MAX_OUTLINES]);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      type: 'FeatureCollection',
      schema_version: 1,
      kind: 'estimated_outline',
      params_version: 'fire_outline_params_v1',
      computed_at: '2026-10-24T11:59:00Z',
      truncated: false,
    });
    expect(body['features']).toEqual([
      {
        type: 'Feature',
        id: 'fw-2026-aaaaa',
        geometry: outline().geometry,
        properties: {
          event_id: 'fw-2026-aaaaa',
          area_ha: 120.5,
          area_low_ha: 40.2,
          area_high_ha: 260.1,
          edge_uncertainty_km: 0.5,
          footprints: 4,
          last_detection_at: '2026-10-24T11:30:00Z',
        },
      },
    ]);
    expect(body['attribution']).toEqual([expect.objectContaining({ id: 'firms-acknowledgement' })]);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.headers['x-fire-watch-overlay-computed-at']).toBe('2026-10-24T11:59:00Z');
    expect(response.headers['etag']).toMatch(/^"o1-[0-9a-f]{32}"$/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never calls the body a perimeter and never carries a forecast', async () => {
    const response = await server(current()).inject({
      method: 'GET',
      url: FIRE_OUTLINE_OVERLAY_PATH,
    });
    expect(response.body).not.toMatch(/perimeter|forecast|predict|spread/i);
  });

  it("answers 304 to the body's own ETag", async () => {
    const first = await server(current()).inject({ method: 'GET', url: FIRE_OUTLINE_OVERLAY_PATH });
    const etag = String(first.headers['etag']);
    const second = await server(current()).inject({
      method: 'GET',
      url: FIRE_OUTLINE_OVERLAY_PATH,
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.headers['etag']).toBe(etag);
  });

  it('changes the ETag when an outline changes', async () => {
    const a = await server(current()).inject({ method: 'GET', url: FIRE_OUTLINE_OVERLAY_PATH });
    const b = await server(current([outline({ areaHa: 130 })])).inject({
      method: 'GET',
      url: FIRE_OUTLINE_OVERLAY_PATH,
    });
    expect(a.headers['etag']).not.toBe(b.headers['etag']);
  });

  it('passes the size bound to the reader and reports truncation', async () => {
    const limits: number[] = [];
    const response = await server(
      { ...current(), truncated: true },
      { maxOutlines: 3 },
      limits,
    ).inject({ method: 'GET', url: FIRE_OUTLINE_OVERLAY_PATH });
    expect(limits).toEqual([3]);
    expect(response.json<Record<string, unknown>>()['truncated']).toBe(true);
  });

  it('serves an empty collection when no active event has an outline', async () => {
    const response = await server(current([])).inject({
      method: 'GET',
      url: FIRE_OUTLINE_OVERLAY_PATH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()['features']).toEqual([]);
  });

  it('answers 503 before the first pass', async () => {
    const response = await server({ pass: null, outlines: [], truncated: false }).inject({
      method: 'GET',
      url: FIRE_OUTLINE_OVERLAY_PATH,
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('60');
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('answers 503 once the heartbeat is stale', async () => {
    const stale: ActiveFireOutlinesRead = {
      ...current(),
      pass: {
        paramsVersion: 'fire_outline_params_v1',
        completedAt: NOW - DEFAULT_OUTLINE_STALE_AFTER_MS - 1,
      },
    };
    const response = await server(stale).inject({
      method: 'GET',
      url: FIRE_OUTLINE_OVERLAY_PATH,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<Record<string, unknown>>()['detail']).toMatch(/too old/);
  });

  it('answers 503 when the read fails', async () => {
    const response = await server(new Error('connection refused')).inject({
      method: 'GET',
      url: FIRE_OUTLINE_OVERLAY_PATH,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toMatch(/connection refused/);
  });

  it('refuses query parameters', async () => {
    const response = await server(current()).inject({
      method: 'GET',
      url: `${FIRE_OUTLINE_OVERLAY_PATH}?bbox=1,2,3,4`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('limits each client', async () => {
    const app = server(current(), { rateLimit: { limit: 1, windowMs: MINUTE } });
    expect((await app.inject({ method: 'GET', url: FIRE_OUTLINE_OVERLAY_PATH })).statusCode).toBe(
      200,
    );
    const limited = await app.inject({ method: 'GET', url: FIRE_OUTLINE_OVERLAY_PATH });
    expect(limited.statusCode).toBe(429);
  });

  it('sheds load above the in-flight cap', async () => {
    let release: (value: ActiveFireOutlinesRead) => void = () => undefined;
    const pending = new Promise<ActiveFireOutlinesRead>((resolve) => {
      release = resolve;
    });
    const app = server(() => pending, { maxInFlight: 1 });
    const first = app.inject({ method: 'GET', url: FIRE_OUTLINE_OVERLAY_PATH });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await app.inject({ method: 'GET', url: FIRE_OUTLINE_OVERLAY_PATH });
    expect(second.statusCode).toBe(503);
    release(current());
    expect((await first).statusCode).toBe(200);
  });

  it('is not served without its deps', async () => {
    const app = createHealthServer({
      reader: { readObservations: () => Promise.reject(new Error('unused')) },
      probe: { ping: () => Promise.reject(new Error('unused')) },
      clock: new VirtualClock(NOW),
      expected: [],
    });
    const response = await app.inject({ method: 'GET', url: FIRE_OUTLINE_OVERLAY_PATH });
    expect(response.statusCode).toBe(404);
  });

  it('is exempt from the probe limiter', async () => {
    const app = createHealthServer({
      reader: { readObservations: () => Promise.reject(new Error('unused')) },
      probe: { ping: () => Promise.reject(new Error('unused')) },
      clock: new VirtualClock(NOW),
      expected: [],
      rateLimit: { limit: 1, windowMs: MINUTE },
      fireOutlineOverlay: {
        reader: { readActiveOutlines: () => Promise.resolve(current()) },
        clock: new VirtualClock(NOW),
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push(
        (await app.inject({ method: 'GET', url: FIRE_OUTLINE_OVERLAY_PATH })).statusCode,
      );
    }
    expect(statuses).toEqual([200, 200, 200]);
  });
});
