import { detectionUid } from '@fire-watch/contracts/node';
import { describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../config/polling-bbox.js';
import type { FirmsAreaQuery, FirmsAreaResponse } from '../ports/firms-client.js';
import {
  FIRMS_DAY_RANGE,
  buildAreaQuery,
  liveFirmsSources,
  pollFirms,
  pollFirmsSource,
  type PollFirmsDeps,
} from './firms-poller.js';

const HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight';

function row(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    country_id: 'BGR',
    latitude: '41.850123',
    longitude: '26.140027',
    bright_ti4: '330.5',
    scan: '0.39',
    track: '0.36',
    acq_date: '2026-08-02',
    acq_time: '1124',
    satellite: 'N',
    instrument: 'VIIRS',
    confidence: 'n',
    version: '2.0NRT',
    bright_ti5: '295.1',
    frp: '12.5',
    daynight: 'D',
    ...overrides,
  };
  return HEADER.split(',')
    .map((name) => values[name] ?? '')
    .join(',');
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

interface StubClient {
  readonly calls: FirmsAreaQuery[];
  fetchArea(query: FirmsAreaQuery): Promise<FirmsAreaResponse>;
}

/**
 * Answers each source from its own script, one entry per call; the last entry repeats.
 * An `Error` in the script is thrown rather than returned, which is how the transport
 * reports an outage.
 */
function stubClient(
  script: Partial<Record<string, readonly (FirmsAreaResponse | Error)[]>>,
): StubClient {
  const calls: FirmsAreaQuery[] = [];
  const seen = new Map<string, number>();

  return {
    calls,
    fetchArea(query: FirmsAreaQuery): Promise<FirmsAreaResponse> {
      calls.push(query);
      const queue = script[query.source] ?? [];
      const index = seen.get(query.source) ?? 0;
      seen.set(query.source, index + 1);
      const entry = queue[Math.min(index, queue.length - 1)];
      if (entry === undefined) {
        return Promise.reject(new Error(`no scripted response for ${query.source}`));
      }
      return entry instanceof Error ? Promise.reject(entry) : Promise.resolve(entry);
    },
  };
}

function response(body: string, availableAt: number): FirmsAreaResponse {
  return { csv: body, availableAt };
}

function deps(client: StubClient): PollFirmsDeps {
  return { client, detectionUid };
}

describe('liveFirmsSources', () => {
  it('is the three active VIIRS platforms, in frozen registry order', () => {
    expect(liveFirmsSources()).toEqual([
      'firms:viirs:snpp',
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
    ]);
  });

  it('never polls a retired source', () => {
    // MODIS stays in the registry for backfill and fixture replay. Querying it live would
    // also put it back into the expected-overpass set of a constellation that has landed.
    expect(liveFirmsSources()).not.toContain('firms:modis');
  });

  it('leaves the non-FIRMS sources to their own pollers', () => {
    expect(liveFirmsSources()).not.toContain('eumetsat:slstr:frp');
    expect(liveFirmsSources()).not.toContain('lsasaf:seviri:frp-pixel');
  });
});

describe('buildAreaQuery', () => {
  it('always asks for two UTC calendar days', () => {
    // Pitfall 2: `day_range` counts calendar days, so a poll at 00:05 UTC with
    // `day_range=1` sees five minutes of data and drops the whole preceding night.
    expect(FIRMS_DAY_RANGE).toBe(2);

    for (const source of liveFirmsSources()) {
      expect(buildAreaQuery(source).dayRange).toBe(2);
    }
  });

  it('queries the registry product and the versioned bbox', () => {
    const query = buildAreaQuery('firms:viirs:noaa20');

    expect(query.product).toBe('VIIRS_NOAA20_NRT');
    expect(query.area).toBe('20,39,31,46');
    expect(query.startDate).toBeUndefined();
  });

  it('refuses a source the Area API does not serve', () => {
    expect(() => buildAreaQuery('eumetsat:slstr:frp')).toThrow(/not served by the FIRMS Area API/);
  });
});

describe('pollFirmsSource — a successful poll', () => {
  it('identifies every row and stamps the batch instant on it', async () => {
    const client = stubClient({
      'firms:viirs:snpp': [response(csv(row(), row({ acq_time: '1125' })), 1_754_130_000_000)],
    });

    const run = await pollFirmsSource('firms:viirs:snpp', deps(client));

    expect(run.outcome).toBe('ok');
    expect(run.error).toBeUndefined();
    expect(run.availableAt).toBe(1_754_130_000_000);
    expect(run.detections).toHaveLength(2);
    for (const detection of run.detections) {
      expect(detection.availableAt).toBe(1_754_130_000_000);
      expect(detection.detectionUid).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('mints the id from the canonical pre-image, not from the row object', async () => {
    const client = stubClient({ 'firms:viirs:snpp': [response(csv(row()), 1_754_130_000_000)] });

    const run = await pollFirmsSource('firms:viirs:snpp', deps(client));

    expect(run.detections[0]?.detectionUid).toBe(
      detectionUid({
        source: 'firms:viirs:snpp',
        acqTsIso: '2026-08-02T11:24:00Z',
        lat: '41.85012',
        lon: '26.14003',
      }),
    );
  });

  it('records the config versions the batch was produced under', async () => {
    const client = stubClient({ 'firms:viirs:snpp': [response(csv(row()), 1)] });

    const run = await pollFirmsSource('firms:viirs:snpp', deps(client));

    expect(run.pollingBboxVersion).toBe('polling_bbox_v1');
    expect(run.sourceRegistryVersion).toBe('source_registry_v1');
    expect(run.query).toEqual({
      source: 'firms:viirs:snpp',
      product: 'VIIRS_SNPP_NRT',
      area: '20,39,31,46',
      dayRange: 2,
    });
  });

  it('attributes rows to the queried source however the satellite column reads', async () => {
    const client = stubClient({
      'firms:viirs:noaa21': [response(csv(row({ satellite: 'Terra' })), 1)],
    });

    const run = await pollFirmsSource('firms:viirs:noaa21', deps(client));

    expect(run.detections[0]?.source).toBe('firms:viirs:noaa21');
  });

  it('returns detections in the fixed batch order regardless of file order', async () => {
    const rows = [
      row({ latitude: '43.100000', longitude: '25.000000' }),
      row({ latitude: '41.100000', longitude: '25.000000' }),
      row({ latitude: '41.100000', longitude: '24.000000' }),
    ];
    const forwards = stubClient({ 'firms:viirs:snpp': [response(csv(...rows), 7)] });
    const backwards = stubClient({
      'firms:viirs:snpp': [response(csv(...[...rows].reverse()), 7)],
    });

    const a = await pollFirmsSource('firms:viirs:snpp', deps(forwards));
    const b = await pollFirmsSource('firms:viirs:snpp', deps(backwards));

    expect(a.detections.map((d) => d.latCanonical + '/' + d.lonCanonical)).toEqual([
      '41.10000/24.00000',
      '41.10000/25.00000',
      '43.10000/25.00000',
    ]);
    expect(b.detections.map((d) => d.detectionUid)).toEqual(
      a.detections.map((d) => d.detectionUid),
    );
  });
});

describe('pollFirmsSource — the overlap that pitfall 2 creates on purpose', () => {
  it('mints the same id for a row that comes back on the next poll', async () => {
    // C1's Done-when: the second poll is a no-op at the store. `day_range=2` guarantees
    // this overlap on every single cycle, so it has to be free.
    const carried = row();
    const client = stubClient({
      'firms:viirs:snpp': [
        response(csv(carried), 1_754_130_000_000),
        response(csv(carried, row({ acq_time: '1148' })), 1_754_130_900_000),
      ],
    });
    const wiring = deps(client);

    const first = await pollFirmsSource('firms:viirs:snpp', wiring);
    const second = await pollFirmsSource('firms:viirs:snpp', wiring);

    expect(second.detections).toHaveLength(2);
    expect(second.detections.map((d) => d.detectionUid)).toContain(
      first.detections[0]?.detectionUid,
    );
    // Only the new row is new; `ON CONFLICT (acq_ts, detection_uid) DO NOTHING` swallows
    // the other one, which is why the poller does not have to remember anything.
    const known = new Set(first.detections.map((d) => d.detectionUid));
    expect(second.detections.filter((d) => !known.has(d.detectionUid))).toHaveLength(1);
  });

  it('re-stamps a carried-over row with the later batch instant', async () => {
    // `available_at` belongs to the batch, not to the detection: it is when *we* could
    // first have seen it, and the store keeps the first one it wrote.
    const carried = row();
    const client = stubClient({
      'firms:viirs:snpp': [response(csv(carried), 100), response(csv(carried), 200)],
    });
    const wiring = deps(client);

    const first = await pollFirmsSource('firms:viirs:snpp', wiring);
    const second = await pollFirmsSource('firms:viirs:snpp', wiring);

    expect(first.detections[0]?.availableAt).toBe(100);
    expect(second.detections[0]?.availableAt).toBe(200);
    expect(second.detections[0]?.detectionUid).toBe(first.detections[0]?.detectionUid);
  });

  it('is byte-identical across two runs over the same response', async () => {
    const body = csv(row(), row({ acq_time: '1125' }), row({ latitude: '42.0' }));
    const first = await pollFirmsSource(
      'firms:viirs:snpp',
      deps(stubClient({ 'firms:viirs:snpp': [response(body, 5)] })),
    );
    const second = await pollFirmsSource(
      'firms:viirs:snpp',
      deps(stubClient({ 'firms:viirs:snpp': [response(body, 5)] })),
    );

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('counts a row the same response repeats, and keeps one copy', async () => {
    const twice = row();
    const client = stubClient({ 'firms:viirs:snpp': [response(csv(twice, twice), 1)] });

    const run = await pollFirmsSource('firms:viirs:snpp', deps(client));

    expect(run.detections).toHaveLength(1);
    expect(run.duplicatesWithinBatch).toBe(1);
  });
});

describe('pollFirmsSource — silence is never inferred', () => {
  it('records a transport failure as a failed run, not as an empty one', async () => {
    // Pitfall 10: "no fires in the box" and "the source did not answer" must not look the
    // same downstream, or a dead poller reads as a quiet fire season.
    const client = stubClient({ 'firms:viirs:snpp': [new Error('ETIMEDOUT after 30s')] });

    const run = await pollFirmsSource('firms:viirs:snpp', deps(client));

    expect(run.outcome).toBe('failed');
    expect(run.error).toBe('ETIMEDOUT after 30s');
    expect(run.detections).toEqual([]);
    expect(run.availableAt).toBeNull();
  });

  it('distinguishes a healthy empty poll from a failed one', async () => {
    const client = stubClient({ 'firms:viirs:snpp': [response(csv(), 42)] });

    const run = await pollFirmsSource('firms:viirs:snpp', deps(client));

    expect(run.outcome).toBe('ok');
    expect(run.detections).toEqual([]);
    expect(run.availableAt).toBe(42);
  });

  it('records an unreadable response as failed and keeps when it arrived', async () => {
    // The realistic shape: a rate-limit notice or an expired-key page served with a 200.
    const client = stubClient({ 'firms:viirs:snpp': [response('Invalid MAP_KEY\n', 99)] });

    const run = await pollFirmsSource('firms:viirs:snpp', deps(client));

    expect(run.outcome).toBe('failed');
    expect(run.error).toMatch(/missing column/);
    expect(run.availableAt).toBe(99);
  });

  it('keeps a bad row out of the batch without failing the poll', async () => {
    const client = stubClient({
      'firms:viirs:snpp': [response(csv(row(), row({ latitude: '91.0', acq_time: '1125' })), 1)],
    });

    const run = await pollFirmsSource('firms:viirs:snpp', deps(client));

    expect(run.outcome).toBe('ok');
    expect(run.detections).toHaveLength(1);
    expect(run.rejections).toHaveLength(1);
    expect(run.rejections[0]?.reason).toMatch(/latitude out of range/);
  });

  it('queries with the pinned bbox version it was given', async () => {
    const client = stubClient({ 'firms:viirs:snpp': [response(csv(), 1)] });

    const run = await pollFirmsSource('firms:viirs:snpp', { ...deps(client), bbox: POLLING_BBOX });

    expect(run.pollingBboxVersion).toBe(POLLING_BBOX.version);
    expect(client.calls[0]?.area).toBe('20,39,31,46');
  });
});

describe('pollFirms — one cycle', () => {
  it('polls the given sources once each, in the order given', async () => {
    const client = stubClient({
      'firms:viirs:snpp': [response(csv(row()), 1)],
      'firms:viirs:noaa20': [response(csv(), 2)],
      'firms:viirs:noaa21': [response(csv(row({ acq_time: '1130' })), 3)],
    });

    const runs = await pollFirms(liveFirmsSources(), deps(client));

    expect(runs.map((run) => run.source)).toEqual([
      'firms:viirs:snpp',
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
    ]);
    expect(client.calls.map((call) => call.product)).toEqual([
      'VIIRS_SNPP_NRT',
      'VIIRS_NOAA20_NRT',
      'VIIRS_NOAA21_NRT',
    ]);
  });

  it('finishes the cycle when one source is down', async () => {
    const client = stubClient({
      'firms:viirs:snpp': [new Error('503 Service Unavailable')],
      'firms:viirs:noaa20': [response(csv(row()), 2)],
      'firms:viirs:noaa21': [response(csv(row({ acq_time: '1130' })), 3)],
    });

    const runs = await pollFirms(liveFirmsSources(), deps(client));

    expect(runs.map((run) => run.outcome)).toEqual(['failed', 'ok', 'ok']);
    expect(runs.filter((run) => run.outcome === 'ok')).toHaveLength(2);
  });
});
