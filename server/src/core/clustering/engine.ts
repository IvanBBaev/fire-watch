/**
 * The per-batch incremental clustering algorithm (ADR-002 D2).
 *
 * The ADR states it in six lines:
 *
 * ```
 * for each new detection d (ordered by available_at, source, lat, lon):
 *   candidates = active clusters with any detection within eps(d.source) of d
 *                and last_detection_at within T_LINK
 *   0 candidates -> create cluster (seed)
 *   1 candidate  -> attach
 *   N candidates -> attach d; if d.source is a FINE source, merge clusters
 *                   (coarse/GEO detections NEVER trigger merges — attach to the
 *                    nearest candidate only)
 * ```
 *
 * This file is that loop and nothing else. Three properties are load-bearing:
 *
 *   * **Pure.** `(batch, state, config) → (state, outcome)`. No store, no clock call, no
 *     SQL. That is what lets the golden replay (CI-1) run the same code the live poller
 *     runs, instead of a second implementation that agrees with it until it doesn't.
 *   * **Order-independent.** The input is re-sorted into the canonical batch order before
 *     the loop, so the order rows arrive in — DB physical order, two sources interleaved
 *     differently on a replay — cannot change the event graph (CI-2).
 *   * **Incremental.** A cluster created earlier in the same batch is a candidate for a
 *     later detection. A batch is not a fresh DBSCAN over a window; it is a continuation
 *     of the working set, which is why a fire keeps its `public_id` across polls.
 *
 * What this file deliberately does not do: registry-side merge semantics (tombstones,
 * alias chains, `migrateAlertState`, `event.merged`) are D2's; reignition linking is D3's;
 * lifecycle states are D4's. Each of them consumes a record this file emits rather than
 * re-deriving it from two snapshots — see {@link ClusterMerge}, {@link SeededCluster} and
 * {@link TouchedCluster}.
 */

import { SOURCE_REGISTRY_VERSION } from '@fire-watch/contracts';

