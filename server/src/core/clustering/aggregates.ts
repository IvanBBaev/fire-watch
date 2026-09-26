/**
 * Values derived from a cluster's members.
 *
 * Functions rather than fields on {@link Cluster}: a cached centroid that a merge forgot
 * to recompute is a wrong dot on a map, and the class of bug where derived state and its
 * source disagree is not worth the microseconds. Every one of these is a pure function of
 * the member list, which is itself kept in a fixed order, so they are replay-stable.
 */

import type { PlanarMetric } from './clustering-params.js';
import { centroidOf, distanceKm, type Coordinate } from './geometry.js';
import { convexHull, hullDiameterKm } from './hull.js';
import type { Cluster, ClusterMember } from './types.js';

export function clusterCentroid(cluster: Pick<Cluster, 'members'>): Coordinate {
  return centroidOf(cluster.members.map((member) => member.coordinate));
}

/**
 * The cluster's extent as a hull (D4). Derived like everything else here, which matters
 * more after a merge than before one: a survivor that inherited a cached hull from before
 * it absorbed anything would under-report its own width, and the `needs_review` flag that
 * width decides is the only thing standing between an over-merge and a published event
 * nobody looked at.
 */
export function clusterHull(cluster: Cluster): readonly Coordinate[] {
  return convexHull(cluster.members.map((member) => member.coordinate));
}

export function clusterDiameterKm(cluster: Cluster, metric: PlanarMetric): number {
  return hullDiameterKm(
    cluster.members.map((member) => member.coordinate),
    metric,
  );
}

/**
 * Detections per source, keys sorted. Sorted because this ends up in a canonical-JSON
 * report — `canonicalJson` sorts keys on the way out, but an unsorted object here would
 * make the in-memory value differ from the serialised one, and someone would eventually
 * compare the wrong one.
 */
export function sourceMix(cluster: Cluster): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const member of cluster.members) {
    counts.set(member.source, (counts.get(member.source) ?? 0) + 1);
  }
  const mix: Record<string, number> = {};
  for (const source of [...counts.keys()].sort()) {
    mix[source] = counts.get(source) ?? 0;
  }
  return mix;
}

/**
 * Single-link distance: the distance to the *nearest member*, not to the centroid.
 *
 * This is what makes a fire front cluster as one event. A 30 km long fire has a centroid
 * 15 km from its head, so a centroid test with ε = 1.25 km would start a new event every
 * time the front advanced, and each new event would get its own public id and its own
 * alert.
 */
export function distanceToClusterKm(
  cluster: Cluster,
  point: Coordinate,
  metric: PlanarMetric,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const member of cluster.members) {
    const km = distanceKm(point, member.coordinate, metric);
    if (km < nearest) nearest = km;
  }
  if (!Number.isFinite(nearest)) {
    throw new RangeError(`cluster ${String(cluster.id)} has no members to measure against`);
  }
  return nearest;
}

/**
 * Members in the engine's canonical order: acquisition time, then `detection_uid`.
 *
 * Not the arrival order. Two replays that deliver the same detections in different batches
 * — which is exactly what an SP re-cluster does — must produce the same member list, and
 * arrival order is a property of the delivery, not of the fire.
 */
export function orderMembers(members: readonly ClusterMember[]): ClusterMember[] {
  return [...members].sort((a, b) => {
    if (a.acqTs !== b.acqTs) return a.acqTs - b.acqTs;
    return a.detectionUid < b.detectionUid ? -1 : a.detectionUid > b.detectionUid ? 1 : 0;
  });
}
