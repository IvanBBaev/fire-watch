import { describe, expect, it } from 'vitest';

import {
  EARTH_RADIUS_M,
  MAX_MEASURE_POINTS,
  addMeasurePoint,
  distanceMeters,
  lengthForDisplay,
  measureCollection,
  measureResult,
  nearestTo,
  pathLengthMeters,
  pointsForMode,
  polygonAreaSquareMeters,
  undoMeasurePoint,
} from './measure.js';

const SOFIA = { lon: 23.3219, lat: 42.6977 };
const PLOVDIV = { lon: 24.7453, lat: 42.1354 };
const VARNA = { lon: 27.9147, lat: 43.2141 };

const relative = (actual: number, expected: number): number =>
  Math.abs(actual - expected) / expected;

describe('distances on the sphere', () => {
  it('measures one degree of a meridian as πR/180', () => {
    const meters = distanceMeters({ lon: 25, lat: 42 }, { lon: 25, lat: 43 });
    expect(relative(meters, (Math.PI * EARTH_RADIUS_M) / 180)).toBeLessThan(1e-9);
  });

  it('agrees with the published Sofia–Plovdiv great-circle distance (~131 km)', () => {
    const km = distanceMeters(SOFIA, PLOVDIV) / 1000;
    expect(km).toBeGreaterThan(129);
    expect(km).toBeLessThan(133);
  });

  it('sums a path leg by leg, and is 0 for fewer than two points', () => {
    expect(pathLengthMeters([])).toBe(0);
    expect(pathLengthMeters([SOFIA])).toBe(0);
    expect(pathLengthMeters([SOFIA, PLOVDIV, VARNA])).toBeCloseTo(
      distanceMeters(SOFIA, PLOVDIV) + distanceMeters(PLOVDIV, VARNA),
      6,
    );
  });
});

describe('areas on the sphere', () => {
  it('is exact for a one-degree cell bounded by meridians and parallels', () => {
    const cell = [
      { lon: 0, lat: 0 },
      { lon: 1, lat: 0 },
      { lon: 1, lat: 1 },
      { lon: 0, lat: 1 },
    ];
    const exact = EARTH_RADIUS_M ** 2 * (Math.PI / 180) * Math.sin(Math.PI / 180);
    expect(relative(polygonAreaSquareMeters(cell), exact)).toBeLessThan(1e-9);
  });

  it('shrinks a cell with latitude (≈ cos φ), unlike a Mercator pixel count', () => {
    const cell = (lat: number) => [
      { lon: 25, lat },
      { lon: 25.01, lat },
      { lon: 25.01, lat: lat + 0.01 },
      { lon: 25, lat: lat + 0.01 },
    ];
    const ratio = polygonAreaSquareMeters(cell(42.5)) / polygonAreaSquareMeters(cell(0));
    expect(ratio).toBeCloseTo(Math.cos((42.505 * Math.PI) / 180), 3);
  });

  it('ignores winding, a repeated closing point, and is 0 below three vertices', () => {
    const ring = [SOFIA, PLOVDIV, VARNA];
    const area = polygonAreaSquareMeters(ring);
    expect(area).toBeGreaterThan(0);
    expect(polygonAreaSquareMeters([...ring].reverse())).toBeCloseTo(area, 3);
    expect(polygonAreaSquareMeters([...ring, SOFIA])).toBeCloseTo(area, 3);
    expect(polygonAreaSquareMeters([SOFIA, PLOVDIV])).toBe(0);
  });

  it('does not wrap the globe for an outline across the antimeridian', () => {
    const ring = [
      { lon: 179.5, lat: 0 },
      { lon: -179.5, lat: 0 },
      { lon: -179.5, lat: 1 },
      { lon: 179.5, lat: 1 },
    ];
    const exact = EARTH_RADIUS_M ** 2 * (Math.PI / 180) * Math.sin(Math.PI / 180);
    expect(relative(polygonAreaSquareMeters(ring), exact)).toBeLessThan(1e-9);
  });
});

describe('the nearest candidate', () => {
  it('picks the closest, skips non-coordinates, and says null for none', () => {
    const candidates = [
      { id: 'varna', ...VARNA },
      { id: 'broken', lon: Number.NaN, lat: 42 },
      { id: 'plovdiv', ...PLOVDIV },
    ];
    expect(nearestTo(SOFIA, candidates)?.item.id).toBe('plovdiv');
    expect(nearestTo(SOFIA, [])).toBeNull();
  });
});

