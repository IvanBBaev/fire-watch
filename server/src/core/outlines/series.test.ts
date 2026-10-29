import { describe, expect, it } from 'vitest';

import { FIRE_OUTLINE_PARAMS } from '../config/fire-outline.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import { assertDeterministic } from '../replay/double-run.js';
import { drawFireOutline } from './fire-outline.js';
import {
  DEFAULT_OUTLINE_SERIES_OPTIONS,
  buildOutlineSeries,
  outlineCentroid,
  type SeriesDetection,
} from './series.js';

const PARAMS = FIRE_OUTLINE_PARAMS.values;
const DEG_LON_PER_KM = 1 / PARAMS.metric.kmPerDegreeLonAtReference;
const T0 = epochMsFromIso('2026-08-09T01:00:00Z');
const MINUTE = 60_000;

function at(minutes: number): EpochMs {
  return T0 + minutes * MINUTE;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** A VIIRS pixel `kmEast` east of 42.7° N 25.0° E, observed `minutes` after T0. */
function viirs(uid: string, kmEast: number, minutes: number): SeriesDetection {
  return {
    uid,
    sourceId: 'firms:viirs:noaa21',
    lat: 42.7,
    lon: round5(25 + kmEast * DEG_LON_PER_KM),
    scanKm: 0.375,
    trackKm: 0.375,
    observedAt: at(minutes),
  };
}

/** Three overpasses, each adding a pixel further east. */
const GROWING: readonly SeriesDetection[] = [
  viirs('a', 0, 0),
  viirs('b', 0.375, 2),
  viirs('c', 0.75, 100),
  viirs('d', 1.125, 200),
  viirs('e', 1.5, 203),
];

describe('buildOutlineSeries', () => {
  it('is empty with no detections', () => {
    expect(buildOutlineSeries([], PARAMS)).toEqual({ points: [], thinned: false });
  });

  it('closes one point per overpass, dated by its last acquisition', () => {
    const series = buildOutlineSeries(GROWING, PARAMS);
    expect(series.thinned).toBe(false);
    expect(series.points.map((p) => p.at)).toEqual([at(2), at(100), at(203)]);
    expect(series.points.map((p) => p.footprints)).toEqual([2, 3, 5]);
  });

  it('grows its area and moves its centroid as the fire is seen spreading east', () => {
    const { points } = buildOutlineSeries(GROWING, PARAMS);
    for (let k = 1; k < points.length; k += 1) {
      const previous = points[k - 1];
      const point = points[k];
      expect(point?.areaHa).toBeGreaterThan(previous?.areaHa as number);
      expect(point?.centroid.lon).toBeGreaterThan(previous?.centroid.lon as number);
    }
    for (const p of points) {
      expect(p.areaLowHa).toBeLessThanOrEqual(p.areaHa);
      expect(p.areaHighHa).toBeGreaterThanOrEqual(p.areaHa);
      expect(p.edgeUncertaintyKm).toBeGreaterThan(0);
    }
  });

  it('ends on the outline the outline loop stores for the same detections', () => {
    const { points } = buildOutlineSeries(GROWING, PARAMS);
    const outline = drawFireOutline(GROWING, PARAMS);
    const last = points.at(-1);
    expect(last).toMatchObject({
      areaHa: outline.areaHa,
      areaLowHa: outline.areaLowHa,
      areaHighHa: outline.areaHighHa,
      edgeUncertaintyKm: outline.edgeUncertaintyKm,
      footprints: outline.footprints,
    });
  });

  it('does not depend on the order the detections arrive in', () => {
    const forward = buildOutlineSeries(GROWING, PARAMS);
    const reversed = buildOutlineSeries(GROWING.toReversed(), PARAMS);
    expect(reversed).toEqual(forward);
    assertDeterministic('outline series', () => canonicalJson(buildOutlineSeries(GROWING, PARAMS)));
  });

  it('never starts a point from a source that draws no outline', () => {
    const slstr: SeriesDetection = {
      uid: 's',
      sourceId: 'eumetsat:slstr:frp',
      lat: 42.7,
      lon: 25,
      scanKm: 1,
      trackKm: 1,
      observedAt: at(50),
    };
    const { points } = buildOutlineSeries([...GROWING, slstr], PARAMS);
    expect(points.map((p) => p.at)).toEqual([at(2), at(100), at(203)]);
  });

  it('keeps the first and last overpass and an even spread when thinning', () => {
    const many = Array.from({ length: 10 }, (_, k) => viirs(`p${String(k)}`, k * 0.375, k * 60));
    const series = buildOutlineSeries(many, PARAMS, {
      ...DEFAULT_OUTLINE_SERIES_OPTIONS,
      maxPoints: 4,
    });
    expect(series.thinned).toBe(true);
    expect(series.points.map((p) => p.at)).toEqual([at(0), at(180), at(360), at(540)]);
    // Thinning loses resolution in time, never area: the last point still has every pixel.
    expect(series.points.at(-1)?.footprints).toBe(10);
  });

  it('splits overpasses by the configured gap', () => {
    const series = buildOutlineSeries(GROWING, PARAMS, {
      ...DEFAULT_OUTLINE_SERIES_OPTIONS,
      observationGapMs: 0,
    });
    expect(series.points.map((p) => p.at)).toEqual([at(0), at(2), at(100), at(200), at(203)]);
  });

  it('refuses bad options and non-finite times', () => {
    expect(() =>
      buildOutlineSeries(GROWING, PARAMS, { observationGapMs: -1, maxPoints: 4 }),
    ).toThrow(RangeError);
    expect(() =>
      buildOutlineSeries(GROWING, PARAMS, { observationGapMs: 0, maxPoints: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      buildOutlineSeries([{ ...viirs('x', 0, 0), observedAt: Number.NaN }], PARAMS),
    ).toThrow(RangeError);
  });
});

describe('outlineCentroid', () => {
  it('takes the area-weighted centre of the outer rings', () => {
    const square = (x: number, y: number, side: number): [number, number][][] => [
      [
        [x, y],
        [x + side, y],
        [x + side, y + side],
        [x, y + side],
        [x, y],
      ],
    ];
    // A 1×1 square at (0,0) and a 2×2 square at (10,0): weights 1 and 4.
    const centroid = outlineCentroid({
      type: 'MultiPolygon',
      coordinates: [square(0, 0, 1), square(10, 0, 2)],
    });
    expect(centroid.lon).toBeCloseTo((0.5 * 1 + 11 * 4) / 5, 5);
    expect(centroid.lat).toBeCloseTo((0.5 * 1 + 1 * 4) / 5, 5);
  });
});
