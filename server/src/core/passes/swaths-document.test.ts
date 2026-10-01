import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../config/polling-bbox.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import { CELESTRAK_FETCHED_AT_MS, OMM_BY_NORAD } from './__fixtures__/celestrak-omm.js';
import { parseOmmBody, satrecFromOmm } from './omm.js';
import { computePasses, greatCircleKm } from './pass-compute.js';
import { passBucketStart } from './pass-grid.js';
import { PASS_PLATFORMS } from './pass-platforms.js';
import type { PlatformElements } from './passes-document.js';
import { destination, initialBearing, nearestBoxPoint, swathCoversBox } from './swath-geometry.js';
import {
  SWATH_RECENT_MS,
  SWATH_UPCOMING_MS,
  buildSwathsDocument,
  type SwathFeature,
} from './swaths-document.js';

const BOX = POLLING_BBOX.values;
const bucket = passBucketStart(CELESTRAK_FETCHED_AT_MS);

function allElements(): PlatformElements[] {
  return PASS_PLATFORMS.map((platform) => {
    const parsed = parseOmmBody(OMM_BY_NORAD[platform.noradId]!, platform.noradId);
    if (!parsed.ok) throw new Error(parsed.reason);
    return { platform, record: parsed.record };
  });
}

const doc = buildSwathsDocument(BOX, bucket, allElements());

const passesOf = (features: readonly SwathFeature[]) =>
  features.filter((feature) => feature.properties.part === 'swath');

describe('great-circle helpers', () => {
  const point = fc.record({
    lat: fc.double({ min: -70, max: 70, noNaN: true }),
    lon: fc.double({ min: -179, max: 179, noNaN: true }),
  });

  it('destination lands the asked distance away, on the asked bearing', () => {
    fc.assert(
      fc.property(
        point,
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: 1, max: 2000, noNaN: true }),
        (start, bearing, km) => {
          const end = destination(start, bearing, km);
          expect(greatCircleKm(start, end)).toBeCloseTo(km, 6);
          const back = initialBearing(start, end);
          const diff = Math.atan2(Math.sin(back - bearing), Math.cos(back - bearing));
          expect(Math.abs(diff)).toBeLessThan(1e-6);
        },
      ),
    );
  });

  it('a point inside the box is its own nearest box point', () => {
    expect(nearestBoxPoint(BOX, { lat: 42, lon: 25 })).toEqual({ lat: 42, lon: 25 });
    expect(nearestBoxPoint(BOX, { lat: 50, lon: 10 })).toEqual({ lat: 46, lon: 20 });
  });

  it('a swath covers the box exactly when its half-width reaches the nearest box point', () => {
    const outside = { lat: 42, lon: 10 };
    const gap = greatCircleKm(outside, { lat: 42, lon: 20 });
    expect(swathCoversBox(BOX, outside, 2 * gap + 1)).toBe(true);
    expect(swathCoversBox(BOX, outside, 2 * gap - 1)).toBe(false);
  });
});