import { assertTotalOrder, orderBatch } from '../determinism/batch-order.js';
import { epochMsFromIso, isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import { distanceToClusterKm, orderMembers } from './aggregates.js';
import { activeWindowMs, tLinkMs, type ClusteringParams } from './clustering-params.js';
import { epsKmFor, isAttachOnly } from './eps.js';
import { parseCanonicalDegrees, quantizeKm, withinKm, type Coordinate } from './geometry.js';
import { compareSurvivor } from './merge-rule.js';
import { mintPublicId } from './public-id.js';
import type {
  Assignment,
  Cluster,
  ClusterBatchInput,
  ClusterBatchResult,
  ClusterMember,
  ClusterMerge,
  ClusteringState,
  SeededCluster,
  TouchedCluster,
  UnattachedDetection,
} from './types.js';

/** The starting state: no clusters, ids from 1, no id ever minted. */
export function emptyState(): ClusteringState {
  return { clusters: [], nextClusterId: 1, takenPublicIds: [] };
}

/** A cluster while the batch is running. The only mutable structure in this module. */
interface WorkingCluster {
  readonly id: number;
  readonly publicId: string;
  readonly seedDetectionUid: string;
  readonly mintedAt: EpochMs;
  startedAt: EpochMs;
  lastDetectionAt: EpochMs;
  members: ClusterMember[];
  readonly configVersion: string;
  readonly sourceRegistryVersion: string;
}

/** Accumulated per cluster, folded on merge, emitted as {@link TouchedCluster}. */
interface TouchedAccumulator {
  clusterId: number;
  publicId: string;
  /** The cluster's `last_detection_at` before this batch; `null` if seeded in it. */
  previousLastDetectionAt: EpochMs | null;
  lastDetectionAt: EpochMs;
  attachedCount: number;
  fineAttached: boolean;
}

interface Candidate {
  readonly cluster: WorkingCluster;
  readonly quanta: number;
}

export function clusterBatch(input: ClusterBatchInput): ClusterBatchResult {
  const params: ClusteringParams = input.config.values;
  const metric = params.metric;
  const tLink = tLinkMs(params);
  const activeWindow = activeWindowMs(params);
  const now = input.now;

  if (!Number.isFinite(now)) {
    throw new RangeError(`batch instant must be a finite epoch millisecond, got ${String(now)}`);
  }

  const takenPublicIds = new Set(input.state.takenPublicIds);
  // Built before eviction: a row re-delivered by an overlapping poll must be recognised as
  // already assigned even if its cluster has just aged out of the working set, otherwise
  // the overlap would mint a second event for a detection that already has one.
  const assignedUids = new Set<string>();
  for (const cluster of input.state.clusters) {
    for (const member of cluster.members) {
      assignedUids.add(member.detectionUid);
    }
  }

  // ── Eviction ────────────────────────────────────────────────────────────────────────
  // The 72 h active window is measured against the batch instant, not between detections:
  // it is "how long a fire stays attach-eligible with no new evidence at all". T_LINK is
  // measured between acquisitions and is the tighter of the two in normal operation.
  const working: WorkingCluster[] = [];
  const evictedClusterIds: number[] = [];
  for (const cluster of [...input.state.clusters].sort((a, b) => a.id - b.id)) {
    if (now - cluster.lastDetectionAt <= activeWindow) {
      working.push(toWorking(cluster));
    } else {
      evictedClusterIds.push(cluster.id);
    }
  }
  const previousLastDetectionAt = new Map<number, EpochMs>();
  for (const cluster of working) {
    previousLastDetectionAt.set(cluster.id, cluster.lastDetectionAt);
  }

  const ordered = orderBatch(input.detections);
  assertTotalOrder(ordered);

  const assignments: Assignment[] = [];
  const seeded: SeededCluster[] = [];
  const merges: ClusterMerge[] = [];
  const unattached: UnattachedDetection[] = [];
  const touched = new Map<number, TouchedAccumulator>();
  let nextClusterId = input.state.nextClusterId;
  let alreadyAssigned = 0;
  let footprintDefaultedCount = 0;
  let absorbedCount = 0;

  for (const detection of ordered) {
    if (assignedUids.has(detection.detectionUid)) {
      alreadyAssigned += 1;
      continue;
    }
    assignedUids.add(detection.detectionUid);

    const eps = epsKmFor(
      detection.source,
      { scanKm: detection.scanKm, trackKm: detection.trackKm },
      params,
    );
    if (eps.footprintDefaulted) footprintDefaultedCount += 1;

    const coordinate: Coordinate = {
      lat: parseCanonicalDegrees(detection.latCanonical, 'latitude'),
      lon: parseCanonicalDegrees(detection.lonCanonical, 'longitude'),
    };
    const acqTs = epochMsFromIso(detection.acqTsIso);
    const attachOnly = isAttachOnly(detection.source);

    const candidates: Candidate[] = [];
    for (const cluster of working) {
      if (temporalGapMs(cluster, acqTs) > tLink) continue;
      const km = distanceToClusterKm(cluster, coordinate, metric);
      if (!withinKm(km, eps.km, metric)) continue;
      candidates.push({ cluster, quanta: quantizeKm(km, metric) });
    }

    const member: ClusterMember = {
      detectionUid: detection.detectionUid,
      source: detection.source,
      acqTsIso: detection.acqTsIso,
      acqTs,
      latCanonical: detection.latCanonical,
      lonCanonical: detection.lonCanonical,
      coordinate,
      epsKm: eps.km,
      footprintDefaulted: eps.footprintDefaulted,
    };

    // ── 0 candidates ──────────────────────────────────────────────────────────────────
    if (candidates.length === 0) {
      if (attachOnly) {
        // A1.5: an event needs at least one fine detection. A ~5 km GEO pixel on its own
        // is a heat signal nobody can point at, so it corroborates or it waits — it never
        // creates. The row stays in the archive; it simply is not evidence of an event.
        unattached.push({
          detectionUid: detection.detectionUid,
          source: detection.source,
          reason: 'coarse_no_candidate',
        });
        continue;
      }
      const cluster = seedCluster({
        id: nextClusterId,
        member,
        mintedAt: now,
        configVersion: input.config.version,
        isTaken: (candidate) => takenPublicIds.has(candidate),
      });
      nextClusterId += 1;
      takenPublicIds.add(cluster.publicId);
      working.push(cluster);
      assignments.push({
        detectionUid: detection.detectionUid,
        acqTsIso: detection.acqTsIso,
        clusterId: cluster.id,
        publicId: cluster.publicId,
        kind: 'seed',
        epsKm: eps.km,
        footprintDefaulted: eps.footprintDefaulted,
        distanceQuanta: 0,
      });
      seeded.push({
        clusterId: cluster.id,
        publicId: cluster.publicId,
        seedDetectionUid: detection.detectionUid,
        source: detection.source,
        startedAtIso: detection.acqTsIso,
        coordinate,
        epsKm: eps.km,
      });
      recordTouch(touched, cluster, previousLastDetectionAt, !attachOnly);
      continue;
    }

    // ── N candidates, fine source: merge ──────────────────────────────────────────────
    // A fine detection that is within ε of two clusters is evidence they were always one
    // fire seen through a gap in the observations. Only a fine source may say so: a GEO
    // pixel covers both clusters and half the valley, so letting it bridge would
    // manufacture a chimera that then keeps one of the two published ids.
    let target: WorkingCluster;
    if (candidates.length > 1 && !attachOnly) {
      target = mergeCandidates({
        candidates,
        working,
        touched,
        assignments,
        previousLastDetectionAt,
        bridgedByDetectionUid: detection.detectionUid,
        merges,
      });
      absorbedCount += candidates.length - 1;
    } else {
      // 1 candidate, or a coarse row with several: attach to the nearest, ties to the
      // lowest internal cluster id (Appendix A rule 1).
      target = nearestCandidate(candidates).cluster;
    }

    // Measured before the detection joins, otherwise the answer is always zero.
    const distanceQuanta = quantizeKm(distanceToClusterKm(target, coordinate, metric), metric);
    attachMember(target, member);
    assignments.push({
      detectionUid: detection.detectionUid,
      acqTsIso: detection.acqTsIso,
      clusterId: target.id,
      publicId: target.publicId,
      kind: 'attach',
      epsKm: eps.km,
      footprintDefaulted: eps.footprintDefaulted,
      distanceQuanta,
    });
    recordTouch(touched, target, previousLastDetectionAt, !attachOnly);
  }

  const clusters = working.map(freezeCluster).sort((a, b) => a.id - b.id);
  const state: ClusteringState = {
    clusters,
    nextClusterId,
    takenPublicIds: [...takenPublicIds].sort(compareAscii),
  };

  const attachedCount = assignments.filter((assignment) => assignment.kind === 'attach').length;

  return {
    state,
    assignments: assignments.sort(compareAssignments),
    seeded: seeded.sort((a, b) => a.clusterId - b.clusterId),
    merges: merges.sort(compareMerges),
    touched: [...touched.values()].sort((a, b) => a.clusterId - b.clusterId).map(toTouchedCluster),
    unattached: unattached.sort((a, b) => compareAscii(a.detectionUid, b.detectionUid)),
    evictedClusterIds,
    stats: {
      detections: ordered.length,
      seeded: seeded.length,
      attached: attachedCount,
      merged: absorbedCount,
      unattached: unattached.length,
      alreadyAssigned,
      footprintDefaulted: footprintDefaultedCount,
      evicted: evictedClusterIds.length,
    },
    configVersion: input.config.version,
    configDigest: input.config.digest,
    sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
  };
}

/**
 * The temporal distance from a detection to a cluster, in milliseconds.
 *
 * The ADR phrases the test as "`last_detection_at` within T_LINK", which is what this
 * returns for the ordinary case of a detection newer than everything in the cluster. The
 * generalisation is the `acqTs < startedAt` branch: a row can arrive late — a provider
 * backfill, an SP re-cluster, a source whose `available_at` lags its `acq_ts` by a day —
 * and measuring such a row against `last_detection_at` alone would score a detection from
 * the middle of a week-long fire as "5 days away" and seed a second event inside the first
 * one. A detection inside the cluster's own span has a gap of zero, which is the only
 * answer that is true of a fire that was burning at that moment.
 */
function temporalGapMs(cluster: WorkingCluster, acqTs: EpochMs): number {
  if (acqTs > cluster.lastDetectionAt) return acqTs - cluster.lastDetectionAt;
  if (acqTs < cluster.startedAt) return cluster.startedAt - acqTs;
  return 0;
}

/**
 * Nearest by quantised distance, ties broken by the **lowest internal cluster id**
 * (Appendix A rule 1).
 *
 * Never insertion order, never `public_id`, never "first one found". Two clusters
 * symmetric about a GEO pixel is not a hypothetical — it is what a fire that split around
 * a ridge looks like from geostationary orbit — and "first found" would make the winner a
 * property of the order the working set happened to be in.
 */
function nearestCandidate(candidates: readonly Candidate[]): Candidate {
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    if (candidate.quanta < best.quanta) {
      best = candidate;
    } else if (candidate.quanta === best.quanta && candidate.cluster.id < best.cluster.id) {
      best = candidate;
    }
  }
  if (best === undefined) {
    throw new RangeError('nearestCandidate called with no candidates');
  }
  return best;
}

