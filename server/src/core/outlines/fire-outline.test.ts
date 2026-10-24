import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../determinism/canonical-json.js';
import { FIRE_OUTLINE_PARAMS, type FireOutlineValues } from '../config/fire-outline.js';
import { assertDeterministic } from '../replay/double-run.js';
import { EMPTY_OUTLINE, drawFireOutline, type OutlineDetection } from './fire-outline.js';

const PARAMS = FIRE_OUTLINE_PARAMS.values;

function viirs(uid: string, lat: number, lon: number): OutlineDetection {
  return { uid, sourceId: 'firms:viirs:noaa21', lat, lon, scanKm: 0.375, trackKm: 0.375 };
}

/** Degrees per kilometre at 42.7° N on the configured plane. */
const DEG_LAT_PER_KM = 1 / PARAMS.metric.kmPerDegreeLat;
const DEG_LON_PER_KM = 1 / PARAMS.metric.kmPerDegreeLonAtReference;

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** A row of `n` VIIRS pixels `stepKm` apart, west to east, starting at 42.7° N 25.0° E. */
function row(n: number, stepKm: number, prefix = 'p'): OutlineDetection[] {
  return Array.from({ length: n }, (_, k) =>
    viirs(`${prefix}${String(k).padStart(4, '0')}`, 42.7, round5(25 + k * stepKm * DEG_LON_PER_KM)),
  );
}

describe('drawFireOutline', () => {
  it('draws nothing from no detections', () => {
    expect(drawFireOutline([], PARAMS)).toBe(EMPTY_OUTLINE);
  });

  it('leaves SLSTR and geostationary detections out', () => {
    const outline = drawFireOutline(
      [
        { uid: 'a', sourceId: 'eumetsat:slstr:frp', lat: 42.7, lon: 25, scanKm: 1, trackKm: 1 },
        { uid: 'b', sourceId: 'lsasaf:fci:frp-pixel', lat: 42.7, lon: 25, scanKm: 3, trackKm: 3 },
      ],
      PARAMS,
    );
    expect(outline).toEqual(EMPTY_OUTLINE);
  });

  it('draws one VIIRS pixel at about its own area', () => {
    const outline = drawFireOutline([viirs('a', 42.7, 25)], PARAMS);
    // 0.375 km × 0.375 km = 14.06 ha; the 50 m raster resolves it to within a cell row.
    expect(outline.areaHa).toBeGreaterThan(11);
    expect(outline.areaHa).toBeLessThan(17);
    expect(outline.footprints).toBe(1);
    expect(outline.edgeUncertaintyKm).toBe(0.188);
    expect(outline.geometry?.coordinates).toHaveLength(1);
    const ring = outline.geometry?.coordinates[0]?.[0] ?? [];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring.at(-1));
  });

  it('brackets the area with a band that contains it', () => {
    const outline = drawFireOutline(row(5, 0.375), PARAMS);
    const { areaHa, areaLowHa, areaHighHa } = outline;
    expect(areaLowHa).not.toBeNull();
    expect(areaLowHa as number).toBeLessThan(areaHa as number);
    expect(areaHighHa as number).toBeGreaterThan(areaHa as number);
    expect(areaLowHa as number).toBeGreaterThanOrEqual(0);
  });

  it('joins footprints closer than two closing radii into one polygon', () => {
    // 0.375 km pixels with centres 1 km apart: a 0.625 km gap, under 2 × 0.375 km.
    const outline = drawFireOutline(row(3, 1.0), PARAMS);
    expect(outline.geometry?.coordinates).toHaveLength(1);
  });

  it('keeps footprints farther apart than two closing radii as separate polygons', () => {
    // Centres 2 km apart: a 1.625 km gap.
    const outline = drawFireOutline(row(3, 2.0), PARAMS);
    expect(outline.geometry?.coordinates).toHaveLength(3);
  });

  it('draws outer rings counter-clockwise and closed (RFC 7946)', () => {
    const outline = drawFireOutline(
      [
        ...row(4, 0.3),
        ...row(4, 0.3, 'q').map((d) => ({ ...d, lat: round5(d.lat + 0.4 * DEG_LAT_PER_KM) })),
      ],
      PARAMS,
    );
    for (const polygon of outline.geometry?.coordinates ?? []) {
      expect(polygon).toHaveLength(1);
      const ring = polygon[0] ?? [];
      expect(ring[0]).toEqual(ring.at(-1));
      let sum = 0;
      for (let k = 0; k + 1 < ring.length; k += 1) {
        const [x0, y0] = ring[k] as readonly [number, number];
        const [x1, y1] = ring[k + 1] as readonly [number, number];
        sum += x0 * y1 - x1 * y0;
      }
      expect(sum).toBeGreaterThan(0);
    }
  });

  it('fills an enclosed gap: an outline has no holes', () => {
    // A ring of pixels 3 km across with an empty middle.
    const ring: OutlineDetection[] = [];
    for (let k = 0; k < 8; k += 1) {
      for (const [dx, dy] of [
        [k * 0.375, 0],
        [k * 0.375, 2.625],
        [0, k * 0.375],
        [2.625, k * 0.375],
      ] as const) {
        ring.push(
          viirs(
            `r${String(ring.length).padStart(3, '0')}`,
            round5(42.7 + dy * DEG_LAT_PER_KM),
            round5(25 + dx * DEG_LON_PER_KM),
          ),
        );
      }
    }
    const outline = drawFireOutline(ring, PARAMS);
    expect(outline.geometry?.coordinates).toHaveLength(1);
    expect(outline.geometry?.coordinates[0]).toHaveLength(1);
    // 3 km × 3 km = 900 ha; with the middle filled the count is close to it.
    expect(outline.areaHa as number).toBeGreaterThan(800);
  });

  it('uses the source default footprint when a row carries none', () => {
    const modis = drawFireOutline(
      [{ uid: 'm', sourceId: 'firms:modis', lat: 42.7, lon: 25, scanKm: null, trackKm: null }],
      PARAMS,
    );
    // 1 km × 1 km = 100 ha.
    expect(modis.areaHa as number).toBeGreaterThan(90);
    expect(modis.areaHa as number).toBeLessThan(110);
    expect(modis.edgeUncertaintyKm).toBe(0.5);
  });

  it('coarsens the raster rather than exceed the grid budget', () => {
    const tight: FireOutlineValues = { ...PARAMS, maxGridCells: 2_000 };
    const outline = drawFireOutline(row(10, 0.3), tight);
    expect(outline.geometry).not.toBeNull();
    expect(outline.areaHa as number).toBeGreaterThan(0);
  });

  it('simplifies a ring that exceeds the vertex budget', () => {
    const jagged: OutlineDetection[] = Array.from({ length: 60 }, (_, k) =>
      viirs(
        `j${String(k).padStart(3, '0')}`,
        round5(42.7 + (k % 2) * 0.2 * DEG_LAT_PER_KM),
        round5(25 + k * 0.3 * DEG_LON_PER_KM),
      ),
    );
    const outline = drawFireOutline(jagged, { ...PARAMS, maxVerticesPerRing: 16 });
    for (const polygon of outline.geometry?.coordinates ?? []) {
      expect((polygon[0] ?? []).length).toBeLessThanOrEqual(17);
    }
  });

  it('keeps at most maxPolygons polygons, largest first, while the area counts all', () => {
    const all = drawFireOutline(row(5, 3), PARAMS);
    const capped = drawFireOutline(row(5, 3), { ...PARAMS, maxPolygons: 2 });
    expect(capped.geometry?.coordinates).toHaveLength(2);
    expect(capped.areaHa).toBe(all.areaHa);
  });

  it('rejects a non-finite coordinate', () => {
    expect(() => drawFireOutline([viirs('a', Number.NaN, 25)], PARAMS)).toThrow(RangeError);
  });
});

