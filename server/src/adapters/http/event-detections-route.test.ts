import type { FreshnessRowId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { VirtualClock, epochMsFromIso } from '../../core/ports/clock.js';
import type {
  EventDetectionRow,
  EventDetectionsRead,
  EventDetectionsReader,
} from '../../core/ports/event-detections-reader.js';
import type { DatabaseProbe, FreshnessReader } from '../../core/ports/freshness-reader.js';
import {
  DEFAULT_MAX_DETECTIONS,
  EVENT_DETECTIONS_SCHEMA_VERSION,
  detectionFeature,
  eventDetectionsEtag,
  type EventDetectionsRouteDeps,
} from './event-detections-route.js';
import { createHealthServer } from './health-server.js';
import { PROBLEM_CONTENT_TYPE, type ProblemLogEntry } from './problem.js';
import { SNAPSHOT_CACHE_CONTROL } from './snapshot-route.js';

const NOW = '2026-08-09T10:15:00Z';
const ID = 'fw-2026-b2n5c';
const EVENT_URL = `/api/v1/events/${ID}/detections`;
const UID = 'a'.repeat(64);

function detection(overrides: Partial<EventDetectionRow> = {}): EventDetectionRow {
  return {
    uid: UID,
    sourceId: 'firms:viirs:noaa21',
    observedAt: epochMsFromIso('2026-08-09T01:02:00Z'),
    lon: 27.516,
    lat: 41.977,
    confidence: 'nominal',
    scanKm: 0.42,
    trackKm: 0.41,
    frpMw: 9.8,
    ...overrides,
  };
}

interface FakeReader extends EventDetectionsReader {
  readonly calls: { publicId: string; limit: number }[];
}

function reader(read: EventDetectionsRead): FakeReader {
  const calls: { publicId: string; limit: number }[] = [];
  return {
    calls,
    readEventDetections: (publicId, limit) => {
      calls.push({ publicId, limit });
      return Promise.resolve(read);
    },
  };
}

const EVENT: EventDetectionsRead = {
  kind: 'event',
  seq: 1040,
  detections: [detection()],
  truncated: false,
};

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
  deps: Partial<EventDetectionsRouteDeps> & Pick<EventDetectionsRouteDeps, 'reader'>,
  probeRateLimit?: { limit: number; windowMs: number },
): ReturnType<typeof createHealthServer> {
  return createHealthServer({
    reader: forbidden.reader,
    probe: forbidden.probe,
    clock: new VirtualClock(NOW),
    expected: EXPECTED,
    ...(probeRateLimit === undefined ? {} : { rateLimit: probeRateLimit }),
    eventDetections: { clock: new VirtualClock(NOW), ...deps },
  });
}