interface MergeInput {
  readonly candidates: readonly Candidate[];
  readonly working: WorkingCluster[];
  readonly touched: Map<number, TouchedAccumulator>;
  readonly assignments: Assignment[];
  readonly previousLastDetectionAt: Map<number, EpochMs>;
  readonly bridgedByDetectionUid: string;
  readonly merges: ClusterMerge[];
}

/**
 * Structurally unions the candidate clusters and returns the survivor.
 *
 * The union happens here, inside the batch, because the rest of the batch has to see a
 * consistent working set: a second detection 200 m behind the bridging one must not find
 * the two halves still separate and pick one of them. What is *not* done here is the
 * registry side of D3 — tombstones, alias chains, aggregate re-attribution,
 * `migrateAlertState`, the `event.merged` broadcast. Those read the emitted
 * {@link ClusterMerge}.
 *
 * Assignments already emitted in this batch for an absorbed cluster are rewritten onto the
 * survivor, so `event_detections` never points at a cluster that no longer exists. Merge
 * records are left chained (a survivor absorbed by a later merge stays recorded as the
 * survivor of the earlier one) because D3 resolves alias chains with path compression;
 * flattening here would erase the order the two merges happened in.
 */
function mergeCandidates(input: MergeInput): WorkingCluster {
  const clusters = input.candidates.map((candidate) => candidate.cluster);
  const [first, ...rest] = clusters;
  if (first === undefined) {
    throw new RangeError('a merge needs at least one candidate');
  }
  // `compareSurvivor` rather than a local "oldest wins": D2 applies the identical ordering
  // to the registry side of the merge, and two implementations of one tie-break eventually
  // disagree, leaving the working set and the event table pointing at different survivors.
  let survivor = first;
  for (const cluster of rest) {
    if (compareSurvivor(cluster, survivor) < 0) survivor = cluster;
  }
  const absorbed = clusters
    .filter((cluster) => cluster.id !== survivor.id)
    .sort((a, b) => a.id - b.id);

  const survivorTouch = ensureTouch(input.touched, survivor, input.previousLastDetectionAt);

  for (const loser of absorbed) {
    survivor.members = survivor.members.concat(loser.members);
    survivor.startedAt = Math.min(survivor.startedAt, loser.startedAt);
    survivor.lastDetectionAt = Math.max(survivor.lastDetectionAt, loser.lastDetectionAt);

    const index = input.working.findIndex((cluster) => cluster.id === loser.id);
    if (index >= 0) input.working.splice(index, 1);

    for (let i = 0; i < input.assignments.length; i += 1) {
      const assignment = input.assignments[i];
      if (assignment && assignment.clusterId === loser.id) {
        input.assignments[i] = {
          ...assignment,
          clusterId: survivor.id,
          publicId: survivor.publicId,
        };
      }
    }

    const loserTouch = input.touched.get(loser.id);
    if (loserTouch) {
      survivorTouch.attachedCount += loserTouch.attachedCount;
      survivorTouch.fineAttached = survivorTouch.fineAttached || loserTouch.fineAttached;
      survivorTouch.lastDetectionAt = Math.max(
        survivorTouch.lastDetectionAt,
        loserTouch.lastDetectionAt,
      );
      input.touched.delete(loser.id);
    }
    // The merged entity's "last seen before this batch" is the most recent of the
    // pre-batch values it is made of — the fire was visible then, under one id or another.
    const loserPrevious = input.previousLastDetectionAt.get(loser.id);
    if (loserPrevious !== undefined) {
      survivorTouch.previousLastDetectionAt =
        survivorTouch.previousLastDetectionAt === null
          ? loserPrevious
          : Math.max(survivorTouch.previousLastDetectionAt, loserPrevious);
    }
  }

  survivor.members = orderMembers(survivor.members);
  input.merges.push({
    survivorClusterId: survivor.id,
    survivorPublicId: survivor.publicId,
    absorbedClusterIds: absorbed.map((cluster) => cluster.id),
    absorbedPublicIds: absorbed.map((cluster) => cluster.publicId),
    bridgedByDetectionUid: input.bridgedByDetectionUid,
  });
  return survivor;
}