describe('drawFireOutline determinism', () => {
  const detections = [
    ...row(12, 0.31),
    ...row(7, 0.42, 'n').map((d) => ({ ...d, lat: round5(d.lat + 0.5 * DEG_LAT_PER_KM) })),
    { uid: 'm', sourceId: 'firms:modis', lat: 42.69, lon: 25.01, scanKm: 1.2, trackKm: 1.1 },
  ];

  it('draws the same bytes on two runs (replay double-run)', () => {
    assertDeterministic('fire-outline', () => canonicalJson(drawFireOutline(detections, PARAMS)));
  });

  it('does not depend on input order', () => {
    const forward = canonicalJson(drawFireOutline(detections, PARAMS));
    const reversed = canonicalJson(drawFireOutline(detections.toReversed(), PARAMS));
    expect(reversed).toBe(forward);
  });

  it('pins the bytes of a small outline', () => {
    expect(canonicalJson(drawFireOutline(row(2, 0.375), PARAMS))).toMatchInlineSnapshot(
      `"{"areaHa":30,"areaHighHa":73.1,"areaLowHa":0,"edgeUncertaintyKm":0.188,"footprints":2,"geometry":{"coordinates":[[[[24.99771,42.69831],[25.00687,42.69831],[25.00687,42.70191],[24.99771,42.70191],[24.99771,42.69831]]]],"type":"MultiPolygon"}}"`,
    );
  });
});
