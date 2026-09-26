/**
 * The local smoke mode: the real driver against the real read-path routes, in-process, at
 * a tiny scale — so the whole chain (scenario → driver → recorder → evaluation → report)
 * is exercised on every `verify`, and a server change that breaks what the load test
 * measures breaks here first.
 *
 * The stack, all on 127.0.0.1:
 *
 *   * **origin** — `createHealthServer` with the snapshot, stream and client-config routes,
 *     a fixture snapshot reader, a real stream hub with a small cap, and the real demotion
 *     controller fed by the real `createTransportWatch` tick (lag/CPU samplers answer
 *     "nothing yet", so only the connection trigger can fire — the one L-3 exercises);
 *   * **edge** — a few-line emulator of what staging's Cloudflare does for these routes:
 *     caches by `s-maxage`/`max-age`, coalesces misses, answers `If-None-Match` with a 304,
 *     labels every answer with `cf-cache-status`, and passes the stream through unbuffered;
 *   * **T2** — a static server answering the snapshot copy with `x-amz-meta-generated-at`.
 *
 * The origin-kill hook closes the origin. What is asserted is what is deterministic at
 * this scale — demotion observed, the cap held, every stream closed cleanly, no 5xx, T2
 * serving, the config flip measured — not latency, which a shared CI runner cannot
 * promise. When the sandbox forbids a loopback listener, the suite skips.
 */

import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemClock } from '../../../server/src/adapters/clock/system-clock.js';
import { CLIENT_CONFIG_PATH } from '../../../server/src/adapters/http/client-config-route.js';
import { createHealthServer } from '../../../server/src/adapters/http/health-server.js';
import {
  CURSOR_PARAM as SNAPSHOT_CURSOR_PARAM,
  SNAPSHOT_PATH,
} from '../../../server/src/adapters/http/snapshot-route.js';
import { STREAM_PATH } from '../../../server/src/adapters/http/stream-route.js';
import { createTransportWatch } from '../../../server/src/app/health-wiring.js';
import type {
  ActiveEventRow,
  SnapshotReader,
} from '../../../server/src/core/ports/snapshot-reader.js';
import { createStreamHub } from '../../../server/src/core/stream/stream-hub.js';
import { createDemotionController } from '../../../server/src/core/transport/demotion.js';
import { ROUTES, runScenario } from '../adapters/driver.js';
import { evaluate } from '../evaluate.js';
import type { MetricsData } from '../metrics.js';
import { buildReport, renderMarkdown } from '../report.js';
import { buildScenario, type Scenario } from '../scenario.js';

const CAP = 5;
const EDGE_CONFIG_TTL_MS = 100;
const T2_OBJECT_AGE_S = 60;

async function canListen(): Promise<boolean> {
  const probe = createServer();
  try {
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    probe.close();
    return true;
  } catch {
    return false;
  }
}

const loopback = await canListen();

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

const ROWS: readonly ActiveEventRow[] = [101, 102, 103].map((seq, i) => ({
  publicId: `evt-${seq}`,
  seq,
  status: 'active' as const,
  score: 0.7,
  lon: 23.3 + i / 10,
  lat: 42.6,
  startedAt: Date.parse('2026-09-24T08:00:00Z'),
  lastDetectionAt: Date.parse('2026-09-24T09:00:00Z'),
  detectionCount: 3,
  nearestPlace: null,
}));

const fixtureReader: SnapshotReader = {
  readActiveSet: (afterSeq) =>
    Promise.resolve({ maxSeq: 103, events: ROWS.filter((row) => row.seq > afterSeq) }),
  readSourceObservations: (ids) =>
    Promise.resolve(ids.map((sourceId) => ({ sourceId, lastObservedAt: null }))),
};

interface CachedAnswer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly expiresAt: number;
}

/** Freshness lifetime an edge would give this answer: `s-maxage`, else `max-age`. */
function ttlMs(headers: IncomingHttpHeaders): number {
  const cc = String(headers['cache-control'] ?? '');
  const shared = /s-maxage=(\d+)/.exec(cc);
  const own = /(?:^|[\s,])max-age=(\d+)/.exec(cc);
  return Number((shared ?? own)?.[1] ?? 0) * 1000;
}

/**
 * The edge emulator: caches the two edge-cached read paths, passes everything else
 * (the stream) straight through. `ttlOverrideMs` shortens a path's lifetime so a smoke
 * run a few seconds long still sees the client-config document change.
 */
