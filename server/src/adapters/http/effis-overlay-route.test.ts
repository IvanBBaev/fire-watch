/**
 * TASKS G4 done-when: "a 200-with-error-image fixture does not poison the cache".
 *
 * Proven end to end over real parts: the committed fixtures in
 * `adapters/effis/__fixtures__/g4/` are answered by an injected `fetch` to the real EFFIS
 * HTTP client, judged by the real classifier with node:zlib, written by the real fs
 * payload and feed-status stores into a temp state dir, and read back through the real
 * route. After every poisoned refresh the route must still serve the good bytes,
 * byte-identical, under their original date.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EFFIS_LAYERS } from '../../core/config/effis-layers.js';
import {
  effisCurrentMetaPath,
  effisCurrentPath,
  payloadStamp,
  runEffisRefresh,
} from '../../core/effis/effis-refresh.js';
import { VirtualClock } from '../../core/ports/clock.js';
import { createEffisHttpClient } from '../effis/effis-http-client.js';
import { zlibInflate } from '../effis/zlib-inflate.js';
import { createFsFeedStatusStore } from '../storage/fs-feed-status-store.js';
import { createFsPayloadStore } from '../storage/fs-payload-store.js';
import {
  EFFIS_OVERLAY_CACHE_CONTROL,
  EFFIS_OVERLAY_SUSPECT_CACHE_CONTROL,
  registerEffisOverlayRoute,
} from './effis-overlay-route.js';
import type { ProblemLogEntry } from './problem.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'effis', '__fixtures__', 'g4');

interface FixtureEntry {
  readonly file: string;
  readonly status: number;
  readonly content_type: string;
  readonly expected_verdict: 'good' | 'reject' | 'suspect';
  readonly expected_rule: string | null;
}

const MANIFEST = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as {
  readonly fixtures: readonly FixtureEntry[];
};
const fixture = (file: string): FixtureEntry => {
  const entry = MANIFEST.fixtures.find((candidate) => candidate.file === file);
  if (entry === undefined) throw new Error(`no fixture ${file}`);
  return entry;
};
const POISONED = MANIFEST.fixtures.filter((entry) => entry.expected_verdict !== 'good');
const GOOD = fixture('good.png');
const GOOD_BYTES = readFileSync(join(FIXTURE_DIR, GOOD.file));

const FWI = EFFIS_LAYERS.values.layers.find((layer) => layer.id === 'fwi');
if (FWI === undefined) throw new Error('fwi layer missing from EFFIS_LAYERS');

const EMPTY_BURNT_AREAS = '{"type":"FeatureCollection","features":[],"totalFeatures":0}';
const UPSTREAM = 'https://effis-upstream.invalid/secret-path/wms';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'fire-watch-g4-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** An upstream that answers the FWI GetMap with `fwi` and the burnt-area WFS with JSON. */
function upstream(fwi: () => FixtureEntry): typeof globalThis.fetch {
  return (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('REQUEST=GetFeature')) {
      return Promise.resolve(
        new Response(EMPTY_BURNT_AREAS, { headers: { 'content-type': 'application/json' } }),
      );
    }
    const entry = fwi();
    return Promise.resolve(
      new Response(readFileSync(join(FIXTURE_DIR, entry.file)), {
        status: entry.status,
        headers: { 'content-type': entry.content_type },
      }),
    );
  };
}

function refresher(clock: VirtualClock) {
  const payloads = createFsPayloadStore(stateDir);
  const feedStatus = createFsFeedStatusStore(stateDir);
  return (entry: FixtureEntry) =>
    runEffisRefresh({
      client: createEffisHttpClient({ clock, baseUrl: UPSTREAM, fetch: upstream(() => entry) }),
      payloads,
      feedStatus,
      clock,
      inflate: zlibInflate,
    });
}

function overlayApp(): { app: FastifyInstance; problems: ProblemLogEntry[] } {
  const problems: ProblemLogEntry[] = [];
  const app = Fastify();
  registerEffisOverlayRoute(app, { stateDir, onProblem: (entry) => problems.push(entry) });
  return { app, problems };
}

