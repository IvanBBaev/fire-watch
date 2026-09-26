/**
 * The convex hull of a set of detections, and the one number the over-merge guardrail is
 * measured with (ADR-002 D4).
 *
 * D4 refuses automatic splits: an event that has grown to look like two fires stays one
 * row until a person says otherwise, because splitting on a heuristic invents a second
 * `public_id` for something nobody has confirmed exists — and a published id cannot be
 * taken back (I1). What the engine does instead is *notice*. When the hull's diameter
 * exceeds `reviewHullDiameterKm`, the event is flagged `needs_review` and a curated split
 * becomes available to an admin. So the hull here exists to bound an extent, not to be
 * drawn: nothing downstream renders it, and its only consumer is a boolean.
 *
 * **Why the hull is built in degree space.** There is no single "kilometre space" to build
 * it in. `distanceKm` scales longitude at the *mean latitude of the pair being measured*,
 * so the km coordinates of a point depend on which other point it is compared with —
 * that is a metric, not an embedding. Degrees are an embedding, and the hull of a point
 * set is invariant under any fixed positive scaling of the two axes, which is exactly what
 * a fixed-scale tangent plane would be. Building it in degrees therefore gives the same
 * extreme points as any well-defined km embedding, while keeping the orientation test on
 * differences of the parsed 5 dp decimals — no square roots before a sign decision.
 * Kilometres enter afterwards, where they carry meaning: the diameter itself.
 */

import type { ClusteringParams, PlanarMetric } from './clustering-params.js';
import { distanceKm, withinKm, type Coordinate } from './geometry.js';

/**
 * The hull as a closed ring is not returned — only its distinct vertices, counter-clockwise
 * in degree space, starting from the lexicographically smallest `(lon, lat)`. A fixed
 * starting vertex and a fixed winding make the output a value the replay can compare
 * rather than a set someone has to normalise first.
 *
 * Collinear points on an edge are dropped: they are not extreme, they cannot be an endpoint
 * of the diameter (distance to a fixed point is convex along a segment, so a midpoint never
 * beats both ends), and keeping them would make the vertex list depend on how densely the
 * instrument happened to sample a straight fire front.
 *
 * Degenerate inputs come back as-is: one point is its own hull, two points are a segment,
 * and a wholly collinear set collapses to its two ends.
 */
export function convexHull(points: readonly Coordinate[]): readonly Coordinate[] {
  const distinct = distinctSorted(points);
  if (distinct.length <= 2) return distinct;

  const lower = halfHull(distinct);
  const upper = halfHull([...distinct].reverse());
  // Each half repeats the other's first vertex; drop the duplicates, not the vertices.
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The largest distance between any two of the points, in kilometres.
 *
 * Measured over hull vertices only. The diameter of a set equals the diameter of its convex
 * hull and is always realised by two extreme points, so this is not an approximation — it
 * is the same number for O(h²) work instead of O(n²), and `h` stays in single digits for a
 * fire while `n` can be thousands.
 *
 * Zero for a single point, by definition rather than by accident: an event with one
 * detection has no extent, and the guardrail must read "not wide" rather than "unknown".
 */
export function hullDiameterKm(points: readonly Coordinate[], metric: PlanarMetric): number {
  const hull = convexHull(points);
  if (hull.length === 0) {
    throw new RangeError('a hull diameter needs at least one point');
  }
  let widest = 0;
  for (let i = 0; i < hull.length; i += 1) {
    for (let j = i + 1; j < hull.length; j += 1) {
      const km = distanceKm(hull[i] as Coordinate, hull[j] as Coordinate, metric);
      if (km > widest) widest = km;
    }
  }
  return widest;
}

/**
 * The D4 guardrail: is this event wide enough that a human should look at it?
 *
 * "Exceeds" is meant literally — a hull of exactly `reviewHullDiameterKm` is inside the
 * bound (Appendix A rule 3), which is why this is the negation of {@link withinKm} rather
 * than a bare `>`. A 20 km fire that trips the flag by a millimetre of floating-point
 * residue would be an arbitrary difference between two identical fires, and the quantised
 * comparison is what makes "exactly at the threshold" a state the tests can reach.
 */
export function exceedsReviewDiameter(diameterKm: number, params: ClusteringParams): boolean {
  return !withinKm(diameterKm, params.reviewHullDiameterKm, params.metric);
}

/** Ascending by longitude, then latitude, with exact duplicates collapsed. */
function distinctSorted(points: readonly Coordinate[]): Coordinate[] {
  const sorted = [...points].sort((a, b) => {
    assertFinite(a);
    assertFinite(b);
    if (a.lon !== b.lon) return a.lon - b.lon;
    return a.lat - b.lat;
  });
  const distinct: Coordinate[] = [];
  for (const point of sorted) {
    assertFinite(point);
    const previous = distinct[distinct.length - 1];
    if (previous !== undefined && previous.lon === point.lon && previous.lat === point.lat) {
      continue;
    }
    distinct.push(point);
  }
  return distinct;
}

/**
 * One monotone chain (Andrew's algorithm). Pops on `cross <= 0`, so a vertex that only
 * continues a straight edge is discarded along with a genuinely concave one.
 */
function halfHull(sorted: readonly Coordinate[]): Coordinate[] {
  const chain: Coordinate[] = [];
  for (const point of sorted) {
    while (chain.length >= 2) {
      const back = chain[chain.length - 1] as Coordinate;
      const before = chain[chain.length - 2] as Coordinate;
      if (cross(before, back, point) > 0) break;
      chain.pop();
    }
    chain.push(point);
  }
  return chain;
}

/** Twice the signed area of `o → a → b`; positive when the turn is counter-clockwise. */
function cross(o: Coordinate, a: Coordinate, b: Coordinate): number {
  return (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);
}

function assertFinite(point: Coordinate): void {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
    throw new RangeError(
      `hull point must be finite, got (${String(point.lat)}, ${String(point.lon)})`,
    );
  }
}