function createEdge(origin: () => string, ttlOverrideMs: Readonly<Record<string, number>>): Server {
  const cache = new Map<string, CachedAnswer>();
  const inflight = new Map<string, Promise<CachedAnswer>>();

  const fetchOrigin = (url: string): Promise<CachedAnswer> =>
    new Promise((resolve, reject) => {
      const upstream = httpRequest(`${origin()}${url}`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const path = url.split('?')[0] ?? url;
          const lifetime = ttlOverrideMs[path] ?? ttlMs(res.headers);
          resolve({
            status: res.statusCode ?? 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
            expiresAt: Date.now() + (res.statusCode === 200 ? lifetime : 0),
          });
        });
        res.on('error', reject);
      });
      upstream.on('error', reject);
      upstream.end();
    });

  return createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? url;
    if (path !== SNAPSHOT_PATH && path !== CLIENT_CONFIG_PATH) {
      // Pass-through, unbuffered: the SSE route.
      const upstream = httpRequest(
        `${origin()}${url}`,
        { method: req.method, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, { ...up.headers, 'cf-cache-status': 'DYNAMIC' });
          up.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      res.on('close', () => upstream.destroy());
      upstream.end();
      return;
    }

    const answer = (entry: CachedAnswer, status: string): void => {
      const etag = entry.headers.etag;
      const conditional = etag !== undefined && req.headers['if-none-match'] === etag;
      const { 'content-length': _length, connection: _connection, ...headers } = entry.headers;
      res.writeHead(conditional ? 304 : entry.status, { ...headers, 'cf-cache-status': status });
      res.end(conditional ? undefined : entry.body);
    };

    const cached = cache.get(url);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      answer(cached, 'HIT');
      return;
    }
    let pending = inflight.get(url);
    if (pending === undefined) {
      pending = fetchOrigin(url).finally(() => inflight.delete(url));
      inflight.set(url, pending);
    }
    pending.then(
      (entry) => {
        if (entry.status === 200) cache.set(url, entry);
        answer(entry, 'MISS');
      },
      () => {
        // The origin is gone and nothing is cached: what Cloudflare says.
        res.writeHead(521, { 'cf-cache-status': 'MISS' });
        res.end();
      },
    );
  });
}

