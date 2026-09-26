import type { FreshnessRowId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { VirtualClock, epochMsFromIso } from '../../core/ports/clock.js';
import type { DatabaseProbe, FreshnessReader } from '../../core/ports/freshness-reader.js';
import type {
  ActiveEventRow,
  ActiveSetRead,
  SnapshotReader,
  SourceObservationRow,
} from '../../core/ports/snapshot-reader.js';
import { SNAPSHOT_SCHEMA_VERSION, snapshotEtag } from '../../core/snapshot/snapshot-builder.js';
import { createHealthServer } from './health-server.js';
import type { ProblemLogEntry } from './problem.js';
import {
  SNAPSHOT_CACHE_CONTROL,
  SNAPSHOT_PATH,
  registerSnapshotRoute,
  type SnapshotRouteDeps,
} from './snapshot-route.js';

const NOW = '2026-07-14T10:15:00Z';
const SOURCES = ['firms:viirs:noaa20', 'firms:viirs:snpp'] as const;

function row(overrides: Partial<ActiveEventRow> = {}): ActiveEventRow {
  return {
    publicId: 'fw-2026-abc123',
    seq: 1040,
    status: 'active',
    score: 0.55,
    lon: 25.123456,
    lat: 42.654321,
    startedAt: epochMsFromIso('2026-07-13T09:00:00Z'),
    lastDetectionAt: epochMsFromIso('2026-07-14T09:40:00Z'),
    detectionCount: 7,
    nearestPlace: { name_bg: 'Карлово', name_en: 'Karlovo', lat: 42.64, lon: 24.8 },
    ...overrides,
  };
}

interface FakeReader extends SnapshotReader {
  readonly activeSetCalls: number[];
  readonly sourceCalls: (readonly string[])[];
}

/** Answers with `read` for any cursor, so a test controls the mark and the members. */
function reader(read: ActiveSetRead, sources: readonly SourceObservationRow[] = []): FakeReader {
  const activeSetCalls: number[] = [];
  const sourceCalls: (readonly string[])[] = [];
  return {
    activeSetCalls,
    sourceCalls,
    readActiveSet: (afterSeq) => {
      activeSetCalls.push(afterSeq);
      return Promise.resolve({
        maxSeq: read.maxSeq,
        events: read.events.filter((event) => event.seq > afterSeq),
      });
    },
    readSourceObservations: (ids) => {
      sourceCalls.push(ids);
      return Promise.resolve(sources);
    },
  };
}

function failingReader(error: Error): SnapshotReader {
  return {
    readActiveSet: () => Promise.reject(error),
    readSourceObservations: () => Promise.reject(error),
  };
}

const EXPECTED: readonly FreshnessRowId[] = ['firms:viirs:noaa20'];
const forbidden = {
  reader: {
    readObservations: () => Promise.reject(new Error('the probe reader must not be touched')),
  } satisfies FreshnessReader,
  probe: {
    ping: () => Promise.reject(new Error('the probe must not be touched')),
  } satisfies DatabaseProbe,
};

/** The whole server, so the probe hook's exemption is part of what is proven. */
function server(
  snapshot: Partial<SnapshotRouteDeps> & Pick<SnapshotRouteDeps, 'reader'>,
  rateLimit?: { limit: number; windowMs: number },
): ReturnType<typeof createHealthServer> {
  return createHealthServer({
    reader: forbidden.reader,
    probe: forbidden.probe,
    clock: new VirtualClock(NOW),
    expected: EXPECTED,
    ...(rateLimit === undefined ? {} : { rateLimit }),
    snapshot: {
      clock: new VirtualClock(NOW),
      sources: SOURCES,
      ...snapshot,
    },
  });
}

const ONE_EVENT: ActiveSetRead = { maxSeq: 1042, events: [row()] };

describe('GET /snapshot.json', () => {
  it('serves the full active set as the GeoJSON document the web parser guards', async () => {
    const app = server({
      reader: reader(ONE_EVENT, [
        { sourceId: 'firms:viirs:noaa20', lastObservedAt: epochMsFromIso('2026-07-14T09:40:00Z') },
        { sourceId: 'firms:viirs:snpp', lastObservedAt: null },
      ]),
    });
    const response = await app.inject({ method: 'GET', url: SNAPSHOT_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      type: 'FeatureCollection',
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      generated_at: NOW,
      max_seq: 1042,
      partial: false,
      sources: [
        { source_id: 'firms:viirs:noaa20', last_observed_at: '2026-07-14T09:40:00Z' },
        { source_id: 'firms:viirs:snpp', last_observed_at: null },
      ],
    });
    expect((body as { features: unknown[] }).features).toHaveLength(1);
    expect(
      (body as { features: { properties: { score_bucket: string } }[] }).features[0],
    ).toMatchObject({
      id: 'fw-2026-abc123',
      geometry: { type: 'Point', coordinates: [25.123456, 42.654321] },
      properties: { seq: 1040, status: 'active', score_bucket: 'likely' },
    });
    expect((body as { attribution: unknown[] }).attribution.length).toBeGreaterThan(0);
  });

  it('asks the reader about exactly the configured sources, in order', async () => {
    const fake = reader(ONE_EVENT);
    await server({ reader: fake }).inject({ method: 'GET', url: SNAPSHOT_PATH });
    expect(fake.sourceCalls).toEqual([SOURCES]);
  });

  it('carries the D1 cache rule and an ETag derived from the global mark', async () => {
    const response = await server({ reader: reader(ONE_EVENT) }).inject({
      method: 'GET',
      url: SNAPSHOT_PATH,
    });
    expect(response.headers['cache-control']).toBe(SNAPSHOT_CACHE_CONTROL);
    expect(response.headers.etag).toBe(snapshotEtag(1042));
    // The probe hook's no-store must not have touched this reply.
    expect(response.headers['cdn-cache-control']).toBeUndefined();
    expect(response.headers.pragma).toBeUndefined();
  });

  it('is a 304 when If-None-Match carries the current tag, without building the body', async () => {
    const fake = reader(ONE_EVENT);
    const response = await server({ reader: fake }).inject({
      method: 'GET',
      url: SNAPSHOT_PATH,
      headers: { 'if-none-match': snapshotEtag(1042) },
    });
    expect(response.statusCode).toBe(304);
    expect(response.body).toBe('');
    expect(response.headers.etag).toBe(snapshotEtag(1042));
    expect(response.headers['cache-control']).toBe(SNAPSHOT_CACHE_CONTROL);
    // The sources query is skipped: the 304 costs one statement, the tag comparison.
    expect(fake.sourceCalls).toEqual([]);
  });

  it('compares tags weakly and accepts a list, as RFC 9110 says', async () => {
    const app = server({ reader: reader(ONE_EVENT) });
    for (const header of [`W/${snapshotEtag(1042)}`, `"stale", ${snapshotEtag(1042)}`, '*']) {
      const response = await app.inject({
        method: 'GET',
        url: SNAPSHOT_PATH,
        headers: { 'if-none-match': header },
      });
      expect(response.statusCode, header).toBe(304);
    }
  });

  it('answers 200 again the moment the mark moves — a removal is a new tag', async () => {
    // R1: the registry's max seq changed although the returned set did not shrink here;
    // what matters is that the tag the client holds no longer matches.
    const response = await server({
      reader: reader({ maxSeq: 1043, events: [row()] }),
    }).inject({
      method: 'GET',
      url: SNAPSHOT_PATH,
      headers: { 'if-none-match': snapshotEtag(1042) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(snapshotEtag(1043));
  });

  it('answers a cursor with only the newer rows, flagged partial, under the global mark', async () => {
    const fake = reader({
      maxSeq: 1050,
      events: [
        row({ publicId: 'fw-2026-old', seq: 1040 }),
        row({ publicId: 'fw-2026-new', seq: 1047 }),
      ],
    });
    const response = await server({ reader: fake }).inject({
      method: 'GET',
      url: `${SNAPSHOT_PATH}?updated_after_seq=1042`,
    });
    expect(response.statusCode).toBe(200);
    expect(fake.activeSetCalls).toEqual([1042]);
    const body = response.json<{ partial: boolean; max_seq: number; features: { id: string }[] }>();
    expect(body.partial).toBe(true);
    expect(body.max_seq).toBe(1050);
    expect(body.features.map((feature) => feature.id)).toEqual(['fw-2026-new']);
    // Same tag as the full read: a cursor client and a full client agree on what "current" is.
    expect(response.headers.etag).toBe(snapshotEtag(1050));
  });

  it('answers HEAD with the GET headers', async () => {
    // Node's HTTP server drops the body of a HEAD reply; light-my-request does not, so the
    // body is not asserted here — the headers are what a HEAD client comes for.
    const response = await server({ reader: reader(ONE_EVENT) }).inject({
      method: 'HEAD',
      url: SNAPSHOT_PATH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(snapshotEtag(1042));
    expect(response.headers['cache-control']).toBe(SNAPSHOT_CACHE_CONTROL);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('allows any origin to read it, and nothing more', async () => {
    const response = await server({ reader: reader(ONE_EVENT) }).inject({
      method: 'GET',
      url: SNAPSHOT_PATH,
      headers: { origin: 'https://embed.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
  });

  it('is not rate-limited per client, however exhausted the probe limiter is', async () => {
    const app = server({ reader: reader(ONE_EVENT) }, { limit: 1, windowMs: 60_000 });
    // Spend the one probe request this client gets…
    await app.inject({ method: 'GET', url: '/readyz' });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(429);
    // …and the snapshot still answers.
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: 'GET', url: SNAPSHOT_PATH })).statusCode).toBe(200);
    }
  });

  it('serves an empty registry as an empty collection with mark 0, not as an error', async () => {
    const response = await server({ reader: reader({ maxSeq: 0, events: [] }) }).inject({
      method: 'GET',
      url: SNAPSHOT_PATH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ max_seq: 0, partial: false, features: [] });
    expect(response.headers.etag).toBe(snapshotEtag(0));
  });
});

describe('refusals are RFC 7807 problem documents', () => {
  function expectProblem(
    response: { statusCode: number; headers: Record<string, unknown>; json: () => unknown },
    status: number,
  ): { title: string; detail: string; correlation_id: string } {
    expect(response.statusCode).toBe(status);
    expect(String(response.headers['content-type'])).toMatch(/^application\/problem\+json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'about:blank', status, instance: SNAPSHOT_PATH });
    expect(typeof body['title']).toBe('string');
    expect(typeof body['detail']).toBe('string');
    expect(body['correlation_id']).toMatch(/^[0-9a-f-]{36}$/);
    return body as { title: string; detail: string; correlation_id: string };
  }

  it('is 400 for a cursor that is not a non-negative integer', async () => {
    const fake = reader(ONE_EVENT);
    const app = server({ reader: fake });
    for (const cursor of ['-1', 'abc', '1.5', '', '99999999999999999']) {
      const response = await app.inject({
        method: 'GET',
        url: `${SNAPSHOT_PATH}?updated_after_seq=${cursor}`,
      });
      expectProblem(response, 400);
    }
    // Refused before the database was asked anything.
    expect(fake.activeSetCalls).toEqual([]);
  });

  it('is 400 for a repeated cursor or an unknown parameter — the cache key is the path plus one integer', async () => {
    const app = server({ reader: reader(ONE_EVENT) });
    for (const query of [
      'updated_after_seq=1&updated_after_seq=2',
      'cachebust=1',
      'updated_after_seq=1&x=y',
    ]) {
      expectProblem(await app.inject({ method: 'GET', url: `${SNAPSHOT_PATH}?${query}` }), 400);
    }
  });

  it('is 503 with Retry-After when the database cannot answer, never the driver message', async () => {
    const entries: ProblemLogEntry[] = [];
    const driverError = Object.assign(
      new Error('connect ECONNREFUSED postgres://reader:s3cret@db.internal:5432/fire_watch'),
      { code: '57014' },
    );
    const response = await server({
      reader: failingReader(driverError),
      onProblem: (entry) => entries.push(entry),
    }).inject({ method: 'GET', url: SNAPSHOT_PATH });

    const body = expectProblem(response, 503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body).not.toContain('s3cret');
    expect(response.body).not.toContain('db.internal');
    expect(response.body).not.toContain('ECONNREFUSED');
    // The log line got the same correlation id the client was shown, and the cause.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.correlationId).toBe(body.correlation_id);
    expect(entries[0]?.status).toBe(503);
    expect(entries[0]?.instance).toBe(SNAPSHOT_PATH);
    const cause = (entries[0]?.error as Error).cause;
    expect(cause).toBe(driverError);
  });

  it('sheds load above the in-flight cap with a 503 and a short Retry-After', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: SnapshotReader = {
      readActiveSet: async () => {
        await gate;
        return ONE_EVENT;
      },
      readSourceObservations: () => Promise.resolve([]),
    };
    const app = server({ reader: slow, maxInFlight: 2 });
    const held = [
      app.inject({ method: 'GET', url: SNAPSHOT_PATH }),
      app.inject({ method: 'GET', url: SNAPSHOT_PATH }),
    ];
    // Let the two held requests reach the reader before the third arrives.
    await new Promise((resolve) => setImmediate(resolve));
    const shed = await app.inject({ method: 'GET', url: SNAPSHOT_PATH });
    expectProblem(shed, 503);
    expect(shed.headers['retry-after']).toBe('1');

    release();
    for (const response of await Promise.all(held)) expect(response.statusCode).toBe(200);
    // The cap is released with the requests: the next one is served again.
    expect((await app.inject({ method: 'GET', url: SNAPSHOT_PATH })).statusCode).toBe(200);
  });

  it('never echoes the request URL: instance is the route pattern', async () => {
    const response = await server({ reader: reader(ONE_EVENT) }).inject({
      method: 'GET',
      url: `${SNAPSHOT_PATH}?updated_after_seq=<script>`,
    });
    const body = expectProblem(response, 400);
    expect(response.body).not.toContain('<script>');
    expect(body.detail).not.toContain('script');
  });

  it("leaves the probe surface's own refusal vocabulary untouched", async () => {
    // One handler per contract: the snapshot scope speaks problem+json, the probes keep
    // OPERATIONS §2.2's fixed bodies, and registering the route changes neither.
    const app = server({ reader: reader(ONE_EVENT) });
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ status: 'not_found' });
    expect(missing.headers['cache-control']).toBe('no-store, max-age=0');
    expect(missing.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the route on its own', () => {
  it('needs nothing from the probe surface', async () => {
    // Registered on a bare instance: the error handler and the CORS hook travel with the
    // route, so a future `/api/v1` scope can host it without inheriting the probe hooks.
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });
    registerSnapshotRoute(app, {
      reader: reader(ONE_EVENT),
      clock: new VirtualClock(NOW),
      sources: SOURCES,
    });
    const ok = await app.inject({ method: 'GET', url: SNAPSHOT_PATH });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('*');
    const bad = await app.inject({ method: 'GET', url: `${SNAPSHOT_PATH}?x=1` });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toMatch(/^application\/problem\+json/);
    await app.close();
  });
});
