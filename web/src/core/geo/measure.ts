/**
 * The measure tool's maths (V2-D3) — pure, no I/O, no map.
 *
 * Three questions a reader asks of the map: how long is this line (a polyline's length),
 * how big is this outline (a polygon's area), and how far is this place from the nearest
 * active fire. Every answer is on the sphere, not on the screen: Web Mercator stretches
 * distances by 1/cos(latitude), about 35 % at Bulgaria's latitude, so measuring pixels
 * would be wrong by a third.
 *
 * The Earth is the IUGG mean sphere (radius 6 371 008.8 m, the same one `bearing.ts` uses).
 * Against the WGS84 ellipsoid that is good to about 0.5 % for a distance and a little
 * more for an area — far inside what a satellite detection's own footprint can support,
 * and the panel says the result is approximate.
 *
 * It is a ruler, not a router: straight lines between the points the reader chose, never a
 * road or a drive time (GLOSSARY §5.2 "No routing, ever").
 */

import type { LonLat } from './bearing.js';

export type { LonLat } from './bearing.js';

/** Mean Earth radius (IUGG), in metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

export const MEASURE_MODES = ['distance', 'area', 'nearest'] as const;
export type MeasureMode = (typeof MEASURE_MODES)[number];

/** A path longer than this is someone holding the button down; the rest are refused. */
export const MAX_MEASURE_POINTS = 100;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

function isFinitePoint(point: LonLat): boolean {
  return Number.isFinite(point.lon) && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90;
}

/**
 * Great-circle distance between two points, in metres (haversine). The same formula as
 * `bearing.ts`'s `distanceKm`, written out here on purpose: this module loads only with the
 * lazy measure panel, and sharing one function with the entry chunk would split a shared
 * chunk off the critical path's bytes (CI-12).
 */
