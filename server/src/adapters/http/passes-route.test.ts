/**
 * TASKS F15, the serving half: stored elements in, a cacheable pass document out — over
 * the real fs payload store (real sha256 sidecars) and the real refresh job.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CELESTRAK_FETCHED_AT_MS,
  OMM_BY_NORAD,
} from '../../core/passes/__fixtures__/celestrak-omm.js';
import type { PassesDocument } from '../../core/passes/passes-document.js';
import type { SwathsDocument } from '../../core/passes/swaths-document.js';
import { runTleRefresh, tleElementsPath } from '../../core/passes/tle-refresh.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type { TleClient } from '../../core/ports/tle-client.js';
import { CLOUD_COVER } from '../../core/config/cloud-cover.js';
import { CLOUD_CURRENT_PATH, cloudGrid } from '../../core/weather/cloud-cover.js';
import { createFsPayloadStore } from '../storage/fs-payload-store.js';
import { PASSES_PATH, PASS_SWATHS_PATH, registerPassesRoute } from './passes-route.js';
import type { ProblemLogEntry } from './problem.js';

const SOFIA = '/api/v1/passes/42.75_23.25';

const client: TleClient = {
  fetchElements: (noradId) =>
    Promise.resolve({
      body: OMM_BY_NORAD[noradId]!,
      status: 200,
      availableAt: CELESTRAK_FETCHED_AT_MS,
      error: null,
    }),
};

let stateDir: string;
let app: FastifyInstance;
let clock: VirtualClock;
let problems: ProblemLogEntry[];
let elementProblems: string[];

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'fire-watch-f15-'));
  clock = new VirtualClock(CELESTRAK_FETCHED_AT_MS);
  problems = [];
  elementProblems = [];
  app = Fastify();
  registerPassesRoute(app, {
    reader: createFsPayloadStore(stateDir),
    clock,
    onProblem: (entry) => problems.push(entry),
    onElementsProblem: (list) => elementProblems.push(...list),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(stateDir, { recursive: true, force: true });
});

async function refresh(): Promise<void> {
  await runTleRefresh({
    client,
    payloads: createFsPayloadStore(stateDir),
    clock,
    feedStatus: { recordAttempt: () => Promise.resolve() },
  });
}

describe(PASSES_PATH, () => {
  it('serves a canonical, content-addressed pass document for a grid cell', async () => {
    await refresh();
    const response = await app.inject({ method: 'GET', url: SOFIA });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    // 13:16 is six minutes into the 13:10 bucket: four minutes left.
    expect(response.headers['cache-control']).toBe('public, max-age=240');
    expect(response.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);

    const doc = response.json<PassesDocument>();
    expect(doc).toMatchObject({
      cell: '42.75_23.25',
      predicted: true,
      elements_provider: 'celestrak',
    });
    expect(doc.platforms).toHaveLength(5);
    // The raw elements are not republished: no OMM member reaches the body.
    expect(response.body).not.toMatch(/MEAN_MOTION|BSTAR|NORAD|OBJECT_ID/);
  });

  it('answers a matching If-None-Match with 304 and the same bytes on the next request', async () => {
    await refresh();
    const first = await app.inject({ method: 'GET', url: SOFIA });
    const etag = first.headers['etag'] as string;
    const again = await app.inject({
      method: 'GET',
      url: SOFIA,
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    clock.advanceMinutes(2);
    const same = await app.inject({ method: 'GET', url: SOFIA });
    expect(same.body).toBe(first.body);
    expect(same.headers['cache-control']).toBe('public, max-age=120');
  });

  it('moves the window, and the ETag, with the ten-minute bucket', async () => {
    await refresh();
    const first = await app.inject({ method: 'GET', url: SOFIA });
    clock.advanceMinutes(10);
    const next = await app.inject({ method: 'GET', url: SOFIA });
    expect(next.headers['etag']).not.toBe(first.headers['etag']);
    expect(next.json<PassesDocument>().computed_for).toBe('2026-09-30T13:20:00Z');
  });

  it('serves HEAD with headers only', async () => {
    await refresh();
    const head = await app.inject({ method: 'HEAD', url: SOFIA });
    expect(head.statusCode).toBe(200);
    expect(head.headers['etag']).toMatch(/^"/);
  });

  it.each(['42.7_23.3', '42.70_23.30', '48.25_16.25', 'sofia', '42.75_23.25%20'])(
    'refuses the non-grid cell %j with 404',
    async (cell) => {
      await refresh();
      const response = await app.inject({ method: 'GET', url: `/api/v1/passes/${cell}` });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toMatch(/problem\+json/);
    },
  );

  it('refuses a query string', async () => {
    await refresh();
    const response = await app.inject({ method: 'GET', url: `${SOFIA}?_=1` });
    expect(response.statusCode).toBe(400);
  });

  it('answers 503 with Retry-After before any elements exist', async () => {
    const response = await app.inject({ method: 'GET', url: SOFIA });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('300');
    expect(problems).toHaveLength(1);
  });

  it('labels a tampered platform missing, reports it, and still serves the rest', async () => {
    await refresh();
    writeFileSync(join(stateDir, tleElementsPath(43013)), `${OMM_BY_NORAD[43013]!} `);
    const response = await app.inject({ method: 'GET', url: SOFIA });
    expect(response.statusCode).toBe(200);
    const noaa20 = response.json<PassesDocument>().platforms.find((p) => p.id === 'noaa20');
    expect(noaa20?.elements).toBe('missing');
    expect(elementProblems).toEqual(['noaa20: payload does not match its sidecar sha256']);
  });

  it('reports the same refused copy once, not on every request, and again once it changes', async () => {
    await refresh();
    writeFileSync(join(stateDir, tleElementsPath(43013)), `${OMM_BY_NORAD[43013]!} `);
    await app.inject({ method: 'GET', url: SOFIA });
    await app.inject({ method: 'GET', url: '/api/v1/passes/42.25_25.25' });
    await app.inject({ method: 'GET', url: PASS_SWATHS_PATH });
    expect(elementProblems).toEqual(['noaa20: payload does not match its sidecar sha256']);

    await refresh();
    await app.inject({ method: 'GET', url: SOFIA });
    writeFileSync(join(stateDir, tleElementsPath(43013)), `${OMM_BY_NORAD[43013]!} `);
    await app.inject({ method: 'GET', url: SOFIA });
    expect(elementProblems).toHaveLength(2);
  });
});

describe(PASS_SWATHS_PATH, () => {
  it('serves one content-addressed GeoJSON document for the whole box', async () => {
    await refresh();
    const response = await app.inject({ method: 'GET', url: PASS_SWATHS_PATH });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/geo\+json/);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['cache-control']).toBe('public, max-age=240');
    expect(response.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);
    const doc = response.json<SwathsDocument>();
    expect(doc).toMatchObject({
      type: 'FeatureCollection',
      computed_for: '2026-09-30T13:10:00Z',
      predicted: true,
      elements_provider: 'celestrak',
    });
    expect(doc.platforms).toHaveLength(5);
    expect(doc.features.length).toBeGreaterThan(0);
    expect(response.body).not.toMatch(/MEAN_MOTION|BSTAR|NORAD|OBJECT_ID/);
  });

  it('answers If-None-Match with 304 and moves with the bucket', async () => {
    await refresh();
    const first = await app.inject({ method: 'GET', url: PASS_SWATHS_PATH });
    const etag = first.headers['etag'] as string;
    const again = await app.inject({
      method: 'GET',
      url: PASS_SWATHS_PATH,
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
    clock.advanceMinutes(10);
    const next = await app.inject({ method: 'GET', url: PASS_SWATHS_PATH });
    expect(next.headers['etag']).not.toBe(etag);
    expect(next.json<SwathsDocument>().computed_for).toBe('2026-09-30T13:20:00Z');
  });

  it('refuses a query string and answers 503 before any elements exist', async () => {
    const early = await app.inject({ method: 'GET', url: PASS_SWATHS_PATH });
    expect(early.statusCode).toBe(503);
    expect(early.headers['retry-after']).toBe('300');
    await refresh();
    const query = await app.inject({ method: 'GET', url: `${PASS_SWATHS_PATH}?z=5` });
    expect(query.statusCode).toBe(400);
  });
});

describe(`${PASSES_PATH} cloud (F17)`, () => {
  /** A forecast of 20 % at 06z and 80 % at 12z everywhere — linear in between. */
  function writeCloud(high: number): void {
    const grid = cloudGrid(CLOUD_COVER.values);
    const step = (hours: number, pct: number) => ({
      run_at: '2026-09-30T00:00:00Z',
      step_hours: hours,
      valid_at: `2026-09-30T${String(hours).padStart(2, '0')}:00:00Z`,
      cloud_pct: new Array<number>(grid.cols * grid.rows).fill(pct),
    });
    const path = join(stateDir, CLOUD_CURRENT_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        provider: 'ecmwf-open-data',
        model: 'ifs',
        kind: 'forecast',
        param: 'tcc',
        available_at: '2026-09-30T08:10:00Z',
        grid,
        steps: [step(6, 20), step(12, high)],
        cloud_cover_version: 'cloud_cover_v1',
        cloud_cover_digest: 'digest',
      }),
    );
  }

  it('attaches the forecast at each culmination and re-keys the ETag on a new forecast', async () => {
    await refresh();
    const bare = await app.inject({ method: 'GET', url: SOFIA });
    expect(bare.json<PassesDocument>().cloud).toBeNull();

    writeCloud(80);
    const response = await app.inject({ method: 'GET', url: SOFIA });
    expect(response.headers['etag']).not.toBe(bare.headers['etag']);
    const doc = response.json<PassesDocument>();
    expect(doc.cloud).toMatchObject({ kind: 'forecast', runs: ['2026-09-30T00:00:00Z'] });
    const six = Date.parse('2026-09-30T06:00:00Z');
    const twelve = Date.parse('2026-09-30T12:00:00Z');
    const passes = doc.platforms.flatMap((p) => p.passes);
    const inside = passes.filter((p) => {
      const at = Date.parse(p.culmination);
      return at >= six && at <= twelve;
    });
    expect(inside.length).toBeGreaterThan(0);
    for (const pass of passes) {
      const at = Date.parse(pass.culmination);
      expect(pass.cloud_forecast_pct).toBe(
        at >= six && at <= twelve ? Math.round(20 + (60 * (at - six)) / (twelve - six)) : null,
      );
    }

    writeCloud(90);
    const next = await app.inject({ method: 'GET', url: SOFIA });
    expect(next.headers['etag']).not.toBe(response.headers['etag']);
  });

  it('serves the passes without cloud when the stored forecast is malformed', async () => {
    await refresh();
    const path = join(stateDir, CLOUD_CURRENT_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"schema_version":1');
    const response = await app.inject({ method: 'GET', url: SOFIA });
    expect(response.statusCode).toBe(200);
    expect(response.json<PassesDocument>().cloud).toBeNull();
  });
});