function readFeedRow(row: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(stateDir, 'feed-status', `${row.replaceAll(':', '-')}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('G4 done-when — a 200 with an error body never poisons the overlay cache', () => {
  it('keeps serving the last good copy, byte-identical and under its true date, through every poisoned refresh', async () => {
    const clock = new VirtualClock('2026-08-13T10:15:00Z');
    const refresh = refresher(clock);
    const { app } = overlayApp();

    const seeded = await refresh(GOOD);
    expect(seeded.layers.find((layer) => layer.layer === 'fwi')).toMatchObject({
      outcome: 'stored',
      sanity: 'good',
    });
    const goodAt = new Date('2026-08-13T10:15:00Z').toUTCString();

    const first = await app.inject({ method: 'GET', url: '/overlays/effis/fwi.png' });
    expect(first.statusCode).toBe(200);
    expect(sha(first.rawPayload)).toBe(sha(GOOD_BYTES));
    expect(first.headers['last-modified']).toBe(goodAt);

    for (const poisoned of POISONED) {
      clock.advanceHours(6);
      const at = clock.now();
      const report = await refresh(poisoned);
      const fwi = report.layers.find((layer) => layer.layer === 'fwi');
      expect(fwi, poisoned.file).toMatchObject({
        outcome: poisoned.expected_verdict === 'reject' ? 'rejected' : 'suspect',
        sanity: poisoned.expected_verdict,
        sanityRule: poisoned.expected_rule,
        staleAvailable: true,
      });

      // The cache is not poisoned: `current` is the good fixture, byte for byte.
      expect(sha(readFileSync(join(stateDir, effisCurrentPath(FWI)))), poisoned.file).toBe(
        sha(GOOD_BYTES),
      );
      const response = await app.inject({ method: 'GET', url: '/overlays/effis/fwi.png' });
      expect(response.statusCode, poisoned.file).toBe(200);
      expect(sha(response.rawPayload), poisoned.file).toBe(sha(GOOD_BYTES));
      expect(response.headers['x-fire-watch-overlay-state']).toBe('current');
      // True age: the date of the good copy, not of this refresh or this request.
      expect(response.headers['last-modified'], poisoned.file).toBe(goodAt);
      expect(response.headers['x-fire-watch-overlay-available-at']).toBe('2026-08-13T10:15:00Z');

      // The status store recorded the refusal, rule name and all.
      const feedRow = readFeedRow('effis:layers');
      expect(feedRow['last_attempt_at']).toBe(at);
      expect(feedRow['consecutive_failures']).toBeGreaterThan(0);
      expect(String(feedRow['last_error'])).toContain(`fwi: ${String(poisoned.expected_rule)}: `);

      // And the body is kept as evidence, on the shelf its verdict names.
      const shelf =
        poisoned.expected_verdict === 'reject'
          ? `rejected/${payloadStamp(at)}/payload.bin`
          : `suspect/${payloadStamp(at)}/payload.png`;
      const evidence = readFileSync(join(stateDir, 'overlays/effis/fwi', shelf));
      expect(sha(evidence)).toBe(sha(readFileSync(join(FIXTURE_DIR, poisoned.file))));
    }

    // A good refresh afterwards moves `current` and clears the failure streak.
    clock.advanceHours(6);
    await refresh(GOOD);
    expect(readFeedRow('effis:layers')['consecutive_failures']).toBe(0);
    await app.close();
  });

  it('ships a fixture for each poisoning shape the task names', () => {
    expect(POISONED.map((entry) => entry.expected_rule)).toEqual([
      'content_type_mismatch',
      'content_type_mismatch',
      'png_dimensions_mismatch',
      'png_fully_transparent',
    ]);
    expect(POISONED.map((entry) => entry.content_type)).toEqual([
      'text/xml; charset=UTF-8',
      'text/html',
      'image/png',
      'image/png',
    ]);
  });
});

describe('effis overlay route — headers and refusals', () => {
  it('serves the good copy with honest cache headers and nothing from upstream', async () => {
    const clock = new VirtualClock('2026-08-13T10:15:00Z');
    await refresher(clock)(GOOD);
    const { app } = overlayApp();

    const response = await app.inject({ method: 'GET', url: '/overlays/effis/fwi.png' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe(EFFIS_OVERLAY_CACHE_CONTROL);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['age']).toBeUndefined();
    expect(response.headers['etag']).toBeUndefined();
    const everyHeader = JSON.stringify(response.headers);
    expect(everyHeader).not.toContain('effis-upstream');
    expect(everyHeader).not.toContain('secret-path');
    expect(everyHeader).not.toContain(stateDir);

    const json = await app.inject({ method: 'GET', url: '/overlays/effis/ba.json' });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(json.body).toBe(EMPTY_BURNT_AREAS);
    await app.close();
  });

  it('never answers a conditional request with 304 — a revalidation cannot re-anchor the age', async () => {
    const clock = new VirtualClock('2026-08-13T10:15:00Z');
    await refresher(clock)(GOOD);
    const { app } = overlayApp();
    const response = await app.inject({
      method: 'GET',
      url: '/overlays/effis/fwi.png',
      headers: { 'if-modified-since': new Date('2030-01-01T00:00:00Z').toUTCString() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.byteLength).toBe(GOOD_BYTES.byteLength);
    await app.close();
  });

  it('answers HEAD with the GET headers', async () => {
    // Node's HTTP server drops the body of a HEAD reply; light-my-request does not, so the
    // body is not asserted — the snapshot route's precedent.
    const clock = new VirtualClock('2026-08-13T10:15:00Z');
    await refresher(clock)(GOOD);
    const { app } = overlayApp();
    const response = await app.inject({ method: 'HEAD', url: '/overlays/effis/fwi.png' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(EFFIS_OVERLAY_CACHE_CONTROL);
    expect(response.headers['last-modified']).toBe(new Date('2026-08-13T10:15:00Z').toUTCString());
    await app.close();
  });

  it('passes a suspect body through for at most 60 s when no good copy exists (A2.2)', async () => {
    const clock = new VirtualClock('2026-08-13T10:15:00Z');
    await refresher(clock)(fixture('blank.png'));
    const { app } = overlayApp();
    const response = await app.inject({ method: 'GET', url: '/overlays/effis/fwi.png' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(EFFIS_OVERLAY_SUSPECT_CACHE_CONTROL);
    expect(response.headers['x-fire-watch-overlay-state']).toBe('suspect');
    expect(sha(response.rawPayload)).toBe(sha(readFileSync(join(FIXTURE_DIR, 'blank.png'))));
    await app.close();
  });

  it('refuses with a 503 when nothing servable exists — a rejected body is never passed through', async () => {
    const clock = new VirtualClock('2026-08-13T10:15:00Z');
    await refresher(clock)(fixture('service-exception.xml.body'));
    const { app } = overlayApp();
    const response = await app.inject({ method: 'GET', url: '/overlays/effis/fwi.png' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['retry-after']).toBe('60');
    expect(response.body).not.toContain('ServiceException');
    await app.close();
  });

  it('refuses a payload that does not match its sidecar, after one retry', async () => {
    const clock = new VirtualClock('2026-08-13T10:15:00Z');
    await refresher(clock)(GOOD);
    writeFileSync(
      join(stateDir, effisCurrentPath(FWI)),
      readFileSync(join(FIXTURE_DIR, 'blank.png')),
    );
    const { app, problems } = overlayApp();
    const response = await app.inject({ method: 'GET', url: '/overlays/effis/fwi.png' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ title: 'Overlay temporarily unavailable' });
    expect(response.body).not.toContain(stateDir);
    expect(problems).toHaveLength(1);
    expect(String((problems[0]?.error as Error).cause)).toContain('sha256');
    await app.close();
  });

  it('refuses a current copy whose sidecar does not say good', async () => {
    const clock = new VirtualClock('2026-08-13T10:15:00Z');
    await refresher(clock)(GOOD);
    const metaPath = join(stateDir, effisCurrentMetaPath(FWI));
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(metaPath, JSON.stringify({ ...meta, sanity: 'reject' }));
    const { app } = overlayApp();
    const response = await app.inject({ method: 'GET', url: '/overlays/effis/fwi.png' });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it.each([
    ['an unknown layer', '/overlays/effis/fwi.json', 404],
    ['a path that tries to climb out', '/overlays/effis/..%2F..%2Ffeed-status', 404],
    ['a query string', '/overlays/effis/fwi.png?_=1', 400],
  ])('refuses %s', async (_name, url, status) => {
    const { app } = overlayApp();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(status);
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('refuses a relative state dir at registration', () => {
    expect(() => {
      registerEffisOverlayRoute(Fastify(), { stateDir: 'relative/state' });
    }).toThrow(RangeError);
  });
});