export function distanceMeters(from: LonLat, to: LonLat): number {
  const phi1 = toRadians(from.lat);
  const phi2 = toRadians(to.lat);
  const a =
    Math.sin((phi2 - phi1) / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(toRadians(to.lon - from.lon) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The length of the path through `points` in order, in metres; 0 for fewer than two. */
export function pathLengthMeters(points: readonly LonLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (from !== undefined && to !== undefined) total += distanceMeters(from, to);
  }
  return total;
}

/**
 * The area enclosed by `points` as a ring (closed implicitly; a repeated first point is
 * ignored), in square metres; 0 for fewer than three distinct vertices.
 *
 * Spherical polygon area by the line-integral form (Chamberlain & Duquette 2007, the
 * method OpenLayers and Turf use): Σ (λ₂ − λ₁)(2 + sin φ₁ + sin φ₂) · R² / 2. Exact for an
 * outline whose edges run along meridians and parallels, and within a fraction of a
 * percent for any outline a reader draws at map scale. The sign follows the winding, so
 * the absolute value is taken: a clockwise outline is the same field as an anticlockwise
 * one.
 */
export function polygonAreaSquareMeters(points: readonly LonLat[]): number {
  const ring = closedRingOpen(points);
  if (ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a === undefined || b === undefined) continue;
    total +=
      toRadians(unwrapLonDelta(b.lon - a.lon)) *
      (2 + Math.sin(toRadians(a.lat)) + Math.sin(toRadians(b.lat)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** The shorter way round between two longitudes, so an edge never wraps the globe. */
function unwrapLonDelta(delta: number): number {
  if (delta > 180) return delta - 360;
  if (delta < -180) return delta + 360;
  return delta;
}

/** The ring without a trailing copy of its first point. */
function closedRingOpen(points: readonly LonLat[]): readonly LonLat[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (
    points.length > 1 &&
    first !== undefined &&
    last !== undefined &&
    first.lon === last.lon &&
    first.lat === last.lat
  ) {
    return points.slice(0, -1);
  }
  return points;
}

export const SQUARE_METERS_PER_HECTARE = 10_000;

/** The candidate closest to `origin`, with its distance in metres; `null` when none is. */
export function nearestTo<T extends LonLat>(
  origin: LonLat,
  candidates: Iterable<T>,
): { readonly item: T; readonly meters: number } | null {
  let best: { item: T; meters: number } | null = null;
  for (const item of candidates) {
    if (!isFinitePoint(item)) continue;
    const meters = distanceMeters(origin, item);
    if (best === null || meters < best.meters) best = { item, meters };
  }
  return best;
}

/* ------------------------------------------------------------------------ */
/* The reader's points                                                       */
/* ------------------------------------------------------------------------ */

/**
 * The points after the reader adds `point` in `mode`. The nearest-fire question has one
 * place, so a new pick replaces it; a path or outline grows, up to {@link MAX_MEASURE_POINTS}.
 * A point that is not a real coordinate changes nothing.
 */
export function addMeasurePoint(
  mode: MeasureMode,
  points: readonly LonLat[],
  point: LonLat,
): readonly LonLat[] {
  if (!isFinitePoint(point)) return points;
  const clean = { lon: point.lon, lat: point.lat };
  if (mode === 'nearest') return [clean];
  if (points.length >= MAX_MEASURE_POINTS) return points;
  return [...points, clean];
}

/** The points without the last one; unchanged when there are none. */
export function undoMeasurePoint(points: readonly LonLat[]): readonly LonLat[] {
  return points.length === 0 ? points : points.slice(0, -1);
}

/** Points carried from one mode to another: a path keeps its points, a single pick does not. */
export function pointsForMode(mode: MeasureMode, points: readonly LonLat[]): readonly LonLat[] {
  if (mode === 'nearest') return points.length === 0 ? points : points.slice(-1);
  return points;
}

/* ------------------------------------------------------------------------ */
/* The answer                                                                */
/* ------------------------------------------------------------------------ */

export interface NearestCandidate extends LonLat {
  readonly id: string;
}

export type MeasureResult =
  | { readonly kind: 'needPoints'; readonly mode: MeasureMode }
  | { readonly kind: 'distance'; readonly meters: number }
  | { readonly kind: 'area'; readonly hectares: number; readonly perimeterMeters: number }
  | {
      readonly kind: 'nearest';
      readonly meters: number;
      readonly target: NearestCandidate;
    }
  | { readonly kind: 'nearestNone' };

/** What the panel says for these points. `candidates` matter only to the nearest question. */
export function measureResult(
  mode: MeasureMode,
  points: readonly LonLat[],
  candidates: Iterable<NearestCandidate>,
): MeasureResult {
  switch (mode) {
    case 'distance':
      return points.length < 2
        ? { kind: 'needPoints', mode }
        : { kind: 'distance', meters: pathLengthMeters(points) };
    case 'area':
      return points.length < 3
        ? { kind: 'needPoints', mode }
        : {
            kind: 'area',
            hectares: polygonAreaSquareMeters(points) / SQUARE_METERS_PER_HECTARE,
            perimeterMeters: pathLengthMeters([...points, points[0] as LonLat]),
          };
    case 'nearest': {
      const origin = points[points.length - 1];
      if (origin === undefined) return { kind: 'needPoints', mode };
      const nearest = nearestTo(origin, candidates);
      return nearest === null
        ? { kind: 'nearestNone' }
        : { kind: 'nearest', meters: nearest.meters, target: nearest.item };
    }
  }
}

/**
 * A length rounded for a sentence: whole metres to the nearest 10 below 1 km, one decimal
 * kilometre below 10 km, whole kilometres beyond. Never "0 m" for a real line.
 */
export function lengthForDisplay(meters: number): {
  readonly unit: 'm' | 'km';
  readonly value: number;
} {
  if (!Number.isFinite(meters) || meters < 0) return { unit: 'm', value: 0 };
  if (meters < 1000) {
    return { unit: 'm', value: meters === 0 ? 0 : Math.max(10, Math.round(meters / 10) * 10) };
  }
  const km = meters / 1000;
  if (km < 10) {
    const rounded = Math.round(km * 10) / 10;
    // 999.6 m rounds to 1000 m; 9.96 km must not read as "10.0".
    return { unit: 'km', value: rounded };
  }
  return { unit: 'km', value: Math.round(km) };
}

/* ------------------------------------------------------------------------ */
/* What the map draws                                                        */
/* ------------------------------------------------------------------------ */

/** Which part of the drawing a feature is; the layer styles by it. */
export type MeasureRole = 'vertex' | 'path' | 'area' | 'link' | 'target';

type Position = readonly [number, number];

export type MeasureFeature =
  | {
      readonly type: 'Feature';
      readonly geometry: { readonly type: 'Point'; readonly coordinates: Position };
      readonly properties: { readonly role: 'vertex' | 'target' };
    }
  | {
      readonly type: 'Feature';
      readonly geometry: { readonly type: 'LineString'; readonly coordinates: readonly Position[] };
      readonly properties: { readonly role: 'path' | 'link' };
    }
  | {
      readonly type: 'Feature';
      readonly geometry: {
        readonly type: 'Polygon';
        readonly coordinates: readonly (readonly Position[])[];
      };
      readonly properties: { readonly role: 'area' };
    };

export interface MeasureCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly MeasureFeature[];
}

const position = (point: LonLat): Position => [point.lon, point.lat];

/**
 * The drawing for these points: a dot per point, the path (distance), the outline and its
 * fill (area), or a line from the picked place to the nearest fire (nearest). Lines are
 * drawn straight on the map; at the scale anyone measures Bulgaria at, the great circle
 * and the straight line are the same pixels.
 */
export function measureCollection(
  mode: MeasureMode,
  points: readonly LonLat[],
  result: MeasureResult,
): MeasureCollection {
  const features: MeasureFeature[] = [];
  if (mode === 'distance' && points.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points.map(position) },
      properties: { role: 'path' },
    });
  }
  if (mode === 'area') {
    if (points.length >= 3) {
      const ring = [...points.map(position), position(points[0] as LonLat)];
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { role: 'area' },
      });
    } else if (points.length === 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: points.map(position) },
        properties: { role: 'path' },
      });
    }
  }
  if (mode === 'nearest' && result.kind === 'nearest') {
    const origin = points[points.length - 1];
    if (origin !== undefined) {
      features.push(
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [position(origin), position(result.target)],
          },
          properties: { role: 'link' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: position(result.target) },
          properties: { role: 'target' },
        },
      );
    }
  }
  for (const point of points) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: position(point) },
      properties: { role: 'vertex' },
    });
  }
  return { type: 'FeatureCollection', features };
}