describe.skipIf(!loopback)('smoke: the driver against the in-process read path', () => {
  const servers: Server[] = [];
  let origin: ReturnType<typeof createHealthServer>;
  let stopWatch: () => void = () => undefined;
  let scenario: Scenario;
  let metrics: MetricsData;
  let originClosed = false;

  beforeAll(async () => {
    const hub = createStreamHub({ maxConnections: CAP, maxPerClient: 1_000 });
    const controller = createDemotionController({
      clock: systemClock,
      config: {
        connectionCap: CAP,
        lagP99ThresholdMs: 200,
        cpuThresholdFraction: 0.8,
        sustainMs: 60_000,
        // Longer than the run: once demoted, the fleet stays on polling.
        reofferMs: 3_600_000,
        sseEnabled: true,
      },
    });
    const watch = createTransportWatch({
      hub,
      controller,
      lag: { sampleP99Ms: () => null },
      cpu: { sampleBusyFraction: () => null },
      log: { note: () => undefined },
    });
    const timer = setInterval(watch, 50);
    stopWatch = () => clearInterval(timer);

    let t2Url = '';
    origin = createHealthServer({
      reader: {
        readObservations: () => Promise.reject(new Error('the smoke never probes')),
      },
      probe: { ping: () => Promise.reject(new Error('the smoke never probes')) },
      clock: systemClock,
      expected: ['firms:viirs:noaa20'],
      snapshot: { reader: fixtureReader, clock: systemClock, sources: ['firms:viirs:noaa20'] },
      stream: {
        hub,
        offered: () => controller.transport() === 'sse',
        pump: {
          ready: () => true,
          replayAfter: () => ({ kind: 'reset', reason: 'unknown' }),
          freshness: () => null,
        },
      },
      clientConfig: {
        document: () => ({
          transport: controller.transport(),
          poll_interval_ms: 45_000,
          static_snapshot_url: t2Url,
        }),
      },
    });
    await origin.listen({ port: 0, host: '127.0.0.1' });
    const originUrl = `http://127.0.0.1:${(origin.server.address() as AddressInfo).port}`;

    const edge = createEdge(() => originUrl, { [CLIENT_CONFIG_PATH]: EDGE_CONFIG_TTL_MS });
    const t2 = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-amz-meta-generated-at': new Date(Date.now() - T2_OBJECT_AGE_S * 1000).toISOString(),
      });
      res.end('{"events":[]}');
    });
    servers.push(edge, t2);
    const edgeUrl = await listen(edge);
    t2Url = `${await listen(t2)}/snapshot.json`;

    scenario = buildScenario({
      baseline: {
        label: 'smoke',
        source: 'planning',
        sessions: 60,
        snapshotRequestsPerMinute: 1_200,
        sseConnections: 12,
      },
      assumptions: {
        meanSessionMinutes: 0.2,
        pollIntervalMs: 45_000,
        safetySnapshotIntervalMs: 600_000,
        t2ShareAfterOriginKill: 1,
        t2ObjectAgeBudgetSeconds: 300,
      },
      multiplier: 1,
      sseCap: CAP,
      durationsMs: { ramp: 500, steady: 2_500, originKill: 700 },
    });
    metrics = await runScenario({
      scenario,
      baseUrl: edgeUrl,
      t2Url,
      cacheStatusHeader: 'cf-cache-status',
      seed: 7,
      maxInFlight: 500,
      requestTimeoutMs: 2_000,
      onPhaseStart: async (phase) => {
        if (phase !== 'origin-kill') return;
        stopWatch();
        await origin.close();
        originClosed = true;
      },
    });
  }, 30_000);

  afterAll(async () => {
    stopWatch();
    if (!originClosed) await origin.close();
    await Promise.all(servers.map(close));
  });

  it('speaks the routes the server serves', () => {
    expect(ROUTES).toEqual({
      snapshot: SNAPSHOT_PATH,
      snapshotCursorParam: SNAPSHOT_CURSOR_PARAM,
      clientConfig: CLIENT_CONFIG_PATH,
      stream: STREAM_PATH,
    });
  });

  it('drives a demotion and judges it clean', () => {
    const { metrics: table, verdicts } = evaluate(scenario, metrics);
    const state = (id: string): string | undefined => verdicts.find((v) => v.id === id)?.state;

    expect(table.ssePeakOpen).toBeGreaterThan(0);
    expect(state('sse-peak-open')).toBe('pass');
    expect(state('sse-demotion-observed')).toBe('pass');
    expect(state('sse-unclean-closes')).toBe('pass');
    expect(state('sse-unexpected-status')).toBe('pass');
    // The cap is reached during the ramp or the hold, whichever the timing gives.
    const capacityDegrades = Object.values(metrics.phases).reduce(
      (sum, phase) => sum + (phase.sse.degradeFrames['capacity'] ?? 0),
      0,
    );
    expect(capacityDegrades).toBeGreaterThan(0);
    // Told `poll` within one (shortened) edge lifetime plus a few config arrivals.
    expect(state('client-config-flip')).toBe('pass');
    expect(metrics.clientConfig.observations['poll'] ?? 0).toBeGreaterThan(0);
  });

  it('serves T1 through the edge and T2 after the kill, without a 5xx', () => {
    const { metrics: table, verdicts } = evaluate(scenario, metrics);
    const state = (id: string): string | undefined => verdicts.find((v) => v.id === id)?.state;

    expect(state('map-client-5xx')).toBe('pass');
    expect(table.edgeHitRatio).not.toBeNull();
    expect(state('edge-hit-ratio')).toBe('pass');
    expect(metrics.phases.steady.streams.snapshot.status['304'] ?? 0).toBeGreaterThan(0);
    expect(state('t2-success-ratio')).toBe('pass');
    expect(table.t2MaxObjectAgeSeconds).toBeGreaterThanOrEqual(T2_OBJECT_AGE_S);
    expect(state('t2-max-object-age')).toBe('pass');
  });

  it('writes a report that names the run a rehearsal', () => {
    const report = buildReport(scenario, metrics, {
      startedAt: '2026-09-24T00:00:00.000Z',
      finishedAt: '2026-09-24T00:00:04.000Z',
      target: { baseUrl: 'http://edge', t2Url: 'http://t2' },
      seed: 7,
      generator: 'smoke',
    });
    expect(report.evaluation.rehearsal).toBe(true);
    expect(renderMarkdown(report)).toContain('(rehearsal)');
  });
});
