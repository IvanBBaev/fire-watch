/**
 * The §3.6 static hot-source rule and the §6.2 day-only quarantine (TASKS F16): which
 * detections are tagged, which verdict that makes an event, and that the lookup the rule
 * stands on is sound — properties over random geometry with fast-check, examples for the
 * numbers the policy names.
 */

import {
  STATIC_SOURCE_FORMAT,
  STATIC_SOURCE_KINDS,
  STATIC_SOURCE_METRIC,
  nearestStaticSource,
  parseStaticSourceMask,
  staticSourceDistanceM,
  staticSourcesWithin,
  type StaticSourceMask,
} from '@fire-watch/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import type { ScoringDetection } from '../scoring/features.js';
import {
  NO_STATIC_SOURCE_EVALUATOR,
  STATIC_SOURCE_POLICY,
  STATIC_SOURCE_VERDICTS,
  dayOnlyRepeat,
  detectionOnStaticSource,
  staticSourceEvaluator,
  staticSourceVerdict,
  tagDetection,
  type StaticSourcePolicy,
} from './static-source-policy.js';

const METRIC = CLUSTERING_PARAMS.values.metric;
const POLICY = STATIC_SOURCE_POLICY.values;

type Vertex = readonly [number, number];

/** An asset body from absolute integer vertices (1e-4°), delta-encoded like the builder. */
function maskOf(sources: readonly (readonly [number, readonly Vertex[]])[]): StaticSourceMask {
  return parseStaticSourceMask({
    format: STATIC_SOURCE_FORMAT,
    version: 'test',
    licence: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    scale: 10_000,
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
  });
}

/** Solar park lon 25.00–25.01 × lat 42.00–42.01; a flare node at 26.0, 43.0. */
const MASK = maskOf([
  [
    0,
    [
      [250_000, 420_000],
      [250_100, 420_000],
      [250_100, 420_100],
      [250_000, 420_100],
    ],
  ],
  [3, [[260_000, 430_000]]],
]);

function row(
  lon: number,
  lat: number,
  n = 1,
  dayNight: 'D' | 'N' | null = 'N',
  acqTsIso = '2026-08-05T03:10:00Z',
): ScoringDetection {
  return {
    detectionUid: String(n).padStart(64, '0'),
    source: 'firms:viirs:snpp',
    acqTsIso,
    latCanonical: lat.toFixed(5),
    lonCanonical: lon.toFixed(5),
    confidence: 'nominal',
    dayNight,
    frpMw: 10,
    scanKm: null,
    trackKm: null,
    overOrAdjacentToWater: null,
  };
}

describe('STATIC_SOURCE_POLICY', () => {
  it('is static_source_policy_v2: every kind overrides, the §6.2 quarantine is on', () => {
    expect(STATIC_SOURCE_POLICY.version).toBe('static_source_policy_v2');
    expect(POLICY).toEqual({
      kindEffects: {
        solar: 'override',
        thermal_power: 'override',
        industrial: 'override',
        flare: 'override',
      },
      polygonHitBufferM: 0,
      pointHitRadiusM: 500,
      quarantine: { enabled: true, minDayDetections: 3, minDistinctDays: 2, siteDiameterM: 750 },
    });
  });

  it('names an effect for every kind the mask format knows', () => {
    expect(Object.keys(POLICY.kindEffects).sort()).toEqual([...STATIC_SOURCE_KINDS].sort());
  });

  it('measures on the clustering plane, which is the web’s STATIC_SOURCE_METRIC', () => {
    expect(STATIC_SOURCE_METRIC).toEqual({
      referenceLatDeg: METRIC.referenceLatDeg,
      kmPerDegreeLat: METRIC.kmPerDegreeLat,
      kmPerDegreeLonAtReference: METRIC.kmPerDegreeLonAtReference,
      kmPerDegreeLonPerDegreeLat: METRIC.kmPerDegreeLonPerDegreeLat,
    });
  });
});

