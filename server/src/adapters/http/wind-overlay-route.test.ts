/**
 * The F14 wind route, end to end over real parts: the committed ECMWF crops are recorded
 * into a temp state dir by the real fs payload store (real sha256 sidecars), derived by the
 * real core job, and read back through the route.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertedText, ecmwfComponents } from '@fire-watch/contracts';

import { VirtualClock } from '../../core/ports/clock.js';
import {
  REAL_10U_CCSDS,
  REAL_10V_CCSDS,
  fromBase64,
} from '../../core/weather/__fixtures__/grib2-samples.js';
import { weatherFieldPath } from '../../core/weather/weather-refresh.js';
import {
  WIND_CURRENT_META_PATH,
  WIND_CURRENT_PATH,
  deriveWindOverlay,
} from '../../core/weather/wind-overlay.js';
import { PRODUCT_NAME } from '../../core/snapshot/snapshot-builder.js';
import { createFsPayloadStore } from '../storage/fs-payload-store.js';
import type { ProblemLogEntry } from './problem.js';
import {
  WIND_OVERLAY_CACHE_CONTROL,
  WIND_OVERLAY_PATH,
  registerWindOverlayRoute,
  type WindOverlayResponse,
} from './wind-overlay-route.js';

const CYCLE = { dateYmd: '20260930', hour: 0 } as const;

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'fire-watch-wind-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** Step 0 only: the fixtures are step-0 messages, and one step is all the route needs. */
async function recordAndDerive(): Promise<void> {
  const store = createFsPayloadStore(stateDir);
  for (const [param, base64] of [
    ['10u', REAL_10U_CCSDS],
    ['10v', REAL_10V_CCSDS],
  ] as const) {
    const path = weatherFieldPath(CYCLE, 0, param);
    const written = await store.writePayload(path, fromBase64(base64));
    await store.writeText(
      path.replace(/\.grib2$/, '.meta.json'),
      JSON.stringify({ sha256: written.sha256, available_at: '2026-09-30T07:40:00Z' }),
    );
  }
  const result = await deriveWindOverlay(CYCLE, { reader: store, payloads: store });
  expect(result.outcome).toBe('written');
}

function windApp(
  now: string,
  rateLimit?: { limit: number; windowMs: number },
): { app: FastifyInstance; problems: ProblemLogEntry[] } {
  const problems: ProblemLogEntry[] = [];
  const app = Fastify();
  registerWindOverlayRoute(app, {
    stateDir,
    clock: new VirtualClock(now),
    onProblem: (entry) => problems.push(entry),
    rateLimit,
  });
  return { app, problems };
}

