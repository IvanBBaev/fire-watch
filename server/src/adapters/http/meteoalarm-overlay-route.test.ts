/**
 * The V2-B3 MeteoAlarm route over real parts: the synthetic Bulgarian feed and its CAP
 * alerts are polled by the real core job into a temp state dir through the real fs payload
 * store (real sha256 sidecar), and read back through the route.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CREDITS, assertedText } from '@fire-watch/contracts';

import {
  SYNTHETIC_BULGARIA_FEED,
  SYNTHETIC_CAP_DUST,
  SYNTHETIC_CAP_DUST_URL,
  SYNTHETIC_CAP_FIRE,
  SYNTHETIC_CAP_FIRE_URL,
  SYNTHETIC_CAP_HEAT,
  SYNTHETIC_CAP_HEAT_URL,
  SYNTHETIC_NOW_MS,
} from '../../core/meteoalarm/__fixtures__/meteoalarm-feeds.js';
import {
  METEOALARM_CURRENT_META_PATH,
  METEOALARM_CURRENT_PATH,
} from '../../core/meteoalarm/meteoalarm-document.js';
import { createMeteoalarmRefresh } from '../../core/meteoalarm/meteoalarm-refresh.js';
import { MemoryFeedStatus } from '../../core/passes/__fixtures__/memory-feed-status.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type { MeteoalarmClient } from '../../core/ports/meteoalarm-client.js';
import { PRODUCT_NAME } from '../../core/snapshot/snapshot-builder.js';
import { createFsPayloadStore } from '../storage/fs-payload-store.js';
import {
  METEOALARM_OVERLAY_CACHE_CONTROL,
  METEOALARM_OVERLAY_PATH,
  registerMeteoalarmOverlayRoute,
  type MeteoalarmOverlayResponse,
} from './meteoalarm-overlay-route.js';
import type { ProblemLogEntry } from './problem.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'fire-watch-meteoalarm-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const CAPS: Record<string, string> = {
  [SYNTHETIC_CAP_FIRE_URL]: SYNTHETIC_CAP_FIRE,
  [SYNTHETIC_CAP_HEAT_URL]: SYNTHETIC_CAP_HEAT,
  [SYNTHETIC_CAP_DUST_URL]: SYNTHETIC_CAP_DUST,
};

async function poll(): Promise<void> {
  const client: MeteoalarmClient = {
    fetchFeed: () =>
      Promise.resolve({
        kind: 'ok',
        body: SYNTHETIC_BULGARIA_FEED,
        validators: { etag: null, lastModified: null },
      }),
    fetchCap: (url) => Promise.resolve({ body: CAPS[url] ?? null, error: null }),
  };
  const report = await createMeteoalarmRefresh({
    client,
    payloads: createFsPayloadStore(stateDir),
    clock: new VirtualClock(SYNTHETIC_NOW_MS),
    feedStatus: new MemoryFeedStatus(),
    countries: [{ code: 'BG', slug: 'bulgaria' }],
  }).run();
  expect(report.written).toBe(true);
}

function meteoalarmApp(
  nowMs: number,
  rateLimit?: { limit: number; windowMs: number },
): { app: FastifyInstance; problems: ProblemLogEntry[] } {
  const problems: ProblemLogEntry[] = [];
  const app = Fastify();
  registerMeteoalarmOverlayRoute(app, {
    stateDir,
    clock: new VirtualClock(nowMs),
    onProblem: (entry) => problems.push(entry),
    rateLimit,
  });
  return { app, problems };
}

const MINUTE = 60_000;

describe('GET /overlays/meteoalarm/warnings.json', () => {
  it('serves the warnings in force with honest times, cache headers and the credit', async () => {
    await poll();
    const { app } = meteoalarmApp(SYNTHETIC_NOW_MS + 5 * MINUTE);

    const response = await app.inject({ method: 'GET', url: METEOALARM_OVERLAY_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe(METEOALARM_OVERLAY_CACHE_CONTROL);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['etag']).toMatch(/^"ma1-[0-9a-f]{32}"$/);
    expect(response.headers['x-fire-watch-overlay-generated-at']).toBe('2026-08-14T12:00:00Z');
    expect(response.headers['last-modified']).toBe('Fri, 14 Aug 2026 12:00:00 GMT');

    const body = response.json<MeteoalarmOverlayResponse>();
    expect(body.generated_at).toBe('2026-08-14T12:00:00Z');
    expect(body.countries).toEqual([
      { country: 'BG', checked_at: '2026-08-14T12:00:00Z', ok: true },
    ]);
    expect(body.warnings.map((w) => [w.region, w.kind, w.level])).toEqual([
      ['Haskovo', 'forest-fire', 3],
      ['Kardzhali', 'high-temperature', 2],
    ]);
    const credit = CREDITS.find((candidate) => candidate.id === 'meteoalarm')!;
    expect(body.attribution).toEqual([
      expect.objectContaining({ id: 'meteoalarm', href: 'https://meteoalarm.org' }),
    ]);
    expect(body.attribution[0]?.text).toContain(
      assertedText(credit, { year: 2026, productName: PRODUCT_NAME }),
    );
    await app.close();
  });

  it('answers a matching If-None-Match with a 304, and HEAD with the GET validator', async () => {
    await poll();
    const { app } = meteoalarmApp(SYNTHETIC_NOW_MS);
    const first = await app.inject({ method: 'GET', url: METEOALARM_OVERLAY_PATH });
    const etag = String(first.headers['etag']);

    const revalidated = await app.inject({
      method: 'GET',
      url: METEOALARM_OVERLAY_PATH,
      headers: { 'if-none-match': etag },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe('');

    const head = await app.inject({ method: 'HEAD', url: METEOALARM_OVERLAY_PATH });
    expect(head.statusCode).toBe(200);
    expect(head.headers['etag']).toBe(etag);
    await app.close();
  });

  it('answers 503 before the first poll', async () => {
    const { app } = meteoalarmApp(SYNTHETIC_NOW_MS);
    const response = await app.inject({ method: 'GET', url: METEOALARM_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('300');
    await app.close();
  });

  it('answers 503, not an empty list, when the poller has stopped for over an hour', async () => {
    await poll();
    const { app } = meteoalarmApp(SYNTHETIC_NOW_MS + 61 * MINUTE);
    const response = await app.inject({ method: 'GET', url: METEOALARM_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ title: string }>().title).toBe('Warnings temporarily unavailable');
    await app.close();
  });

  it('refuses a document that does not match its sidecar', async () => {
    await poll();
    const path = join(stateDir, METEOALARM_CURRENT_PATH);
    writeFileSync(path, readFileSync(path, 'utf8').replace('Haskovo', 'Haskovx'));
    const { app, problems } = meteoalarmApp(SYNTHETIC_NOW_MS);
    const response = await app.inject({ method: 'GET', url: METEOALARM_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(problems).toHaveLength(1);
    await app.close();
  });

  it('refuses a sidecar without a sha256', async () => {
    await poll();
    writeFileSync(join(stateDir, METEOALARM_CURRENT_META_PATH), '{}');
    const { app } = meteoalarmApp(SYNTHETIC_NOW_MS);
    const response = await app.inject({ method: 'GET', url: METEOALARM_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it('refuses query strings and rate-limits per client', async () => {
    await poll();
    const { app } = meteoalarmApp(SYNTHETIC_NOW_MS, { limit: 2, windowMs: 60_000 });
    const query = await app.inject({ method: 'GET', url: `${METEOALARM_OVERLAY_PATH}?x=1` });
    expect(query.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: METEOALARM_OVERLAY_PATH })).statusCode).toBe(
      200,
    );
    const limited = await app.inject({ method: 'GET', url: METEOALARM_OVERLAY_PATH });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code: string }>().code).toBe('rate_limited');
    await app.close();
  });

  it('refuses a relative state dir', () => {
    expect(() =>
      registerMeteoalarmOverlayRoute(Fastify(), {
        stateDir: 'relative/dir',
        clock: new VirtualClock(SYNTHETIC_NOW_MS),
      }),
    ).toThrow(RangeError);
  });
});
