import type { ClientConfigDocument, ClientImageryBlock } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { DatabaseProbe, FreshnessReader } from '../../core/ports/freshness-reader.js';
import {
  CLIENT_CONFIG_CACHE_CONTROL,
  CLIENT_CONFIG_PATH,
  type ClientConfigRouteDeps,
} from './client-config-route.js';
import { createHealthServer } from './health-server.js';
import type { ProblemLogEntry } from './problem.js';

const NOW = '2026-07-14T10:15:00Z';

const forbidden = {
  reader: {
    readObservations: () => Promise.reject(new Error('the probe reader must not be touched')),
  } satisfies FreshnessReader,
  probe: {
    ping: () => Promise.reject(new Error('the probe must not be touched')),
  } satisfies DatabaseProbe,
};

const OFFERED: ClientConfigDocument = {
  transport: 'sse',
  poll_interval_ms: 45_000,
  static_snapshot_url: 'https://cdn.example/snapshot.json',
};

/** The whole server, so the probe hook's exemption is part of what is proven. */
function server(
  clientConfig: Partial<ClientConfigRouteDeps> = {},
  rateLimit?: { limit: number; windowMs: number },
): { app: ReturnType<typeof createHealthServer>; problems: ProblemLogEntry[] } {
  const problems: ProblemLogEntry[] = [];
  const app = createHealthServer({
    reader: forbidden.reader,
    probe: forbidden.probe,
    clock: new VirtualClock(NOW),
    expected: ['firms:viirs:noaa20'],
    ...(rateLimit === undefined ? {} : { rateLimit }),
    clientConfig: {
      document: () => OFFERED,
      onProblem: (entry) => problems.push(entry),
      ...clientConfig,
    },
  });
  return { app, problems };
}

describe('GET /api/v1/client-config', () => {
  it('serves exactly the three fields of the fleet-control document, as JSON', async () => {
    const { app } = server();
    const response = await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      transport: 'sse',
      poll_interval_ms: 45_000,
      static_snapshot_url: 'https://cdn.example/snapshot.json',
    });
    await app.close();
  });

  it('says what the wiring says now, on every request', async () => {
    let current: ClientConfigDocument = OFFERED;
    const { app } = server({ document: () => current });

    const before = await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH });
    expect(before.json()).toMatchObject({ transport: 'sse' });

    current = { transport: 'poll', poll_interval_ms: 60_000, static_snapshot_url: null };
    const after = await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH });
    expect(after.json()).toEqual({
      transport: 'poll',
      poll_interval_ms: 60_000,
      static_snapshot_url: null,
    });
    await app.close();
  });

  it('is edge-cacheable for one config TTL and nothing longer', async () => {
    const { app } = server();
    const response = await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH });

    expect(response.headers['cache-control']).toBe(CLIENT_CONFIG_CACHE_CONTROL);
    expect(CLIENT_CONFIG_CACHE_CONTROL).toBe('public, max-age=30');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    // No ETag: the body is smaller than a conditional request.
    expect(response.headers.etag).toBeUndefined();
    // The probe hook's no-store must not have touched this reply.
    expect(response.headers['cdn-cache-control']).toBeUndefined();
    expect(response.headers['cloudflare-cdn-cache-control']).toBeUndefined();
    expect(response.headers.pragma).toBeUndefined();
    await app.close();
  });

  it('answers HEAD with the same headers', async () => {
    const { app } = server();
    const response = await app.inject({ method: 'HEAD', url: CLIENT_CONFIG_PATH });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe(CLIENT_CONFIG_CACHE_CONTROL);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    await app.close();
  });

  it('extends the document with nothing the wiring may carry beyond the wire shape', async () => {
    const leaky = { ...OFFERED, hostname: 'vm-1', version: '1.2.3' } as ClientConfigDocument;
    const { app } = server({ document: () => leaky });
    const response = await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH });
    expect(Object.keys(response.json()).sort()).toEqual([
      'poll_interval_ms',
      'static_snapshot_url',
      'transport',
    ]);
    await app.close();
  });

  it('serves the imagery block only while the wiring has one, rebuilt member by member', async () => {
    const imagery = {
      tile_url_template: 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}',
      api_key: 'AAPK-test',
    };
    let current: ClientConfigDocument = {
      ...OFFERED,
      imagery: { ...imagery, secret: 'x' } as ClientImageryBlock,
    };
    const { app } = server({ document: () => current });

    const on = await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH });
    expect(on.json()).toEqual({ ...OFFERED, imagery });

    // A2.3: off is *absent*, not null — an old client and a new one read the same document.
    current = OFFERED;
    const off = await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH });
    expect(off.json()).toEqual(OFFERED);
    expect(off.body).not.toContain('imagery');
    await app.close();
  });

  it('refuses any query string, so the cacheable URL space is exactly one path', async () => {
    const { app, problems } = server();
    const response = await app.inject({ method: 'GET', url: `${CLIENT_CONFIG_PATH}?_=1` });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.headers['cache-control']).toMatch(/no-store/);
    expect(response.json()).toMatchObject({
      status: 400,
      title: 'Invalid query',
      instance: CLIENT_CONFIG_PATH,
    });
    expect(problems).toHaveLength(1);
    await app.close();
  });

  it('answers no per-IP limiter: the document is not a probe', async () => {
    const { app } = server({}, { limit: 1, windowMs: 60_000 });
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(429);
    const response = await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('is absent from a server wired without it', async () => {
    const app = createHealthServer({
      reader: forbidden.reader,
      probe: forbidden.probe,
      clock: new VirtualClock(NOW),
      expected: ['firms:viirs:noaa20'],
    });
    const response = await app.inject({ method: 'GET', url: CLIENT_CONFIG_PATH });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
