/**
 * The V2-E3 CEMS route over a real fs payload store (real sha256 sidecar) in a temp state
 * dir.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CEMS_CURRENT_META_PATH,
  CEMS_CURRENT_PATH,
  CEMS_MAX_STALENESS_MS,
} from '../../core/cems/cems-document.js';
import { VirtualClock, epochMsFromIso } from '../../core/ports/clock.js';
import { createFsPayloadStore } from '../storage/fs-payload-store.js';
import {
  CEMS_OVERLAY_CACHE_CONTROL,
  CEMS_OVERLAY_PATH,
  cemsAttribution,
  registerCemsOverlayRoute,
  type CemsOverlayResponse,
} from './cems-overlay-route.js';
import type { ProblemLogEntry } from './problem.js';

const AVAILABLE_AT = '2026-10-24T09:00:00Z';
const NOW_ISO = '2026-10-24T09:20:00Z';

const DOCUMENT = {
  schema_version: 1,
  available_at: AVAILABLE_AT,
  activations: [
    {
      code: 'EMSR822',
      name: 'Wildfire in Bulgaria and Republic of Serbia',
      event_time: '2025-07-26T08:00:00Z',
      activation_time: '2025-07-26T20:04:00Z',
      last_update: '2025-08-05T15:29:32.927Z',
      closed: true,
      countries: ['Bulgaria'],
      centroid: [23.416672, 41.721618],
      aois: [[23.1987, 41.6323, 23.3816, 41.75]],
      aois_status: 'public',
    },
  ],
};

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'fire-watch-cems-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

async function recordDocument(): Promise<void> {
  const store = createFsPayloadStore(stateDir);
  const written = await store.writeText(CEMS_CURRENT_PATH, JSON.stringify(DOCUMENT));
  await store.writeText(CEMS_CURRENT_META_PATH, JSON.stringify({ sha256: written.sha256 }));
}

function cemsApp(
  now: string,
  rateLimit?: { limit: number; windowMs: number },
): { app: FastifyInstance; problems: ProblemLogEntry[] } {
  const problems: ProblemLogEntry[] = [];
  const app = Fastify();
  registerCemsOverlayRoute(app, {
    stateDir,
    clock: new VirtualClock(now),
    onProblem: (entry) => problems.push(entry),
    rateLimit,
  });
  return { app, problems };
}

describe('GET /overlays/cems/activations.json', () => {
  it('serves the stored activations with honest time, cache headers and the Copernicus credit', async () => {
    await recordDocument();
    const { app } = cemsApp(NOW_ISO);

    const response = await app.inject({ method: 'GET', url: CEMS_OVERLAY_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe(CEMS_OVERLAY_CACHE_CONTROL);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['etag']).toMatch(/^"c1-[0-9a-f]{32}"$/);
    expect(response.headers['x-fire-watch-overlay-available-at']).toBe(AVAILABLE_AT);
    expect(response.headers['last-modified']).toBe(
      new Date(epochMsFromIso(AVAILABLE_AT)).toUTCString(),
    );
    const body = response.json<CemsOverlayResponse>();
    expect(body.activations).toEqual(DOCUMENT.activations);
    expect(body.attribution).toHaveLength(1);
    expect(body.attribution[0]).toMatchObject({
      id: 'copernicus-ems',
      href: 'https://mapping.emergency.copernicus.eu/',
    });
    expect(body.attribution[0]?.text).toContain('(© 2026 European Union)');
  });

  it('answers a matching If-None-Match with 304', async () => {
    await recordDocument();
    const { app } = cemsApp(NOW_ISO);
    const first = await app.inject({ method: 'GET', url: CEMS_OVERLAY_PATH });
    const second = await app.inject({
      method: 'GET',
      url: CEMS_OVERLAY_PATH,
      headers: { 'if-none-match': String(first.headers['etag']) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('is a 503 before any list is recorded', async () => {
    const { app } = cemsApp(NOW_ISO);
    const response = await app.inject({ method: 'GET', url: CEMS_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('900');
  });

  it('is a 503, not "no activation", once the list read is stale', async () => {
    await recordDocument();
    const late = new Date(epochMsFromIso(AVAILABLE_AT) + CEMS_MAX_STALENESS_MS + 1000);
    const { app } = cemsApp(late.toISOString());
    const response = await app.inject({ method: 'GET', url: CEMS_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ detail: string }>().detail).toMatch(/too old/);
  });

  it('is a 503 when the document does not match its sidecar', async () => {
    await recordDocument();
    const path = join(stateDir, CEMS_CURRENT_PATH);
    writeFileSync(path, readFileSync(path, 'utf8').replace('EMSR822', 'EMSR823'));
    const { app, problems } = cemsApp(NOW_ISO);
    const response = await app.inject({ method: 'GET', url: CEMS_OVERLAY_PATH });
    expect(response.statusCode).toBe(503);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('refuses a query string', async () => {
    await recordDocument();
    const { app } = cemsApp(NOW_ISO);
    const response = await app.inject({ method: 'GET', url: `${CEMS_OVERLAY_PATH}?x=1` });
    expect(response.statusCode).toBe(400);
  });

  it('rate-limits per client', async () => {
    await recordDocument();
    const { app } = cemsApp(NOW_ISO, { limit: 2, windowMs: 60_000 });
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push((await app.inject({ method: 'GET', url: CEMS_OVERLAY_PATH })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
  });

  it('refuses a relative state dir', () => {
    expect(() =>
      registerCemsOverlayRoute(Fastify(), { stateDir: 'state', clock: new VirtualClock(NOW_ISO) }),
    ).toThrow(RangeError);
  });
});

describe('cemsAttribution', () => {
  it('renders the Copernicus EMS credit with the year of the list read', () => {
    const [credit] = cemsAttribution('2027-01-01T00:00:09Z');
    expect(credit?.text).toContain(
      'Copernicus Emergency Management Service (© 2027 European Union)',
    );
  });
});
