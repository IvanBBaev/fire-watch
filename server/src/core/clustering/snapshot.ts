/**
 * The batch outcome as bytes (CI-2, and the shape D5's `expected.json` is built from).
 *
 * A batch result contains floats — an ε of `1.5·√(scan·track)`, a centroid mid-average, a
 * distance out of a square root — and floats are the wrong currency for an artifact that
 * is compared byte for byte and reviewed by a human. Everything that leaves this module is
 * therefore either an integer, a canonical 5-decimal coordinate string, or an ISO instant:
 *
 *   * distances and ε in **quanta** (integer millimetres, `metric.quantumKm`), which is the
 *     same grid the engine's comparisons run on, so the artifact cannot disagree with the
 *     decision it records;
 *   * coordinates through `formatCanonicalDegrees`, the grid the detections themselves
 *     live on;
 *   * instants as `…Z` strings rather than epoch integers, because a fixture nobody can
 *     read is a fixture nobody notices is wrong.
 *
 * The serialization itself is `canonicalJson`, not `JSON.stringify`: key insertion order
 * is not a property anyone should have to maintain by hand.
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import { isoFromEpochMs } from '../ports/clock.js';
import { clusterCentroid, sourceMix } from './aggregates.js';
import { CLUSTERING_PARAMS, type PlanarMetric } from './clustering-params.js';
import { formatCanonicalDegrees, quantizeKm } from './geometry.js';
import type {
  BatchStats,
  Cluster,
  ClusterBatchResult,
  ClusterMerge,
  TouchedCluster,
  UnattachedDetection,
} from './types.js';

export interface ClusterSnapshot {
  readonly id: number;
  readonly publicId: string;
  readonly seedDetectionUid: string;
  readonly startedAt: string;
  readonly lastDetectionAt: string;
  readonly centroidLat: string;
  readonly centroidLon: string;
  readonly detectionCount: number;
  readonly sourceMix: Readonly<Record<string, number>>;
  /** Member `detection_uid`s in the engine's canonical member order. */
  readonly members: readonly string[];
  readonly configVersion: string;
}

export interface AssignmentSnapshot {
  readonly detectionUid: string;
  readonly acqTs: string;
  readonly clusterId: number;
  readonly publicId: string;
  readonly kind: 'seed' | 'attach';
  readonly epsQuanta: number;
  readonly footprintDefaulted: boolean;
  readonly distanceQuanta: number;
}

export interface SeedSnapshot {
  readonly clusterId: number;
  readonly publicId: string;
  readonly seedDetectionUid: string;
  readonly source: string;
  readonly startedAt: string;
  readonly lat: string;
  readonly lon: string;
  readonly epsQuanta: number;
}

export interface ClusteringSnapshot {
  readonly configVersion: string;
  readonly configDigest: string;
  readonly sourceRegistryVersion: string;
  readonly stats: BatchStats;
  readonly clusters: readonly ClusterSnapshot[];
  readonly assignments: readonly AssignmentSnapshot[];
  readonly seeded: readonly SeedSnapshot[];
  readonly merges: readonly ClusterMerge[];
  readonly touched: readonly TouchedCluster[];
  readonly unattached: readonly UnattachedDetection[];
  readonly evictedClusterIds: readonly number[];
  readonly nextClusterId: number;
  readonly takenPublicIds: readonly string[];
}

/**
 * @param metric the metric the batch actually ran under. Defaults to the current
 * parameter set's; a caller replaying an older `clustering_params_vN` must pass that
 * version's metric, or the quanta in the artifact would be measured on a different grid
 * than the decisions were.
 */
export function clusteringSnapshot(
  result: ClusterBatchResult,
  metric: PlanarMetric = CLUSTERING_PARAMS.values.metric,
): ClusteringSnapshot {
  return {
    configVersion: result.configVersion,
    configDigest: result.configDigest,
    sourceRegistryVersion: result.sourceRegistryVersion,
    stats: result.stats,
    clusters: result.state.clusters.map((cluster) => snapshotCluster(cluster)),
    assignments: result.assignments.map((assignment) => ({
      detectionUid: assignment.detectionUid,
      acqTs: assignment.acqTsIso,
      clusterId: assignment.clusterId,
      publicId: assignment.publicId,
      kind: assignment.kind,
      epsQuanta: quantizeKm(assignment.epsKm, metric),
      footprintDefaulted: assignment.footprintDefaulted,
      distanceQuanta: assignment.distanceQuanta,
    })),
    seeded: result.seeded.map((seed) => ({
      clusterId: seed.clusterId,
      publicId: seed.publicId,
      seedDetectionUid: seed.seedDetectionUid,
      source: seed.source,
      startedAt: seed.startedAtIso,
      lat: formatCanonicalDegrees(seed.coordinate.lat),
      lon: formatCanonicalDegrees(seed.coordinate.lon),
      epsQuanta: quantizeKm(seed.epsKm, metric),
    })),
    merges: result.merges,
    touched: result.touched,
    unattached: result.unattached,
    evictedClusterIds: result.evictedClusterIds,
    nextClusterId: result.state.nextClusterId,
    takenPublicIds: result.state.takenPublicIds,
  };
}

function snapshotCluster(cluster: Cluster): ClusterSnapshot {
  const centroid = clusterCentroid(cluster);
  return {
    id: cluster.id,
    publicId: cluster.publicId,
    seedDetectionUid: cluster.seedDetectionUid,
    startedAt: isoFromEpochMs(cluster.startedAt),
    lastDetectionAt: isoFromEpochMs(cluster.lastDetectionAt),
    centroidLat: formatCanonicalDegrees(centroid.lat),
    centroidLon: formatCanonicalDegrees(centroid.lon),
    detectionCount: cluster.members.length,
    sourceMix: sourceMix(cluster),
    members: cluster.members.map((member) => member.detectionUid),
    configVersion: cluster.configVersion,
  };
}

/**
 * The bytes CI-2 compares. Trailing newline so the artifact is a well-formed text file and
 * a diff of two of them is readable.
 */
export function serializeClusteringOutcome(
  result: ClusterBatchResult,
  metric: PlanarMetric = CLUSTERING_PARAMS.values.metric,
): string {
  return `${canonicalJson(clusteringSnapshot(result, metric))}\n`;
}
