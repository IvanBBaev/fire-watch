import { parseOutlineSeries, type FreshnessRowId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { FIRE_OUTLINE_PARAMS } from '../../core/config/fire-outline.js';
import { VirtualClock, epochMsFromIso } from '../../core/ports/clock.js';
import type {
  EventDetectionRow,
  EventDetectionsRead,
  EventDetectionsReader,
} from '../../core/ports/event-detections-reader.js';
import type { DatabaseProbe, FreshnessReader } from '../../core/ports/freshness-reader.js';
import { createHealthServer } from './health-server.js';
import { outlineSeriesEtag, type OutlineSeriesRouteDeps } from './outline-series-route.js';
import { PROBLEM_CONTENT_TYPE, type ProblemLogEntry } from './problem.js';
import { SNAPSHOT_CACHE_CONTROL } from './snapshot-route.js';

const NOW = '2026-08-09T10:15:00Z';
const ID = 'fw-2026-b2n5c';
const URL = `/api/v1/events/${ID}/outline-series`;
const VERSION = FIRE_OUTLINE_PARAMS.version;

function detection(uid: string, lon: number, observedAt: string): EventDetectionRow {
  return {
    uid: uid.repeat(64),
    sourceId: 'firms:viirs:noaa21',
    observedAt: epochMsFromIso(observedAt),
    lon,
    lat: 41.977,
    confidence: 'nominal',
    scanKm: 0.42,
    trackKm: 0.41,
    frpMw: 9.8,
  };
}

const EVENT: EventDetectionsRead = {
  kind: 'event',
  seq: 1040,
  detections: [
    detection('a', 27.516, '2026-08-09T01:02:00Z'),
    detection('b', 27.521, '2026-08-09T11:40:00Z'),
  ],
  truncated: false,
};

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
  deps: Partial<OutlineSeriesRouteDeps> & Pick<OutlineSeriesRouteDeps, 'reader'>,
  probeRateLimit?: { limit: number; windowMs: number },
): ReturnType<typeof createHealthServer> {
  return createHealthServer({
    reader: forbidden.reader,
    probe: forbidden.probe,
    clock: new VirtualClock(NOW),
    expected: EXPECTED,
    ...(probeRateLimit === undefined ? {} : { rateLimit: probeRateLimit }),
    outlineSeries: { clock: new VirtualClock(NOW), params: FIRE_OUTLINE_PARAMS, ...deps },
  });
}

describe('GET /api/v1/events/:publicId/outline-series', () => {
  it('serves one point per overpass as the document the contracts parser accepts', async () => {
    const fake = reader(EVENT);
    const response = await server({ reader: fake }).inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    const document = parseOutlineSeries(response.json());
    expect(document).not.toBeNull();
    expect(document).toMatchObject({
      kind: 'estimated_outline_series',
      event_id: ID,
      merged_into: null,
      params_version: VERSION,
      generated_at: NOW,
      truncated: false,
      thinned: false,
    });
    expect(document?.points.map((p) => p.at)).toEqual([
      '2026-08-09T01:02:00Z',
      '2026-08-09T11:40:00Z',
    ]);
    expect(document?.points.map((p) => p.footprints)).toEqual([1, 2]);
    expect(document?.attribution.length).toBeGreaterThan(0);
    expect(fake.calls).toEqual([{ publicId: ID, limit: FIRE_OUTLINE_PARAMS.values.maxDetections }]);
  });

  it('flags a truncated read', async () => {
    const response = await server({ reader: reader({ ...EVENT, truncated: true }) }).inject({
      method: 'GET',
      url: URL,
    });
    expect(response.json()).toMatchObject({ truncated: true });
  });

  it('answers a merge tombstone 200 with the survivor and no points', async () => {
    const response = await server({
      reader: reader({
        kind: 'merged',
        seq: 900,
        survivorPublicId: 'fw-2026-k9s2r',
        survivorSeq: 1050,
      }),
    }).inject({ method: 'GET', url: URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ merged_into: 'fw-2026-k9s2r', points: [] });
    expect(response.headers.etag).toBe(outlineSeriesEtag(VERSION, 900, 1050));
  });

  it('carries the snapshot cache rule and is a 304 on the current tag', async () => {
    const app = server({ reader: reader(EVENT) });
    const first = await app.inject({ method: 'GET', url: URL });
    expect(first.headers['cache-control']).toBe(SNAPSHOT_CACHE_CONTROL);
    expect(first.headers.etag).toBe(outlineSeriesEtag(VERSION, 1040));
    const again = await app.inject({
      method: 'GET',
      url: URL,
      headers: { 'if-none-match': outlineSeriesEtag(VERSION, 1040) },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('changes its tag with the outline parameters', () => {
    expect(outlineSeriesEtag('a', 1)).not.toBe(outlineSeriesEtag('b', 1));
    expect(() => outlineSeriesEtag(VERSION, -1)).toThrow(RangeError);
  });

  it('is a 404 for an unknown or malformed id', async () => {
    const fake = reader({ kind: 'unknown' });
    const app = server({ reader: fake });
    const unknown = await app.inject({ method: 'GET', url: URL });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['content-type']).toMatch(PROBLEM_CONTENT_TYPE);
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/events/fw-2026-ABCDE/outline-series',
    });
    expect(malformed.statusCode).toBe(404);
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses any query parameter', async () => {
    const fake = reader(EVENT);
    const response = await server({ reader: fake }).inject({ method: 'GET', url: `${URL}?_=1` });
    expect(response.statusCode).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it('turns a database failure into a 503 without the driver message', async () => {
    const problems: ProblemLogEntry[] = [];
    const response = await server({
      reader: {
        readEventDetections: () => Promise.reject(new Error('connect ECONNREFUSED db.internal')),
      },
      onProblem: (entry) => problems.push(entry),
    }).inject({ method: 'GET', url: URL });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.body).not.toContain('db.internal');
    expect(problems).toHaveLength(1);
  });

  it('sheds load past the in-flight cap', async () => {
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
    const first = app.inject({ method: 'GET', url: URL });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await app.inject({ method: 'GET', url: URL });
    expect(second.statusCode).toBe(503);
    expect(second.headers['retry-after']).toBe('1');
    release();
    expect((await first).statusCode).toBe(200);
  });

  it('has its own per-IP limit and does not pay the probe limiter', async () => {
    const limited = server({ reader: reader(EVENT), rateLimit: { limit: 1, windowMs: 60_000 } });
    expect((await limited.inject({ method: 'GET', url: URL })).statusCode).toBe(200);
    const refused = await limited.inject({ method: 'GET', url: URL });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'rate_limited' });

    const app = server({ reader: reader(EVENT) }, { limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(200);
    }
  });

  it('is not served without its deps', async () => {
    const app = createHealthServer({
      reader: forbidden.reader,
      probe: forbidden.probe,
      clock: new VirtualClock(NOW),
      expected: EXPECTED,
    });
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(404);
  });
});