interface SeedInput {
  readonly id: number;
  readonly member: ClusterMember;
  readonly mintedAt: EpochMs;
  readonly configVersion: string;
  readonly isTaken: (candidate: string) => boolean;
}

function seedCluster(input: SeedInput): WorkingCluster {
  const publicId = mintPublicId({
    seed: input.member.detectionUid,
    mintedAt: input.mintedAt,
    isTaken: input.isTaken,
  });
  return {
    id: input.id,
    publicId,
    seedDetectionUid: input.member.detectionUid,
    mintedAt: input.mintedAt,
    startedAt: input.member.acqTs,
    lastDetectionAt: input.member.acqTs,
    members: [input.member],
    configVersion: input.configVersion,
    sourceRegistryVersion: SOURCE_REGISTRY_VERSION,
  };
}

function attachMember(cluster: WorkingCluster, member: ClusterMember): void {
  cluster.members = orderMembers(cluster.members.concat(member));
  cluster.startedAt = Math.min(cluster.startedAt, member.acqTs);
  cluster.lastDetectionAt = Math.max(cluster.lastDetectionAt, member.acqTs);
}

function ensureTouch(
  touched: Map<number, TouchedAccumulator>,
  cluster: WorkingCluster,
  previousLastDetectionAt: Map<number, EpochMs>,
): TouchedAccumulator {
  const existing = touched.get(cluster.id);
  if (existing) return existing;
  const created: TouchedAccumulator = {
    clusterId: cluster.id,
    publicId: cluster.publicId,
    previousLastDetectionAt: previousLastDetectionAt.get(cluster.id) ?? null,
    lastDetectionAt: cluster.lastDetectionAt,
    attachedCount: 0,
    fineAttached: false,
  };
  touched.set(cluster.id, created);
  return created;
}

