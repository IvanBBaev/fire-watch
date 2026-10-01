import { describe, expect, it } from 'vitest';

import { overpassesOf, parseDetectionDetail, summariseDetections } from './detection-detail.js';

function feature(properties: Record<string, unknown>): unknown {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [25, 42] }, properties };
}

const row = (
  uid: string,
  observedAt: string,
  sourceId: string,
  frpMw?: number,
): Record<string, unknown> => ({
  uid,
  observed_at: observedAt,
  source_id: sourceId,
  scan_km: 0.4,
  track_km: 0.4,
  ...(frpMw === undefined ? {} : { frp_mw: frpMw }),
});

describe('parseDetectionDetail', () => {
  it('reads rows with and without frp_mw', () => {
    const parsed = parseDetectionDetail({
      type: 'FeatureCollection',
      features: [
        feature(row('a', '2026-08-09T00:52:00Z', 'firms:viirs:snpp', 8.4)),
        feature(row('b', '2026-08-09T01:43:00Z', 'firms:viirs:noaa20')),
      ],
    });
    expect(parsed).toEqual([
      {
        uid: 'a',
        observedAt: '2026-08-09T00:52:00Z',
        observedMs: Date.parse('2026-08-09T00:52:00Z'),
        sourceId: 'firms:viirs:snpp',
        frpMw: 8.4,
        position: { lon: 25, lat: 42 },
      },
      {
        uid: 'b',
        observedAt: '2026-08-09T01:43:00Z',
        observedMs: Date.parse('2026-08-09T01:43:00Z'),
        sourceId: 'firms:viirs:noaa20',
        frpMw: null,
        position: { lon: 25, lat: 42 },
      },
    ]);
  });

  it('keeps a row without a usable Point, with no position (TASKS F16)', () => {
    const properties = row('a', '2026-08-09T00:52:00Z', 'firms:viirs:snpp', 8.4);
    const parsed = parseDetectionDetail({
      features: [
        { type: 'Feature', geometry: null, properties },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [25, 'x'] }, properties },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [200, 42] }, properties },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [25, 42] }, properties },
      ],
    });

    expect(parsed.map((detection) => [detection.uid, detection.position])).toEqual([
      ['a', null],
      ['a', null],
      ['a', null],
      ['a', null],
    ]);
    expect(summariseDetections(parsed)?.positions).toEqual([]);
  });

  it('drops malformed rows and never reads a bad FRP as a number', () => {
    const parsed = parseDetectionDetail({
      features: [
        null,
        feature({ uid: 'x' }),
        feature(row('bad-time', 'not a time', 'firms:viirs:snpp')),
        feature({ ...row('neg', '2026-08-09T00:52:00Z', 'firms:viirs:snpp'), frp_mw: -3 }),
        feature({ ...row('str', '2026-08-09T00:52:00Z', 'firms:viirs:snpp'), frp_mw: '9' }),
      ],
    });
    expect(parsed.map((d) => [d.uid, d.frpMw])).toEqual([
      ['neg', null],
      ['str', null],
    ]);
  });

  it('returns nothing for a non-collection', () => {
    expect(parseDetectionDetail(null)).toEqual([]);
    expect(parseDetectionDetail({ features: 'nope' })).toEqual([]);
  });
});

describe('overpassesOf', () => {
  it('groups one sensor at one instant and sums FRP over the rows that carry it', () => {
    const passes = overpassesOf(
      parseDetectionDetail({
        features: [
          feature(row('a', '2026-08-09T00:52:00Z', 'firms:viirs:snpp', 8.4)),
          feature(row('b', '2026-08-09T00:52:00Z', 'firms:viirs:snpp', 4.2)),
          feature(row('c', '2026-08-09T00:52:00Z', 'firms:viirs:snpp')),
          feature(row('d', '2026-08-09T00:52:00Z', 'lsasaf:seviri:frp-pixel')),
        ],
      }),
    );
    expect(passes).toEqual([
      expect.objectContaining({ sourceId: 'firms:viirs:snpp', detections: 3, frpMw: 12.6 }),
      expect.objectContaining({ sourceId: 'lsasaf:seviri:frp-pixel', detections: 1, frpMw: null }),
    ]);
  });
});

describe('summariseDetections', () => {
  it('is null for no detections', () => {
    expect(summariseDetections([])).toBeNull();
  });

  const detections = parseDetectionDetail({
    features: [
      feature(row('a', '2026-08-09T00:52:00Z', 'firms:viirs:snpp', 8.4)),
      feature(row('b', '2026-08-09T00:52:00Z', 'firms:viirs:snpp', 4.2)),
      feature(row('c', '2026-08-09T08:15:00Z', 'eumetsat:slstr:frp', 30)),
      feature(row('d', '2026-08-09T09:47:00Z', 'lsasaf:seviri:frp-pixel', 20)),
      feature(row('e', '2026-08-09T09:47:00Z', 'firms:viirs:noaa20')),
    ],
  });

  it('names every sensor of the latest instant, in registry order', () => {
    const summary = summariseDetections(detections);
    expect(summary?.latestObservedAt).toBe('2026-08-09T09:47:00Z');
    expect(summary?.latestSources).toEqual(['firms:viirs:noaa20', 'lsasaf:seviri:frp-pixel']);
  });

  it('counts detections per sensor, registry order', () => {
    expect(summariseDetections(detections)?.sensors).toEqual([
      { sourceId: 'firms:viirs:snpp', detections: 2 },
      { sourceId: 'firms:viirs:noaa20', detections: 1 },
      { sourceId: 'eumetsat:slstr:frp', detections: 1 },
      { sourceId: 'lsasaf:seviri:frp-pixel', detections: 1 },
    ]);
  });

  it('takes latest and peak FRP per pass and flags mixed sensors', () => {
    const frp = summariseDetections(detections)?.frp;
    expect(frp?.series.map((pass) => pass.frpMw)).toEqual([12.6, 30, 20]);
    expect(frp?.latest).toEqual(
      expect.objectContaining({ sourceId: 'lsasaf:seviri:frp-pixel', frpMw: 20 }),
    );
    expect(frp?.peak).toEqual(
      expect.objectContaining({ sourceId: 'eumetsat:slstr:frp', frpMw: 30 }),
    );
    expect(frp?.mixedSensors).toBe(true);
  });

  it('has no FRP summary when no row carries FRP — absence is not zero', () => {
    const summary = summariseDetections(
      parseDetectionDetail({
        features: [feature(row('a', '2026-08-09T00:52:00Z', 'firms:viirs:snpp'))],
      }),
    );
    expect(summary?.frp).toBeNull();
  });

  it('keeps the earliest pass as the peak on a tie', () => {
    const frp = summariseDetections(
      parseDetectionDetail({
        features: [
          feature(row('a', '2026-08-09T00:52:00Z', 'firms:viirs:snpp', 10)),
          feature(row('b', '2026-08-09T01:43:00Z', 'firms:viirs:snpp', 10)),
        ],
      }),
    )?.frp;
    expect(frp?.peak.observedAt).toBe('2026-08-09T00:52:00Z');
    expect(frp?.latest.observedAt).toBe('2026-08-09T01:43:00Z');
    expect(frp?.mixedSensors).toBe(false);
  });
});