describe('GET /overlays/wind/latest.json', () => {
  it('serves the nearest step with honest times, cache headers and the ECMWF unit', async () => {
    await recordAndDerive();
    const { app } = windApp('2026-09-30T02:00:00Z');

    const response = await app.inject({ method: 'GET', url: WIND_OVERLAY_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe(WIND_OVERLAY_CACHE_CONTROL);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['etag']).toMatch(/^"w1-[0-9a-f]{32}"$/);
    expect(response.headers['x-fire-watch-overlay-run-at']).toBe('2026-09-30T00:00:00Z');
    expect(response.headers['x-fire-watch-overlay-valid-at']).toBe('2026-09-30T00:00:00Z');
    expect(response.headers['x-fire-watch-overlay-available-at']).toBe('2026-09-30T07:40:00Z');
    expect(response.headers['last-modified']).toBe('Wed, 30 Sep 2026 07:40:00 GMT');

    const body = response.json<WindOverlayResponse>();
    expect(body).toEqual(
      expect.objectContaining({
        schema_version: 1,
        provider: 'ecmwf-open-data',
        model: 'ifs',
        step_hours: 0,
        valid_at: '2026-09-30T00:00:00Z',
        wind_overlay_version: 'wind_overlay_v1',
      }),
    );
    expect(body.grid).toEqual(expect.objectContaining({ cols: 23, rows: 15 }));
    expect(body.speed_ms).toHaveLength(23 * 15);
    expect(body.direction_from_deg).toHaveLength(23 * 15);

    // Every one of the five ECMWF components, in the Terms' order, with its link.
    const context = { year: 2026, productName: PRODUCT_NAME };
    expect(body.attribution.map((entry) => entry.id)).toEqual(
      ecmwfComponents().map((credit) => credit.id),
    );
    for (const credit of ecmwfComponents()) {
      const entry = body.attribution.find((candidate) => candidate.id === credit.id);
      expect(entry?.text).toContain(assertedText(credit, context));
      expect(entry?.href).toBe(credit.href);
    }
    await app.close();
  });

  it('answers a matching If-None-Match with a 304, and HEAD with the GET validator', async () => {
    await recordAndDerive();
    const { app } = windApp('2026-09-30T02:00:00Z');
    const first = await app.inject({ method: 'GET', url: WIND_OVERLAY_PATH });
    const etag = String(first.headers['etag']);

    const revalidated = await app.inject({
      method: 'GET',
      url: WIND_OVERLAY_PATH,
      headers: { 'if-none-match': etag },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe('');
    expect(revalidated.headers['etag']).toBe(etag);

    // Node's HTTP server drops a HEAD body; light-my-request does not, so assert headers.
    const head = await app.inject({ method: 'HEAD', url: WIND_OVERLAY_PATH });
    expect(head.statusCode).toBe(200);
    expect(head.headers['etag']).toBe(etag);
    await app.close();
  });

  it('is a 503, not yesterday’s wind, beyond the step-distance bound', async () => {
    await recordAndDerive();
    const { app, problems } = windApp('2026-09-30T06:00:01Z');

    const response = await app.inject({ method: 'GET', url: WIND_OVERLAY_PATH });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.headers['retry-after']).toBe('300');
    expect(response.json<{ title: string }>().title).toBe('Wind temporarily unavailable');
    expect(problems).toHaveLength(1);
    await app.close();
  });

  it('is a 503 before anything has been derived', async () => {
    const { app } = windApp('2026-09-30T02:00:00Z');
    const response = await app.inject({ method: 'GET', url: WIND_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ title: string }>().title).toBe('Wind not yet available');
    await app.close();
  });

  it('refuses a document that does not match its sidecar, and one that fails validation', async () => {
    await recordAndDerive();
    const documentPath = join(stateDir, WIND_CURRENT_PATH);
    const original = readFileSync(documentPath, 'utf8');
    writeFileSync(documentPath, original.replace('"ifs"', '"gfs"'));
    const { app, problems } = windApp('2026-09-30T02:00:00Z');

    const tampered = await app.inject({ method: 'GET', url: WIND_OVERLAY_PATH });
    expect(tampered.statusCode).toBe(503);
    expect(tampered.json<{ title: string }>().title).toBe('Wind temporarily unavailable');
    // The cause stays in the log: never the path, never the reason, on the wire.
    expect(tampered.body).not.toContain('sha256');

    rmSync(join(stateDir, WIND_CURRENT_META_PATH));
    const halfPresent = await app.inject({ method: 'GET', url: WIND_OVERLAY_PATH });
    expect(halfPresent.statusCode).toBe(503);
    expect(problems).toHaveLength(2);
    await app.close();
  });

  it('refuses query strings, so a cache-buster cannot reach the origin per request', async () => {
    await recordAndDerive();
    const { app } = windApp('2026-09-30T02:00:00Z');
    const response = await app.inject({ method: 'GET', url: `${WIND_OVERLAY_PATH}?_=1` });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('limits per client', async () => {
    await recordAndDerive();
    const { app } = windApp('2026-09-30T02:00:00Z', { limit: 2, windowMs: 60_000 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await app.inject({ method: 'GET', url: WIND_OVERLAY_PATH })).statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    await app.close();
  });

  it('refuses a relative state dir at registration', () => {
    expect(() =>
      registerWindOverlayRoute(Fastify(), {
        stateDir: 'state',
        clock: new VirtualClock('2026-09-30T02:00:00Z'),
      }),
    ).toThrow(RangeError);
  });
});
