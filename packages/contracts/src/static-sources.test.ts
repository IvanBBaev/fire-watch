import { describe, expect, it } from 'vitest';

import {
  EMPTY_STATIC_SOURCE_MASK,
  STATIC_SOURCE_FORMAT,
  STATIC_SOURCE_KINDS,
  STATIC_SOURCE_METRIC,
  StaticSourceFormatError,
  nearestStaticSource,
  parseStaticSourceMask,
  pointInRing,
  staticSourceDistanceM,
} from './static-sources.js';

const SCALE = 10_000;

/** An asset from absolute integer vertices, delta-encoding them the way the builder does. */
function asset(sources: readonly (readonly [number, readonly (readonly [number, number])[]])[]) {
  return {
    format: STATIC_SOURCE_FORMAT,
    version: 'test-1',
    licence: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    scale: SCALE,
    kinds: [...STATIC_SOURCE_KINDS],
    sources: sources.map(([kind, vertices]) => {
      const out: number[] = [kind];
      let px = 0;
      let py = 0;
      for (const [x, y] of vertices) {
        out.push(x - px, y - py);
        px = x;
        py = y;
      }
      return out;
    }),
  };
}

/** A 0.01° square solar park at lon 25.00–25.01, lat 42.00–42.01, and a flare point. */
const SQUARE: readonly (readonly [number, number])[] = [
  [250_000, 420_000],
  [250_100, 420_000],
  [250_100, 420_100],
  [250_000, 420_100],
];
const MASK = parseStaticSourceMask(
  asset([
    [0, SQUARE],
    [3, [[260_000, 430_000]]],
  ]),
);

describe('parseStaticSourceMask', () => {
  it('decodes delta-encoded vertices and indexes them', () => {
    expect(MASK.sources).toHaveLength(2);
    expect(MASK.sources[0]?.kind).toBe('solar');
    expect(MASK.sources[0]?.vertices[2]).toEqual({ lon: 25.01, lat: 42.01 });
    expect(MASK.sources[1]).toMatchObject({ kind: 'flare', minLon: 26, maxLat: 43 });
    expect(MASK.version).toBe('test-1');
  });

  it.each([
    ['a wrong format tag', { ...asset([]), format: 'fire-watch/static-sources@0' }],
    [
      'a reordered kinds list',
      { ...asset([]), kinds: ['flare', 'solar', 'thermal_power', 'industrial'] },
    ],
    ['a non-integer scale', { ...asset([]), scale: 1.5 }],
    ['an unknown kind', asset([[9, SQUARE]])],
    ['a two-vertex source', asset([[0, SQUARE.slice(0, 2)]])],
    ['an odd coordinate count', { ...asset([]), sources: [[0, 1, 2, 3]] }],
    ['a fractional coordinate', { ...asset([]), sources: [[0, 1.5, 2]] }],
    ['a vertex off the globe', asset([[0, [[1_900_000, 0]]]])],
  ])('rejects %s', (_label, body) => {
    expect(() => parseStaticSourceMask(body)).toThrow(StaticSourceFormatError);
  });
});

describe('distances', () => {
  it('is zero inside a ring and on its edge', () => {
    const park = MASK.sources[0];
    if (park === undefined) throw new Error('fixture');
    expect(staticSourceDistanceM(park, { lon: 25.005, lat: 42.005 }, STATIC_SOURCE_METRIC)).toBe(0);
    expect(staticSourceDistanceM(park, { lon: 25.01, lat: 42.005 }, STATIC_SOURCE_METRIC)).toBe(0);
  });

  it('measures to the nearest edge on the local plane', () => {
    const park = MASK.sources[0];
    if (park === undefined) throw new Error('fixture');
    // 0.001° of latitude south of the south edge: 111.085 m.
    expect(staticSourceDistanceM(park, { lon: 25.005, lat: 41.999 }, STATIC_SOURCE_METRIC)).toBe(
      111,
    );
  });

  it('agrees with the even-odd rule on a concave ring', () => {
    const u = [
      { lon: 0, lat: 0 },
      { lon: 3, lat: 0 },
      { lon: 3, lat: 3 },
      { lon: 2, lat: 3 },
      { lon: 2, lat: 1 },
      { lon: 1, lat: 1 },
      { lon: 1, lat: 3 },
      { lon: 0, lat: 3 },
    ];
    expect(pointInRing({ lon: 0.5, lat: 2 }, u)).toBe(true);
    expect(pointInRing({ lon: 1.5, lat: 2 }, u)).toBe(false);
    expect(pointInRing({ lon: 1.5, lat: 0.5 }, u)).toBe(true);
  });
});

describe('nearestStaticSource', () => {
  it('finds the park from inside and within the radius, and nothing beyond it', () => {
    const inside = nearestStaticSource(MASK, { lon: 25.005, lat: 42.005 }, 0, STATIC_SOURCE_METRIC);
    expect(inside).toMatchObject({ distanceM: 0, source: { kind: 'solar' } });
    const near = { lon: 25.005, lat: 41.995 }; // ~555 m south
    expect(nearestStaticSource(MASK, near, 1000, STATIC_SOURCE_METRIC)?.distanceM).toBe(555);
    expect(nearestStaticSource(MASK, near, 500, STATIC_SOURCE_METRIC)).toBeNull();
  });

  it('filters by kind', () => {
    const atFlare = { lon: 26, lat: 43 };
    expect(nearestStaticSource(MASK, atFlare, 100, STATIC_SOURCE_METRIC, ['flare'])).not.toBeNull();
    expect(nearestStaticSource(MASK, atFlare, 100, STATIC_SOURCE_METRIC, ['solar'])).toBeNull();
  });

  it('finds a source across a grid-cell boundary', () => {
    // The flare sits exactly on a 0.1° cell corner; approach it from the next cell over.
    const hit = nearestStaticSource(
      MASK,
      { lon: 25.9995, lat: 42.9995 },
      200,
      STATIC_SOURCE_METRIC,
    );
    expect(hit?.source.kind).toBe('flare');
  });

  it('answers null for the empty mask and a non-finite point, and refuses a huge radius', () => {
    expect(
      nearestStaticSource(
        EMPTY_STATIC_SOURCE_MASK,
        { lon: 25, lat: 42 },
        1000,
        STATIC_SOURCE_METRIC,
      ),
    ).toBeNull();
    expect(
      nearestStaticSource(MASK, { lon: Number.NaN, lat: 42 }, 1000, STATIC_SOURCE_METRIC),
    ).toBeNull();
    expect(() =>
      nearestStaticSource(MASK, { lon: 25, lat: 42 }, 50_000, STATIC_SOURCE_METRIC),
    ).toThrow(RangeError);
  });
});