function recordTouch(
  touched: Map<number, TouchedAccumulator>,
  cluster: WorkingCluster,
  previousLastDetectionAt: Map<number, EpochMs>,
  fine: boolean,
): void {
  const accumulator = ensureTouch(touched, cluster, previousLastDetectionAt);
  accumulator.attachedCount += 1;
  accumulator.fineAttached = accumulator.fineAttached || fine;
  accumulator.lastDetectionAt = Math.max(accumulator.lastDetectionAt, cluster.lastDetectionAt);
}

function toTouchedCluster(accumulator: TouchedAccumulator): TouchedCluster {
  const previous = accumulator.previousLastDetectionAt;
  return {
    clusterId: accumulator.clusterId,
    publicId: accumulator.publicId,
    previousLastDetectionAtIso: previous === null ? null : isoFromEpochMs(previous),
    lastDetectionAtIso: isoFromEpochMs(accumulator.lastDetectionAt),
    gapMs: previous === null ? 0 : Math.max(0, accumulator.lastDetectionAt - previous),
    attachedCount: accumulator.attachedCount,
    fineAttached: accumulator.fineAttached,
  };
}

function toWorking(cluster: Cluster): WorkingCluster {
  return {
    id: cluster.id,
    publicId: cluster.publicId,
    seedDetectionUid: cluster.seedDetectionUid,
    mintedAt: cluster.mintedAt,
    startedAt: cluster.startedAt,
    lastDetectionAt: cluster.lastDetectionAt,
    members: [...cluster.members],
    configVersion: cluster.configVersion,
    sourceRegistryVersion: cluster.sourceRegistryVersion,
  };
}

function freezeCluster(cluster: WorkingCluster): Cluster {
  return {
    id: cluster.id,
    publicId: cluster.publicId,
    seedDetectionUid: cluster.seedDetectionUid,
    mintedAt: cluster.mintedAt,
    startedAt: cluster.startedAt,
    lastDetectionAt: cluster.lastDetectionAt,
    members: orderMembers(cluster.members),
    configVersion: cluster.configVersion,
    sourceRegistryVersion: cluster.sourceRegistryVersion,
  };
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareAssignments(a: Assignment, b: Assignment): number {
  const byTime = compareAscii(a.acqTsIso, b.acqTsIso);
  if (byTime !== 0) return byTime;
  return compareAscii(a.detectionUid, b.detectionUid);
}

function compareMerges(a: ClusterMerge, b: ClusterMerge): number {
  if (a.survivorClusterId !== b.survivorClusterId) {
    return a.survivorClusterId - b.survivorClusterId;
  }
  return compareAscii(a.bridgedByDetectionUid, b.bridgedByDetectionUid);
}