describe('buildSwathsDocument', () => {
  it('is a labelled prediction over the whole box, with every platform listed', () => {
    expect(doc).toMatchObject({
      type: 'FeatureCollection',
      schema_version: 1,
      computed_for: '2026-09-30T13:10:00Z',
      window: { from: '2026-09-30T07:10:00Z', to: '2026-10-01T01:10:00Z' },
      predicted: true,
      elements_provider: 'celestrak',
      bbox: [20, 39, 31, 46],
    });
    expect(doc.platforms.map((p) => [p.id, p.elements])).toEqual([
      ['noaa20', 'current'],
      ['snpp', 'current'],
      ['noaa21', 'current'],
      ['s3a', 'current'],
      ['s3b', 'current'],
    ]);
  });

  it('draws each pass as a swath, a track and a label that agree on time and kind', () => {
    const swaths = passesOf(doc.features);
    expect(swaths.length).toBeGreaterThan(5);
    expect(doc.features).toHaveLength(swaths.length * 3);
    for (let i = 0; i < doc.features.length; i += 3) {
      const [swath, track, label] = doc.features.slice(i, i + 3) as [
        SwathFeature,
        SwathFeature,
        SwathFeature,
      ];
      expect([swath.properties.part, track.properties.part, label.properties.part]).toEqual([
        'swath',
        'track',
        'label',
      ]);
      const { part: _swath, ...a } = swath.properties;
      const { part: _track, ...b } = track.properties;
      expect(b).toEqual(a);
      expect(swath.geometry.type).toBe('Polygon');
      if (swath.geometry.type !== 'Polygon') continue;
      const ring = swath.geometry.coordinates[0]!;
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      if (track.geometry.type !== 'LineString') throw new Error('track is not a line');
      // Two edges and the closing point: one ring vertex per track sample per side.
      expect(ring).toHaveLength(track.geometry.coordinates.length * 2 + 1);
      if (label.geometry.type !== 'Point') throw new Error('label is not a point');
      const [lon, lat] = label.geometry.coordinates;
      expect(lon).toBeGreaterThan(BOX.west);
      expect(lon).toBeLessThan(BOX.east);
      expect(lat).toBeGreaterThan(BOX.south);
      expect(lat).toBeLessThan(BOX.north);
    }
  });

  it('splits passes at the bucket: recent before it, next from it, all inside the window', () => {
    for (const feature of passesOf(doc.features)) {
      const mid = Date.parse(feature.properties.mid);
      expect(mid).toBeGreaterThanOrEqual(bucket - SWATH_RECENT_MS);
      expect(mid).toBeLessThan(bucket + SWATH_UPCOMING_MS);
      expect(feature.properties.kind).toBe(mid < bucket ? 'recent' : 'next');
      expect(Date.parse(feature.properties.start)).toBeLessThanOrEqual(mid + 30_000);
      expect(Date.parse(feature.properties.end)).toBeGreaterThanOrEqual(mid - 30_000);
    }
    const kinds = new Set(passesOf(doc.features).map((f) => f.properties.kind));
    expect(kinds).toEqual(new Set(['recent', 'next']));
  });

  it('draws a swath over the box centre whenever the point predictor has an in-swath pass there', () => {
    // Cross-check against the independent per-point search: every in-swath pass over the
    // box centre must be one of the drawn passes (same platform, mid within minutes).
    const centre = { lat: (BOX.south + BOX.north) / 2, lon: (BOX.west + BOX.east) / 2 };
    const drawn = passesOf(doc.features);
    for (const { platform, record } of allElements()) {
      const points = computePasses(
        satrecFromOmm(record!),
        centre,
        {
          fromMs: bucket - SWATH_RECENT_MS + 10 * 60_000,
          toMs: bucket + SWATH_UPCOMING_MS - 10 * 60_000,
        },
        platform.swathKm,
      ).filter((pass) => pass.inSwath);
      for (const pass of points) {
        const match = drawn.find(
          (feature) =>
            feature.properties.platform === platform.id &&
            Math.abs(Date.parse(feature.properties.mid) - pass.culminationMs) < 5 * 60_000,
        );
        expect(match, `${platform.id} ${new Date(pass.culminationMs).toISOString()}`).toBeDefined();
      }
    }
  });

  it('keeps a platform without elements listed, with nothing drawn for it', () => {
    const elements = allElements().map((entry) =>
      entry.platform.id === 's3b' ? { ...entry, record: null } : entry,
    );
    const partial = buildSwathsDocument(BOX, bucket, elements);
    expect(partial.platforms.find((p) => p.id === 's3b')).toEqual({
      id: 's3b',
      instrument: 'slstr',
      swath_km: expect.any(Number) as number,
      elements: 'missing',
      elements_epoch: null,
    });
    expect(partial.features.some((f) => f.properties.platform === 's3b')).toBe(false);
  });

  it('is byte-identical for the same inputs, and small enough to ship to every reader', () => {
    const again = canonicalJson(buildSwathsDocument(BOX, bucket, allElements()));
    expect(again).toBe(canonicalJson(doc));
    expect(again.length).toBeLessThan(64 * 1024);
  });
});

describe('the web fixture (web/public/fixtures/passes/swaths.json)', () => {
  // The fixtures build draws exactly what this module builds from the recorded CelesTrak
  // elements, for the recorded bucket — never a hand-edited or time-shifted copy, so the
  // swaths on screen are real SGP4 output for a real moment. The web re-decides recent /
  // next against the reader's clock (`web/src/core/pass-swaths.ts`), so once the window is
  // over the fixture draws nothing and the panel says the prediction has expired.
  // Regenerate with `pnpm exec vitest run --project unit -u server/src/core/passes/swaths-document.test.ts`.
  it('is byte-identical to a fresh build', async () => {
    await expect(`${canonicalJson(doc)}\n`).toMatchFileSnapshot(
      '../../../../web/public/fixtures/passes/swaths.json',
    );
  });
});