describe('detectionOnStaticSource', () => {
  const on = (lon: number, lat: number, policy: StaticSourcePolicy = POLICY) =>
    detectionOnStaticSource(MASK, policy, METRIC, row(lon, lat));

  it('is inside-only for a polygon at the v1 zero buffer', () => {
    expect(on(25.005, 42.005)).toBe(true);
    expect(on(25.005, 41.9999)).toBe(false); // ~11 m south of the edge
    expect(on(25.005, 41.9999, { ...POLICY, polygonHitBufferM: 50 })).toBe(true);
  });

  it('uses the point radius for a point source', () => {
    expect(on(26.004, 43)).toBe(true); // ~327 m east
    expect(on(26.007, 43)).toBe(false); // ~572 m east
  });

  it('ignores kinds the policy only annotates', () => {
    const solarAnnotates = { ...POLICY, kindEffects: { ...POLICY.kindEffects, solar: 'annotate' } };
    expect(on(25.005, 42.005, solarAnnotates as StaticSourcePolicy)).toBe(false);
  });

  it('finds a point source even when a polygon is nearer but outside its buffer', () => {
    const both = maskOf([
      [
        0,
        [
          [250_000, 420_000],
          [250_100, 420_000],
          [250_100, 420_100],
          [250_000, 420_100],
        ],
      ],
      [3, [[250_140, 420_050]]],
    ]);
    // 11 m east of the park's east edge, ~330 m west of the flare.
    expect(detectionOnStaticSource(both, POLICY, METRIC, row(25.0101, 42.005))).toBe(true);
  });
});

const ANNOTATE_SOLAR: StaticSourcePolicy = {
  ...POLICY,
  kindEffects: { ...POLICY.kindEffects, solar: 'annotate' },
};

describe('tagDetection (the per-detection tag)', () => {
  it('tags the source a detection sits on, with the effect its kind has', () => {
    expect(tagDetection(MASK, POLICY, METRIC, row(25.005, 42.005))).toEqual({
      kind: 'solar',
      effect: 'override',
      distanceM: 0,
    });
    expect(tagDetection(MASK, ANNOTATE_SOLAR, METRIC, row(25.005, 42.005))?.effect).toBe(
      'annotate',
    );
    expect(tagDetection(MASK, POLICY, METRIC, row(25.2, 42.2))).toBeNull();
    expect(tagDetection(maskOf([]), POLICY, METRIC, row(25.005, 42.005))).toBeNull();
  });

  it('prefers an override source over a nearer annotate one', () => {
    const both = maskOf([
      [
        0,
        [
          [250_000, 420_000],
          [250_100, 420_000],
          [250_100, 420_100],
          [250_000, 420_100],
        ],
      ],
      [3, [[250_060, 420_050]]],
    ]);
    const tag = tagDetection(both, ANNOTATE_SOLAR, METRIC, row(25.005, 42.005));
    expect(tag?.kind).toBe('flare');
    expect(tag?.effect).toBe('override');
  });
});

/** Three day detections on one pixel over two UTC dates — §6.2 item 2 exactly. */
function chimney(): ScoringDetection[] {
  return [
    row(27.5, 42.5, 1, 'D', '2026-08-01T10:40:00Z'),
    row(27.5012, 42.5, 2, 'D', '2026-08-01T11:20:00Z'),
    row(27.5, 42.5009, 3, 'D', '2026-08-02T10:55:00Z'),
  ];
}

