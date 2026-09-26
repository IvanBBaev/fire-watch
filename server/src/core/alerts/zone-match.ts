/**
 * Does a watch zone contain an event, and how far is it (ADR-004 A1.10; 05 §5.3.2)?
 *
 * One definition, used by both places that ask: the live evaluation cycle (a fire moved;
 * which zones contain it?) and the zone-creation seed reader (a zone was drawn; which fires
 * does it contain?). If the two disagreed at the edge, a fire just inside a new zone's
 * radius could be left unseeded by one and then announced as "new fire" by the other —
 * A1.8's failure exactly. So the spatial SQL in the seed reader is a prefilter only, and the
 * decision is this function in both directions.
 *
 * **What is measured.** The distance is from the *stored* zone centre (A1.10: with
 * coarsening on, the snapped one; the click is gone) to the event's centroid, on the
 * clustering engine's planar metric (`clustering/geometry.ts`), and the containment test is
 * that engine's inclusive, quantised `withinKm`. The planar metric is deterministic on every
 * engine, which is what a replayable decision needs; it tracks the true arc to within
 * 0.2 % over the polled box. Measuring to the centroid rather than to the hull is the
 * simpler of two readings of "intersecting the zone" — the hull is nullable and a
 * hull-to-circle distance is not something the planar metric defines — and is listed as
 * an open decision in the H3 report rather than settled here.
 *
 * **What is never done.** The centre is a value in memory for the length of one
 * comparison. Nothing here formats, logs or returns it.
 */

import { CLUSTERING_PARAMS, type PlanarMetric } from '../clustering/clustering-params.js';
import { distanceKm, withinKm, type Coordinate } from '../clustering/geometry.js';
import { ZONE_GRID, indexCellsWithin, type ZoneGridParams } from '../zones/zone-geometry.js';

/** The metric zone distances are measured in. The clustering metric, by design. */
export const ZONE_MATCH_METRIC: PlanarMetric = CLUSTERING_PARAMS.values.metric;

/**
 * The distance from a stored zone centre to an event centroid, in km, when the event lies
 * within the zone's radius (inclusive on the metric's quantised grid); `null` otherwise.
 */
export function zoneDistanceWithin(
  zoneCentre: Coordinate,
  radiusM: number,
  eventCentroid: Coordinate,
  metric: PlanarMetric = ZONE_MATCH_METRIC,
): number | null {
  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new RangeError(`zone radius must be a non-negative number, got ${String(radiusM)}`);
  }
  const km = distanceKm(zoneCentre, eventCentroid, metric);
  return withinKm(km, radiusM / 1000, metric) ? km : null;
}

/**
 * The index cells in which any zone that could contain an event at `centroid` is filed —
 * the grid-key prefilter. Sized with the largest radius a zone may have, because the
 * lookup runs before any zone (and so any radius) is known; the exact test is
 * {@link zoneDistanceWithin}.
 */
export function candidateCellsFor(
  centroid: Coordinate,
  grid: ZoneGridParams = ZONE_GRID.values,
): readonly string[] {
  return indexCellsWithin(centroid, grid.maxRadiusM, grid);
}

/** A lat/lon box, degrees. */
export interface DegreeEnvelope {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
}

/**
 * A box that contains every centroid {@link zoneDistanceWithin} could accept for this
 * centre and radius — derived from the metric's own formula, so an index prefilter built
 * on it can never drop a match the exact test would keep. It is a prefilter only: callers
 * still run the exact test on everything inside it.
 *
 * Latitude: `dy = Δlat · kmPerDegreeLat ≤ r`. Longitude: km per degree varies linearly
 * with the pair's mean latitude, which lies within half the latitude span of the centre;
 * the smallest value over that range bounds `Δlon` from above. One extra quantum absorbs
 * the inclusive rounding of {@link withinKm}.
 */
export function zoneMatchEnvelope(
  centre: Coordinate,
  radiusM: number,
  metric: PlanarMetric = ZONE_MATCH_METRIC,
): DegreeEnvelope {
  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new RangeError(`zone radius must be a non-negative number, got ${String(radiusM)}`);
  }
  if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) {
    throw new RangeError('zone centre must be a finite coordinate');
  }
  const boundKm = radiusM / 1000 + metric.quantumKm;
  const dLat = boundKm / metric.kmPerDegreeLat;
  const kmPerDegreeLonAt = (lat: number): number =>
    metric.kmPerDegreeLonAtReference +
    metric.kmPerDegreeLonPerDegreeLat * (lat - metric.referenceLatDeg);
  const minKmPerDegreeLon = Math.min(
    kmPerDegreeLonAt(centre.lat - dLat / 2),
    kmPerDegreeLonAt(centre.lat + dLat / 2),
  );
  if (!(minKmPerDegreeLon > 0)) {
    throw new RangeError('the zone metric has no positive longitude scale at this latitude');
  }
  const dLon = boundKm / minKmPerDegreeLon;
  return {
    minLat: centre.lat - dLat,
    maxLat: centre.lat + dLat,
    minLon: centre.lon - dLon,
    maxLon: centre.lon + dLon,
  };
}
