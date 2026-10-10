/**
 * The F18 lightning route over a real fs payload store (real sha256 sidecar) in a temp
 * state dir, with the document built by the real core merge.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LIGHTNING_CURRENT_META_PATH,
  LIGHTNING_CURRENT_PATH,
  LIGHTNING_MAX_STALENESS_MS,
  buildRecord,
  emptyDocument,
  mergeRecords,
} from '../../core/lightning/lightning-document.js';
import type { Flash } from '../../core/lightning/lightning-payload.js';
import { VirtualClock } from '../../core/ports/clock.js';
import { createFsPayloadStore } from '../storage/fs-payload-store.js';
import {
  LIGHTNING_OVERLAY_CACHE_CONTROL,
  LIGHTNING_OVERLAY_PATH,
  lightningAttribution,
  registerLightningOverlayRoute,
  type LightningOverlayResponse,
} from './lightning-overlay-route.js';
import type { ProblemLogEntry } from './problem.js';

const MIN = 60_000;
const END = Date.UTC(2026, 8, 30, 12, 30, 9);
const NOW_ISO = '2026-09-30T12:40:00Z';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'fire-watch-lightning-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function flash(at: number, lat: number, lon: number): Flash {
  return { at, lat, lon, radiance: 10, durationMs: 100, footprint: 2, falseLikelihood: 0.1 };
}

/** One product over Bulgaria plus one flash outside the served box. */
async function recordDocument(): Promise<void> {
  const store = createFsPayloadStore(stateDir);
  const record = buildRecord({
    productId: 'p1',
    window: { start: END - 10 * MIN, end: END },
    availableAt: END + 40_000,
    flashes: [flash(END - 5 * MIN, 42.7, 23.3), flash(END - 4 * MIN, 50, 10)],
  });
  const document = mergeRecords(emptyDocument(END), [record], END + MIN);
  const written = await store.writeText(LIGHTNING_CURRENT_PATH, JSON.stringify(document));
  await store.writeText(LIGHTNING_CURRENT_META_PATH, JSON.stringify({ sha256: written.sha256 }));
}

function lightningApp(
  now: string,
  rateLimit?: { limit: number; windowMs: number },
): { app: FastifyInstance; problems: ProblemLogEntry[] } {
  const problems: ProblemLogEntry[] = [];
  const app = Fastify();
  registerLightningOverlayRoute(app, {
    stateDir,
    clock: new VirtualClock(now),
    onProblem: (entry) => problems.push(entry),
    rateLimit,
  });
  return { app, problems };
}

describe('GET /overlays/lightning/recent.json', () => {
  it('serves the clipped flashes with honest times, cache headers and the EUMETSAT credit', async () => {
    await recordDocument();
    const { app } = lightningApp(NOW_ISO);

    const response = await app.inject({ method: 'GET', url: LIGHTNING_OVERLAY_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe(LIGHTNING_OVERLAY_CACHE_CONTROL);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['etag']).toMatch(/^"l1-[0-9a-f]{32}"$/);
    expect(response.headers['x-fire-watch-overlay-covered-through']).toBe('2026-09-30T12:30:09Z');
    expect(response.headers['last-modified']).toBe(new Date(END + 40_000).toUTCString());
    const body = response.json<LightningOverlayResponse>();
    expect(body.flashes).toEqual([{ t: '2026-09-30T12:25:09.000Z', lat: 42.7, lon: 23.3 }]);
    expect(body.products).toBe(1);
    expect(body.retention_hours).toBe(6);
    expect(body.attribution).toHaveLength(1);
    expect(body.attribution[0]).toMatchObject({ id: 'eumetsat-meteosat' });
    expect(body.attribution[0]?.text).toContain('2026');
  });

  it('answers a matching If-None-Match with 304', async () => {
    await recordDocument();
    const { app } = lightningApp(NOW_ISO);
    const first = await app.inject({ method: 'GET', url: LIGHTNING_OVERLAY_PATH });
    const second = await app.inject({
      method: 'GET',
      url: LIGHTNING_OVERLAY_PATH,
      headers: { 'if-none-match': String(first.headers['etag']) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('is a 503 before any product is recorded', async () => {
    const { app } = lightningApp(NOW_ISO);
    const response = await app.inject({ method: 'GET', url: LIGHTNING_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('120');
  });

  it('is a 503, not an empty sky, once coverage is stale', async () => {
    await recordDocument();
    const { app } = lightningApp(new Date(END + LIGHTNING_MAX_STALENESS_MS + MIN).toISOString());
    const response = await app.inject({ method: 'GET', url: LIGHTNING_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ detail: string }>().detail).toMatch(/too old/);
  });

  it('is a 503 when the document does not match its sidecar', async () => {
    await recordDocument();
    const path = join(stateDir, LIGHTNING_CURRENT_PATH);
    writeFileSync(path, readFileSync(path, 'utf8').replace('42.7', '42.8'));
    const { app, problems } = lightningApp(NOW_ISO);
    const response = await app.inject({ method: 'GET', url: LIGHTNING_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('refuses a query string', async () => {
    await recordDocument();
    const { app } = lightningApp(NOW_ISO);
    const response = await app.inject({ method: 'GET', url: `${LIGHTNING_OVERLAY_PATH}?x=1` });
    expect(response.statusCode).toBe(400);
  });

  it('rate-limits per client', async () => {
    await recordDocument();
    const { app } = lightningApp(NOW_ISO, { limit: 2, windowMs: 60_000 });
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push((await app.inject({ method: 'GET', url: LIGHTNING_OVERLAY_PATH })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
  });

  it('refuses a relative state dir', () => {
    expect(() =>
      registerLightningOverlayRoute(Fastify(), {
        stateDir: 'state',
        clock: new VirtualClock(NOW_ISO),
      }),
    ).toThrow(RangeError);
  });
});

describe('lightningAttribution', () => {
  it('renders the EUMETSAT credit with the year of the data', () => {
    const [credit] = lightningAttribution('2027-01-01T00:00:09Z');
    expect(credit?.text).toContain('2027');
    expect(credit?.source).toMatch(/EUMETSAT/);
  });
});
