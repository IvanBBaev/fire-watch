/**
 * The one distance the identity engine measures with (ADR-002 D2, Appendix A rules 1
 * and 3).
 *
 * Two properties matter more than accuracy here, and they are why this is not a
 * haversine:
 *
 *   1. **Bit-identical across engines.** ECMAScript specifies `Math.sin`, `Math.cos` and
 *      `Math.atan2` as *implementation-approximated*: two V8 builds may legally return
 *      values differing in the last bits. A distance that differs in the last bits at
 *      exactly ε moves a detection from one event to another, and that changes a
 *      `public_id` that has already been published. The formula below uses only `+`, `−`,
 *      `×`, `÷` and `sqrt`.
 *   2. **Ties are reachable.** Every comparison goes through {@link quantizeKm} first.
 *      In double arithmetic `41.91 − 41.90` and `41.92 − 41.91` differ by ~1e-15, so
 *      "exactly equidistant" and "exactly ε" would otherwise never happen and the pinned
 *      tie-breaks of Appendix A would be unreachable code — with the real decision made
 *      by floating-point noise instead.
 *
 * The metric itself (kilometres per degree, the reference latitude, the quantum) is
 * versioned data in `clustering_params_v1`, because refitting ε and refitting the metric
 * ε is measured in are the same act.
 */

import type { PlanarMetric } from './clustering-params.js';

/** A point in degrees. Parsed once, at the edge, from the canonical 5 dp text. */
export interface Coordinate {
  readonly lat: number;
  readonly lon: number;
}

const CANONICAL_DEGREES_RE = /^-?\d{1,3}\.\d{5}$/;

/**
 * Parses the canonical decimal text the archive stores (GLOSSARY §1b) into the float the
 * metric works on. String→Number is exactly specified in ECMAScript (correctly rounded),
 * so this conversion is itself deterministic; doing it once here keeps the raw text as
 * the identity of the row and the float as a derived working value.
 */
export function parseCanonicalDegrees(text: string, what: string): number {
  if (!CANONICAL_DEGREES_RE.test(text)) {
    throw new RangeError(
      `${what} must be canonical 5-decimal degrees, got ${JSON.stringify(text)}`,
    );
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new RangeError(`${what} is not a finite number: ${JSON.stringify(text)}`);
  }
  return value;
}

/**
 * Renders a derived coordinate — an event centroid — onto the same 5 dp grid the
 * detections live on. Derived geometry that carried 17 significant digits would put
 * floating-point residue into `expected.json` and into the API, where it would look like
 * precision the instrument does not have.
 */
export function formatCanonicalDegrees(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`coordinate must be finite, got ${String(value)}`);
  }
  // Rounding before `toFixed` also normalises −0 to 0: `(-0).toFixed(5)` is "0.00000",
  // while `(-0.000001).toFixed(5)` would be "-0.00000".
  const rounded = Math.round(value * 1e5) / 1e5;
  return rounded.toFixed(5);
}

/**
 * Distance in kilometres on the fixed local tangent plane.
 *
 * The longitudinal scale is evaluated at the mean latitude of the pair and is linear in
 * latitude around the metric's reference. Over the whole polled box (39°–46° N) that
 * tracks the true prime-vertical arc to within 0.2 %, which is under 3 m across a 1.5 km
 * ε; over Bulgaria proper (41°–45° N) it is within 0.08 %, about 1.2 m. Both are an order
 * of magnitude below the 375 m pixel the ε describes, and — unlike the last-bit
 * disagreements a haversine can have between engines — the error is a fixed function of
 * position, identical on every machine and every replay.
 */
export function distanceKm(a: Coordinate, b: Coordinate, metric: PlanarMetric): number {
  assertFinite(a, 'a');
  assertFinite(b, 'b');
  const meanLat = (a.lat + b.lat) / 2;
  const kmPerDegreeLon =
    metric.kmPerDegreeLonAtReference +
    metric.kmPerDegreeLonPerDegreeLat * (meanLat - metric.referenceLatDeg);
  const dx = (a.lon - b.lon) * kmPerDegreeLon;
  const dy = (a.lat - b.lat) * metric.kmPerDegreeLat;
  return Math.sqrt(dx * dx + dy * dy);
}

function assertFinite(point: Coordinate, what: string): void {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
    throw new RangeError(
      `${what} must be a finite coordinate, got (${String(point.lat)}, ${String(point.lon)})`,
    );
  }
}

/**
 * A distance as an integer number of quanta. Comparisons are made on these integers, so
 * "equal" is a state the engine can actually reach and `Math.round`'s half-up rule is the
 * only rounding decision in the identity path.
 */
export function quantizeKm(km: number, metric: PlanarMetric): number {
  if (!Number.isFinite(km)) {
    throw new RangeError(`distance must be finite, got ${String(km)}`);
  }
  return Math.round(km / metric.quantumKm);
}

/**
 * `d ≤ bound`, inclusive, on the quantised grid (Appendix A rule 3: a quantity exactly
 * equal to a bound is inside it). Every spatial comparison in the engine goes through
 * this function — there is no second `<=` on a raw float anywhere in the identity path.
 */
export function withinKm(km: number, boundKm: number, metric: PlanarMetric): boolean {
  return quantizeKm(km, metric) <= quantizeKm(boundKm, metric);
}

/**
 * The arithmetic mean of the member coordinates, on the same plane the distances use.
 *
 * Floating-point addition is not associative, so the summation order is part of the
 * result: callers pass members in the engine's canonical order and get the same centroid
 * on every replay. The output is rounded to the 5 dp grid, which absorbs the last-bit
 * differences a different-but-equivalent summation order would produce.
 */
export function centroidOf(points: readonly Coordinate[]): Coordinate {
  if (points.length === 0) {
    throw new RangeError('a centroid needs at least one point');
  }
  let latSum = 0;
  let lonSum = 0;
  for (const point of points) {
    assertFinite(point, 'point');
    latSum += point.lat;
    lonSum += point.lon;
  }
  return {
    lat: Number(formatCanonicalDegrees(latSum / points.length)),
    lon: Number(formatCanonicalDegrees(lonSum / points.length)),
  };
}
