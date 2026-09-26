/**
 * The reignition window and radius (ADR-002 D2 "Reignition vs continuation", Appendix A
 * rules 3 and 5).
 *
 * This module answers "how long, how far, and — given the eligible candidates — which
 * one". Deciding that a reignition happened at all, classifying the fuel, reading the
 * archived events back and writing `related_event_id` is D3; what is pinned here is the
 * part Appendix A fixes in `clustering_params_v1`:
 *
 *   * an unclassified, null or no-majority land cover uses the **middle band**, never the
 *     7 d one and never the 21–30 d one (rule 5);
 *   * the radius is `2·ε` and the comparison against it is inclusive (rule 3);
 *   * among eligible parents the winner is nearest centroid, then oldest `started_at`,
 *     then lowest internal id (rule 2).
 *
 * The 2× is not decoration: two detections of one fire are always within one ε of a chain
 * member, so a reignition candidate one ε away from the *edge* of an old cluster is two ε
 * from where it was first seen.
 */

import type { EpochMs } from '../ports/clock.js';
import { CLUSTERING_PARAMS, type ClusteringParams, type FuelBand } from './clustering-params.js';
import { type Coordinate, distanceKm, quantizeKm } from './geometry.js';

const MS_PER_DAY = 86_400_000;

/**
 * `null` means the land cover is unknown, `unclassified`, or no class holds a ≥ 50 %
 * majority under the hull. All three are the same case and all three take the middle
 * band: guessing grass would refuse to relate a forest fire that reignited on day 10, and
 * guessing forest would attach a reignition claim to a stubble field burnt twice in a
 * fortnight (Appendix A rule 5).
 */
export function reignitionWindowDays(
  band: FuelBand | null,
  params: ClusteringParams = CLUSTERING_PARAMS.values,
): number {
  const resolved = band ?? params.unclassifiedFuelBand;
  // Partial view: the band is typed, but it arrives from a land-cover classifier, and a
  // missing band must throw rather than produce a NaN window that silently relates nothing.
  const table: Readonly<Partial<Record<FuelBand, number>>> = params.reignitionWindowDays;
  const days = table[resolved];
  if (days === undefined) {
    throw new RangeError(
      `no reignition window configured for fuel band ${JSON.stringify(resolved)}`,
    );
  }
  return days;
}

export function reignitionWindowMs(
  band: FuelBand | null,
  params: ClusteringParams = CLUSTERING_PARAMS.values,
): number {
  return reignitionWindowDays(band, params) * MS_PER_DAY;
}

/** The `2·ε` of the reignition rule, as a radius in kilometres. */
export function reignitionRadiusKm(
  epsKm: number,
  params: ClusteringParams = CLUSTERING_PARAMS.values,
): number {
  if (!Number.isFinite(epsKm) || epsKm <= 0) {
    throw new RangeError(`ε must be finite and positive, got ${String(epsKm)}`);
  }
  return epsKm * params.reignitionEpsMultiple;
}

/**
 * A past event D3 is considering as the parent of a new one.
 *
 * Deliberately not a {@link Cluster}: by the time a reignition is possible the parent has
 * left the 72 h working set and D3 reads it back from `fire_events`, where the centroid is
 * a stored aggregate rather than something recomputed from members.
 */
export interface ReignitionCandidate {
  readonly clusterId: number;
  readonly publicId: string;
  readonly centroid: Coordinate;
  readonly startedAt: EpochMs;
}

/**
 * Appendix A rule 2, as a comparator: nearest centroid, then oldest `started_at`, then
 * lowest internal cluster id.
 *
 * Distances are compared **quantised** (1 mm), not raw. Two candidates genuinely the same
 * distance from a new fire — the two halves of a horseshoe-shaped burn either side of a
 * ridge, which is the ordinary way this tie arises — differ by ~1e-13 km in double
 * arithmetic, so an unquantised comparison would let floating-point noise pick the parent
 * and the pinned rules below would never run.
 */
export function compareReignitionParent(
  a: ReignitionCandidate,
  b: ReignitionCandidate,
  at: Coordinate,
  params: ClusteringParams = CLUSTERING_PARAMS.values,
): number {
  const distanceA = quantizeKm(distanceKm(a.centroid, at, params.metric), params.metric);
  const distanceB = quantizeKm(distanceKm(b.centroid, at, params.metric), params.metric);
  if (distanceA !== distanceB) {
    return distanceA - distanceB;
  }
  if (a.startedAt !== b.startedAt) {
    return a.startedAt - b.startedAt;
  }
  return a.clusterId - b.clusterId;
}

/**
 * The parent of a reignition, or `null` when nothing is eligible.
 *
 * `null` rather than a throw, unlike `chooseSurvivor`: a merge with no clusters is a bug,
 * whereas a reignition scan that finds no candidate is the overwhelmingly common case —
 * almost every new fire is simply a new fire.
 *
 * Eligibility — within `W_fuel` of the parent's last detection and within `2·ε` of the new
 * cluster, both inclusive — is D3's filter, applied before this call. Splitting it that
 * way keeps the tie-break testable against candidates that are *exactly* equidistant,
 * which is the only case the rule exists for.
 *
 * Generic in the candidate so the winner comes back with whatever the caller passed in.
 * D3 supplies rows carrying the parent's last detection and fuel band, and it needs both of
 * them on the chosen one; widening them to {@link ReignitionCandidate} here would hand it a
 * value it has to narrow again by a cast — a cast this function is in no position to make
 * safe, and the only one in the path.
 */
export function chooseReignitionParent<T extends ReignitionCandidate>(
  candidates: readonly T[],
  at: Coordinate,
  params: ClusteringParams = CLUSTERING_PARAMS.values,
): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (best === null || compareReignitionParent(candidate, best, at, params) < 0) {
      best = candidate;
    }
  }
  return best;
}