describe('the reader’s points', () => {
  it('grows a path, replaces a single pick, and refuses garbage and overflow', () => {
    expect(addMeasurePoint('distance', [SOFIA], PLOVDIV)).toEqual([SOFIA, PLOVDIV]);
    expect(addMeasurePoint('nearest', [SOFIA], PLOVDIV)).toEqual([PLOVDIV]);
    const before = [SOFIA];
    expect(addMeasurePoint('area', before, { lon: Number.NaN, lat: 1 })).toBe(before);
    expect(addMeasurePoint('area', before, { lon: 1, lat: 91 })).toBe(before);
    const full = Array.from({ length: MAX_MEASURE_POINTS }, () => SOFIA);
    expect(addMeasurePoint('distance', full, PLOVDIV)).toBe(full);
  });

  it('undoes one point at a time, and keeps a path when the mode changes', () => {
    expect(undoMeasurePoint([SOFIA, PLOVDIV])).toEqual([SOFIA]);
    const none: readonly { lon: number; lat: number }[] = [];
    expect(undoMeasurePoint(none)).toBe(none);
    expect(pointsForMode('area', [SOFIA, PLOVDIV])).toEqual([SOFIA, PLOVDIV]);
    expect(pointsForMode('nearest', [SOFIA, PLOVDIV])).toEqual([PLOVDIV]);
  });
});

describe('measureResult', () => {
  const fires = [
    { id: 'p', ...PLOVDIV },
    { id: 'v', ...VARNA },
  ];

  it('asks for more points until the question can be answered', () => {
    expect(measureResult('distance', [SOFIA], fires)).toEqual({
      kind: 'needPoints',
      mode: 'distance',
    });
    expect(measureResult('area', [SOFIA, PLOVDIV], fires).kind).toBe('needPoints');
    expect(measureResult('nearest', [], fires).kind).toBe('needPoints');
  });

  it('answers each question', () => {
    const distance = measureResult('distance', [SOFIA, PLOVDIV], fires);
    expect(distance.kind === 'distance' && Math.round(distance.meters / 1000)).toBe(
      Math.round(distanceMeters(SOFIA, PLOVDIV) / 1000),
    );
    const area = measureResult('area', [SOFIA, PLOVDIV, VARNA], fires);
    expect(area.kind).toBe('area');
    if (area.kind === 'area') {
      expect(area.hectares).toBeCloseTo(
        polygonAreaSquareMeters([SOFIA, PLOVDIV, VARNA]) / 10_000,
        6,
      );
      expect(area.perimeterMeters).toBeCloseTo(pathLengthMeters([SOFIA, PLOVDIV, VARNA, SOFIA]), 6);
    }
    const nearest = measureResult('nearest', [SOFIA], fires);
    expect(nearest.kind === 'nearest' && nearest.target.id).toBe('p');
    expect(measureResult('nearest', [SOFIA], [])).toEqual({ kind: 'nearestNone' });
  });
});

describe('lengthForDisplay', () => {
  it('rounds for a sentence and never says 0 m for a real line', () => {
    expect(lengthForDisplay(0)).toEqual({ unit: 'm', value: 0 });
    expect(lengthForDisplay(3)).toEqual({ unit: 'm', value: 10 });
    expect(lengthForDisplay(456)).toEqual({ unit: 'm', value: 460 });
    expect(lengthForDisplay(1234)).toEqual({ unit: 'km', value: 1.2 });
    expect(lengthForDisplay(131_400)).toEqual({ unit: 'km', value: 131 });
    expect(lengthForDisplay(Number.NaN)).toEqual({ unit: 'm', value: 0 });
  });
});

describe('measureCollection', () => {
  const roles = (collection: ReturnType<typeof measureCollection>) =>
    collection.features.map((feature) => feature.properties.role);

  it('draws a path, an outline, or the link to the nearest fire, with a dot per point', () => {
    const path = [SOFIA, PLOVDIV];
    expect(roles(measureCollection('distance', path, measureResult('distance', path, [])))).toEqual(
      ['path', 'vertex', 'vertex'],
    );
    expect(roles(measureCollection('area', path, measureResult('area', path, [])))).toEqual([
      'path',
      'vertex',
      'vertex',
    ]);
    const ring = [SOFIA, PLOVDIV, VARNA];
    const outline = measureCollection('area', ring, measureResult('area', ring, []));
    expect(roles(outline)).toEqual(['area', 'vertex', 'vertex', 'vertex']);
    const polygon = outline.features[0];
    expect(polygon?.geometry.type === 'Polygon' && polygon.geometry.coordinates[0]?.length).toBe(4);

    const fires = [{ id: 'v', ...VARNA }];
    expect(
      roles(measureCollection('nearest', [SOFIA], measureResult('nearest', [SOFIA], fires))),
    ).toEqual(['link', 'target', 'vertex']);
    expect(
      roles(measureCollection('nearest', [SOFIA], measureResult('nearest', [SOFIA], []))),
    ).toEqual(['vertex']);
  });
});