describe('GET /api/v1/events/:publicId/detections', () => {
  it('serves the member detections as the GeoJSON the web parsers read', async () => {
    const fake = reader(EVENT);
    const response = await server({ reader: fake }).inject({ method: 'GET', url: EVENT_URL });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      type: 'FeatureCollection',
      schema_version: EVENT_DETECTIONS_SCHEMA_VERSION,
      event_id: ID,
      merged_into: null,
      generated_at: NOW,
      truncated: false,
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [27.516, 41.977] },
          properties: {
            uid: UID,
            observed_at: '2026-08-09T01:02:00Z',
            source_id: 'firms:viirs:noaa21',
            confidence: 'nominal',
            scan_km: 0.42,
            track_km: 0.41,
            frp_mw: 9.8,
          },
        },
      ],
    });
    expect((body['attribution'] as unknown[]).length).toBeGreaterThan(0);
    expect(fake.calls).toEqual([{ publicId: ID, limit: DEFAULT_MAX_DETECTIONS }]);
  });

  it('omits measurements the product did not carry instead of sending null', () => {
    const feature = detectionFeature(detection({ frpMw: null, scanKm: null, trackKm: null }));
    expect(feature.properties).toEqual({
      uid: UID,
      observed_at: '2026-08-09T01:02:00Z',
      source_id: 'firms:viirs:noaa21',
      confidence: 'nominal',
    });
  });

  it('flags a bounded body and passes the configured bound to the reader', async () => {
    const fake = reader({ ...EVENT, truncated: true });
    const response = await server({ reader: fake, maxDetections: 5 }).inject({
      method: 'GET',
      url: EVENT_URL,
    });
    expect(response.json()).toMatchObject({ truncated: true });
    expect(fake.calls).toEqual([{ publicId: ID, limit: 5 }]);
  });

  it('answers a merge tombstone 200 with the survivor and no features (ADR-002 I1)', async () => {
    const response = await server({
      reader: reader({
        kind: 'merged',
        seq: 900,
        survivorPublicId: 'fw-2026-k9s2r',
        survivorSeq: 1050,
      }),
    }).inject({ method: 'GET', url: EVENT_URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      event_id: ID,
      merged_into: 'fw-2026-k9s2r',
      truncated: false,
      features: [],
    });
    expect(response.headers.etag).toBe(eventDetectionsEtag(900, 1050));
  });

  it('carries the snapshot cache rule and an ETag from the event seq, not the probe no-store', async () => {
    const response = await server({ reader: reader(EVENT) }).inject({
      method: 'GET',
      url: EVENT_URL,
    });
    expect(response.headers['cache-control']).toBe(SNAPSHOT_CACHE_CONTROL);
    expect(response.headers.etag).toBe(eventDetectionsEtag(1040));
    expect(response.headers['cdn-cache-control']).toBeUndefined();
  });

  it('is a 304 when If-None-Match carries the current tag, weak or listed', async () => {
    const app = server({ reader: reader(EVENT) });
    const tag = eventDetectionsEtag(1040);
    for (const header of [tag, `W/${tag}`, `"stale", ${tag}`]) {
      const response = await app.inject({
        method: 'GET',
        url: EVENT_URL,
        headers: { 'if-none-match': header },
      });
      expect(response.statusCode, header).toBe(304);
      expect(response.body).toBe('');
    }
    const moved = await app.inject({
      method: 'GET',
      url: EVENT_URL,
      headers: { 'if-none-match': eventDetectionsEtag(1039) },
    });
    expect(moved.statusCode).toBe(200);
  });

  it('answers HEAD with the same validator as GET', async () => {
    // The body itself is dropped by Node's HTTP layer; `inject` does not model that.
    const response = await server({ reader: reader(EVENT) }).inject({
      method: 'HEAD',
      url: EVENT_URL,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(eventDetectionsEtag(1040));
  });

  it('is a 404 problem for an id no event ever had', async () => {
    const response = await server({ reader: reader({ kind: 'unknown' }) }).inject({
      method: 'GET',
      url: EVENT_URL,
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(PROBLEM_CONTENT_TYPE);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.json()).toMatchObject({ status: 404, title: 'Event not found' });
  });

  it('is a 404 for a malformed id without asking the database', async () => {
    const fake = reader(EVENT);
    const app = server({ reader: fake });
    for (const id of ['fw-2026-ABCDE', 'fw-26-b2n5c', 'x', "fw-2026-b2n5c'--"]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/events/${encodeURIComponent(id)}/detections`,
      });
      expect(response.statusCode, id).toBe(404);
      expect(response.headers['content-type'], id).toMatch(PROBLEM_CONTENT_TYPE);
    }
    expect(fake.calls).toEqual([]);
  });

  it('refuses any query parameter, so a cache-buster cannot reach the origin', async () => {
    const fake = reader(EVENT);
    const response = await server({ reader: fake }).inject({
      method: 'GET',
      url: `${EVENT_URL}?_=1`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toMatch(PROBLEM_CONTENT_TYPE);
    expect(fake.calls).toEqual([]);
  });

  it('turns a database failure into a 503 with Retry-After, the driver message logged only', async () => {
    const problems: ProblemLogEntry[] = [];
    const response = await server({
      reader: {
        readEventDetections: () => Promise.reject(new Error('connect ECONNREFUSED db.internal')),
      },
      onProblem: (entry) => problems.push(entry),
    }).inject({ method: 'GET', url: EVENT_URL });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body).not.toContain('db.internal');
    expect(problems).toHaveLength(1);
  });

  it('sheds load past the in-flight cap with a 503 and Retry-After 1', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: EventDetectionsReader = {
      readEventDetections: async () => {
        await gate;
        return EVENT;
      },
    };
    const app = server({ reader: slow, maxInFlight: 1 });
    const first = app.inject({ method: 'GET', url: EVENT_URL });
    // Let the first request reach the reader before the second arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await app.inject({ method: 'GET', url: EVENT_URL });
    expect(second.statusCode).toBe(503);
    expect(second.headers['retry-after']).toBe('1');
    release();
    expect((await first).statusCode).toBe(200);
  });

  it('has its own per-IP limit: 429 + Retry-After as a problem, unknown ids charged too', async () => {
    const app = server({ reader: reader(EVENT), rateLimit: { limit: 2, windowMs: 60_000 } });
    expect((await app.inject({ method: 'GET', url: EVENT_URL })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/events/nope/detections' })).statusCode,
    ).toBe(404);
    const refused = await app.inject({ method: 'GET', url: EVENT_URL });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');
    expect(refused.headers['content-type']).toMatch(PROBLEM_CONTENT_TYPE);
    expect(refused.headers['access-control-allow-origin']).toBe('*');
    expect(refused.json()).toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('keys the limit on the edge-owned client-IP header when the server has one', async () => {
    const app = createHealthServer({
      reader: forbidden.reader,
      probe: forbidden.probe,
      clock: new VirtualClock(NOW),
      expected: EXPECTED,
      clientIpHeader: 'cf-connecting-ip',
      eventDetections: {
        reader: reader(EVENT),
        clock: new VirtualClock(NOW),
        rateLimit: { limit: 1, windowMs: 60_000 },
      },
    });
    const as = (ip: string) =>
      app.inject({ method: 'GET', url: EVENT_URL, headers: { 'cf-connecting-ip': ip } });
    expect((await as('203.0.113.1')).statusCode).toBe(200);
    expect((await as('203.0.113.2')).statusCode).toBe(200);
    expect((await as('203.0.113.1')).statusCode).toBe(429);
  });

  it('does not pay the probe limiter', async () => {
    const app = server({ reader: reader(EVENT) }, { limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: 'GET', url: EVENT_URL })).statusCode).toBe(200);
    }
  });

  it('is not served without its deps', async () => {
    const app = createHealthServer({
      reader: forbidden.reader,
      probe: forbidden.probe,
      clock: new VirtualClock(NOW),
      expected: EXPECTED,
    });
    expect((await app.inject({ method: 'GET', url: EVENT_URL })).statusCode).toBe(404);
  });
});

describe('eventDetectionsEtag', () => {
  it('names the schema and the seqs, and refuses a seq that is not one', () => {
    expect(eventDetectionsEtag(42)).toBe('"d1-42"');
    expect(eventDetectionsEtag(42, 50)).toBe('"d1-42-50"');
    expect(() => eventDetectionsEtag(-1)).toThrow(RangeError);
    expect(() => eventDetectionsEtag(1, 1.5)).toThrow(RangeError);
  });
});