describe('dayOnlyRepeat (the §6.2 quarantine)', () => {
  const q = POLICY.quarantine;

  it('holds for three day detections on one pixel across two dates', () => {
    expect(dayOnlyRepeat(q, METRIC, chimney())).toBe(true);
  });

  it('is broken by any night detection, ever', () => {
    expect(dayOnlyRepeat(q, METRIC, [...chimney(), row(27.5, 42.5, 4, 'N')])).toBe(false);
  });

  it('needs the count and the distinct days', () => {
    expect(dayOnlyRepeat(q, METRIC, chimney().slice(0, 2))).toBe(false);
    const oneDay = chimney().map((r) => ({ ...r, acqTsIso: '2026-08-01T10:40:00Z' }));
    expect(dayOnlyRepeat(q, METRIC, oneDay)).toBe(false);
  });

  it('needs the same site: a spread wider than siteDiameterM is a fire', () => {
    expect(dayOnlyRepeat(q, METRIC, [...chimney(), row(27.52, 42.5, 4, 'D')])).toBe(false);
  });

  it('lets an unflagged detection neither build nor break it', () => {
    const [a, b] = chimney();
    if (a === undefined || b === undefined) throw new Error('fixture');
    expect(dayOnlyRepeat(q, METRIC, [a, b, row(27.5, 42.5, 9, null, '2026-08-03T10:00:00Z')])).toBe(
      false,
    );
    expect(dayOnlyRepeat(q, METRIC, [...chimney(), row(27.5, 42.5, 9, null)])).toBe(true);
  });

  it('is off when the policy switches it off', () => {
    expect(dayOnlyRepeat({ ...q, enabled: false }, METRIC, chimney())).toBe(false);
  });

  it('is monotone: adding a night detection or a far detection never creates it (property)', () => {
    const extra = fc.record({
      lon: fc.double({ min: 27.3, max: 27.7, noNaN: true }),
      lat: fc.double({ min: 42.3, max: 42.7, noNaN: true }),
      night: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(extra, { maxLength: 6 }), (extras) => {
        const base = chimney();
        const rows = [
          ...base,
          ...extras.map((e, i) => row(e.lon, e.lat, 10 + i, e.night ? 'N' : 'D')),
        ];
        if (!dayOnlyRepeat(q, METRIC, base)) return;
        if (dayOnlyRepeat(q, METRIC, rows)) {
          expect(rows.every((r) => r.dayNight !== 'N')).toBe(true);
        }
      }),
    );
  });
});

describe('staticSourceVerdict (the event rule)', () => {
  const verdict = (rows: readonly ScoringDetection[], policy = POLICY, mask = MASK) =>
    staticSourceVerdict(mask, policy, METRIC, rows);

  it('is static_source only when every member carries an override tag', () => {
    expect(verdict([row(25.002, 42.002, 1), row(25.008, 42.008, 2)])).toBe('static_source');
    expect(verdict([row(25.002, 42.002, 1), row(25.2, 42.2, 2)])).toBe('annotated');
    expect(verdict([row(25.2, 42.2, 1)])).toBe('clear');
    expect(verdict([])).toBe('clear');
  });

  it('annotates instead of overriding when the founder switch says so', () => {
    expect(verdict([row(25.002, 42.002, 1)], ANNOTATE_SOLAR)).toBe('annotated');
  });

  it('quarantines without a mask, and the override outranks the quarantine', () => {
    expect(verdict(chimney(), POLICY, maskOf([]))).toBe('suspected_static_source');
    expect(staticSourceVerdict(null, POLICY, METRIC, chimney())).toBe('suspected_static_source');
    const onPark = chimney().map((r, i) => ({
      ...r,
      lonCanonical: (25.002 + i * 0.001).toFixed(5),
      latCanonical: '42.00500',
    }));
    expect(verdict(onPark)).toBe('static_source');
    expect(verdict(onPark, ANNOTATE_SOLAR)).toBe('suspected_static_source');
  });

  it('never depends on member order (property)', () => {
    const lonLat = fc.record({
      lon: fc.double({ min: 24.99, max: 25.02, noNaN: true }),
      lat: fc.double({ min: 41.99, max: 42.02, noNaN: true }),
      day: fc.constantFrom<'D' | 'N' | null>('D', 'N', null),
      date: fc.integer({ min: 1, max: 3 }),
    });
    fc.assert(
      fc.property(fc.array(lonLat, { minLength: 1, maxLength: 8 }), (points) => {
        const rows = points.map((p, i) =>
          row(p.lon, p.lat, i + 1, p.day, `2026-08-0${String(p.date)}T11:00:00Z`),
        );
        const v = verdict(rows);
        expect(STATIC_SOURCE_VERDICTS).toContain(v);
        expect(verdict([...rows].reverse())).toBe(v);
      }),
    );
  });
});

describe('staticSourceEvaluator', () => {
  it('carries the mask and policy versions it evaluates against (D7)', () => {
    const evaluator = staticSourceEvaluator(MASK, STATIC_SOURCE_POLICY, METRIC);
    expect(evaluator.maskVersion).toBe('test');
    expect(evaluator.policyVersion).toBe('static_source_policy_v2');
    expect(evaluator.evaluate([row(25.005, 42.005)])).toBe('static_source');
    expect(staticSourceEvaluator(null, STATIC_SOURCE_POLICY, METRIC).maskVersion).toBeNull();
  });

  it('has a no-op that evaluates nothing', () => {
    expect(NO_STATIC_SOURCE_EVALUATOR.policyVersion).toBeNull();
    expect(NO_STATIC_SOURCE_EVALUATOR.evaluate(chimney())).toBe('clear');
  });
});

/** A random axis-aligned or skewed quadrilateral plus a query point near it, in 1e-4° units. */
const quad = fc
  .record({
    x: fc.integer({ min: 220_000, max: 280_000 }),
    y: fc.integer({ min: 412_000, max: 442_000 }),
    w: fc.integer({ min: 3, max: 300 }),
    h: fc.integer({ min: 3, max: 300 }),
    skew: fc.integer({ min: -100, max: 100 }),
  })
  .map(({ x, y, w, h, skew }): readonly Vertex[] => [
    [x, y],
    [x + w, y],
    [x + w + skew, y + h],
    [x + skew, y + h],
  ]);

const nearby = (ring: readonly Vertex[]) =>
  fc
    .record({
      dx: fc.integer({ min: -600, max: 600 }),
      dy: fc.integer({ min: -600, max: 600 }),
    })
    .map(({ dx, dy }) => {
      const [x, y] = ring[0] ?? [0, 0];
      return { lon: (x + dx) / 10_000, lat: (y + dy) / 10_000 };
    });

describe('the lookup (properties)', () => {
  it('agrees with a brute-force scan: the grid never loses a source', () => {
    fc.assert(
      fc.property(
        fc
          .array(quad, { minLength: 1, maxLength: 12 })
          .chain((rings) =>
            fc.tuple(fc.constant(rings), nearby(rings[0] ?? []), fc.integer({ min: 0, max: 5000 })),
          ),
        ([rings, point, radius]) => {
          const mask = maskOf(rings.map((r) => [0, r] as const));
          const brute = mask.sources
            .map((source) => staticSourceDistanceM(source, point, STATIC_SOURCE_METRIC))
            .filter((d) => d <= radius)
            .sort((a, b) => a - b);
          const indexed = staticSourcesWithin(mask, point, radius, STATIC_SOURCE_METRIC).map(
            (h) => h.distanceM,
          );
          expect(indexed).toEqual(brute);
        },
      ),
    );
  });

  it('is monotone in the radius', () => {
    fc.assert(
      fc.property(
        quad.chain((ring) => fc.tuple(fc.constant(ring), nearby(ring))),
        fc.integer({ min: 0, max: 2500 }),
        fc.integer({ min: 0, max: 2500 }),
        ([ring, point], a, b) => {
          const mask = maskOf([[1, ring]]);
          const small = nearestStaticSource(mask, point, Math.min(a, b), STATIC_SOURCE_METRIC);
          const large = nearestStaticSource(mask, point, Math.max(a, b), STATIC_SOURCE_METRIC);
          if (small !== null) expect(large?.distanceM).toBe(small.distanceM);
        },
      ),
    );
  });

  it('puts every vertex of a ring on the ring, and its centroid-ish interior inside', () => {
    fc.assert(
      fc.property(quad, (ring) => {
        const [source] = maskOf([[0, ring]]).sources;
        if (source === undefined) throw new Error('fixture');
        for (const v of source.vertices) {
          expect(staticSourceDistanceM(source, v, STATIC_SOURCE_METRIC)).toBe(0);
        }
        // The midpoint of the diagonal of a convex quadrilateral is inside it.
        const a = source.vertices[0];
        const c = source.vertices[2];
        if (a === undefined || c === undefined) throw new Error('fixture');
        const mid = { lon: (a.lon + c.lon) / 2, lat: (a.lat + c.lat) / 2 };
        expect(staticSourceDistanceM(source, mid, STATIC_SOURCE_METRIC)).toBe(0);
      }),
    );
  });

  it('never measures a negative or non-integer distance', () => {
    fc.assert(
      fc.property(
        quad.chain((ring) => fc.tuple(fc.constant(ring), nearby(ring))),
        ([ring, point]) => {
          const [source] = maskOf([[2, ring]]).sources;
          if (source === undefined) throw new Error('fixture');
          const d = staticSourceDistanceM(source, point, STATIC_SOURCE_METRIC);
          expect(Number.isInteger(d) && d >= 0).toBe(true);
        },
      ),
    );
  });
});
