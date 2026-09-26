/**
 * The per-batch pieces the golden replay and the live identity pipeline share.
 *
 * `replay/identity-engine.ts` has driven `clusterBatch`, the merge plan, the reignition
 * plan and the lifecycle tick since D5, with its working set in memory. The live pipeline
 * (`identity-cycle.ts`) drives the same four functions with its working set in Postgres.
 * The glue between them — how a cluster is read by the tick, how it is offered as a
 * reignition parent, how a stored row becomes a `Cluster` again — lives here, once, and
 * both callers import it. That is the whole point of the file: the day the replay and the
 * poller compute "the event's newest member" or "a candidate's start" two different ways,
 * CI-1 goes on proving the replay while production runs something else.
 *
 * Nothing here touches a store or a clock. Every function is a value in, a value out.
 */

import { clusterCentroid, orderMembers } from '../clustering/aggregates.js';
import type { ClusteringParams } from '../clustering/clustering-params.js';
import { epsKmFor } from '../clustering/eps.js';
import { formatCanonicalDegrees, parseCanonicalDegrees } from '../clustering/geometry.js';
import type {
  Cluster,
  ClusterBatchResult,
  ClusterMember,
  ClusteringState,
} from '../clustering/types.js';
import type { OfficialDeclaration } from '../lifecycle/types.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type {
  RegistryWrites,
  SeededEvent,
  StoredCluster,
  StoredMember,
  StoredWorkingSet,
} from '../ports/clustering-store.js';
import type { ReignitionCandidateEvent } from '../ports/reignition-reader.js';
import type { AlertStateKey, AlertStateRow } from '../registry/alert-state.js';
import { resolveAlias, type AliasLinks } from '../registry/alias-registry.js';
import { buildMergePlan, survivorUpdate, type SurvivorUpdate } from '../registry/merge-plan.js';
import { buildReignitionPlan } from '../registry/reignition-plan.js';
import type { TickEventInput } from '../replay/lifecycle-tick.js';

/**
 * What the tick needs to know about a member beyond what a `ClusterMember` carries.
 *
 * A `ClusterMember` has no FRP and no curated statement on purpose — identity must not
 * depend on either (ADR-002 D6) — so each caller answers these from wherever it keeps the
 * full row: the replay from the fixture rows it saw go past, the live pipeline from the
 * `detections` rows it read back.
 */
export interface MemberObservations {
  frpMw(detectionUid: string): number | null;
  declarations(detectionUid: string): readonly OfficialDeclaration[];
}

/** The part of a cluster the tick reads. A `Cluster` is one; so is a stored event. */
export interface TickSubject {
  readonly publicId: string;
  readonly members: readonly ClusterMember[];
  readonly lastDetectionAt: EpochMs;
}

/**
 * One event as the lifecycle tick reads it.
 *
 * The newest member decides `lastDetectionSource` and `lastFrpMw`, and it is taken from
 * `orderMembers` rather than from insertion order so the answer is a property of the
 * detections rather than of the order polls happened to deliver them in.
 *
 * Declarations are resolved by membership, which is also what carries them through a
 * merge: a merge re-attributes the loser's detections to the survivor, so a statement
 * naming one of those detections follows it to whichever event holds it now. No alias
 * chain has to be walked here because the detection already walked it.
 */
export function tickEventFor(subject: TickSubject, observed: MemberObservations): TickEventInput {
  const members = orderMembers(subject.members);
  const newest = members.at(-1);
  if (newest === undefined) {
    throw new Error(
      `cluster ${subject.publicId} has no members; a cluster is created from a detection ` +
        'and never emptied, so this is a clustering bug rather than a data problem',
    );
  }

  let maxFrpMw: number | null = null;
  const declarations: OfficialDeclaration[] = [];
  for (const member of members) {
    const frpMw = observed.frpMw(member.detectionUid);
    if (frpMw !== null && (maxFrpMw === null || frpMw > maxFrpMw)) maxFrpMw = frpMw;
    for (const declaration of observed.declarations(member.detectionUid)) {
      declarations.push(declaration);
    }
  }

  return {
    publicId: subject.publicId,
    // Over the members in the subject's own order, exactly as `clusterCentroid` always
    // was: the centroid is a floating-point sum and the replay artifacts are byte-compared.
    centroid: clusterCentroid(subject),
    lastDetectionAtMs: subject.lastDetectionAt,
    lastDetectionSource: newest.source,
    lastFrpMw: observed.frpMw(newest.detectionUid),
    maxFrpMw,
    declarations,
  };
}

/**
 * An event as the reignition rule reads it back. `fuelBand: null` is not a stand-in: no
 * land-cover classifier exists, and rule 5 makes `null` mean the 14-day middle window.
 */
export function reignitionCandidateFor(cluster: Cluster): ReignitionCandidateEvent {
  return {
    clusterId: cluster.id,
    publicId: cluster.publicId,
    centroid: clusterCentroid(cluster),
    startedAt: cluster.startedAt,
    lastDetectionAt: cluster.lastDetectionAt,
    fuelBand: null,
  };
}

/**
 * A stored member as the engine holds it. ε and the parsed coordinate are re-derived by
 * the same two functions `clusterBatch` used when the member joined, so a member read back
 * is the member that was written — under the same parameter set, which `liveRun` guards.
 */
export function memberFromStored(stored: StoredMember, params: ClusteringParams): ClusterMember {
  const source = stored.source;
  const eps = epsKmFor(source, { scanKm: stored.scanKm, trackKm: stored.trackKm }, params);
  return {
    detectionUid: stored.detectionUid,
    source,
    acqTsIso: stored.acqTsIso,
    acqTs: epochMsFromIso(stored.acqTsIso),
    latCanonical: stored.latCanonical,
    lonCanonical: stored.lonCanonical,
    coordinate: {
      lat: parseCanonicalDegrees(stored.latCanonical, 'latitude'),
      lon: parseCanonicalDegrees(stored.lonCanonical, 'longitude'),
    },
    epsKm: eps.km,
    footprintDefaulted: eps.footprintDefaulted,
  };
}

/**
 * Members in canonical order (`orderMembers`), whatever order the store returned.
 *
 * The replay keeps members in arrival order because it never forgets them; a store has no
 * arrival order to give back, so the canonical one is the only order that is the same on
 * every read. It moves the last bits of a centroid relative to an uninterrupted in-memory
 * run and nothing else — every other aggregate is order-free.
 */
export function membersFromStored(
  stored: readonly StoredMember[],
  params: ClusteringParams,
): ClusterMember[] {
  return orderMembers(stored.map((member) => memberFromStored(member, params)));
}

/**
 * A `clusters` row back as the engine's `Cluster`. `startedAt` and `lastDetectionAt` are
 * min/max of the members' acquisitions, which is exactly how the engine maintains them —
 * a seed sets both to its own acquisition and every attach or merge widens them.
 */
export function clusterFromStored(stored: StoredCluster, params: ClusteringParams): Cluster {
  const members = membersFromStored(stored.members, params);
  const first = members[0];
  const last = members.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error(
      `stored cluster ${stored.publicId} (id ${String(stored.id)}) has no members; the ` +
        'working set holds only clusters created from a detection, so the store returned ' +
        'a row whose event_detections it could not find',
    );
  }
  return {
    id: stored.id,
    publicId: stored.publicId,
    seedDetectionUid: stored.seedDetectionUid,
    mintedAt: stored.mintedAt,
    startedAt: first.acqTs,
    lastDetectionAt: members.reduce((max, member) => Math.max(max, member.acqTs), first.acqTs),
    members,
    configVersion: stored.configVersion,
    sourceRegistryVersion: stored.sourceRegistryVersion,
  };
}

export function stateFromStored(set: StoredWorkingSet, params: ClusteringParams): ClusteringState {
  const clusters = set.clusters
    .map((cluster) => clusterFromStored(cluster, params))
    .sort((a, b) => a.id - b.id);
  const top = clusters.at(-1);
  if (top !== undefined && set.nextClusterId <= top.id) {
    // The engine hands out `nextClusterId` to the first seed. Equal to a live id, it would
    // mint a second cluster under an id the tie-breaks already rank, and every "lowest id
    // wins" decision after that is decided by which of the two the loop saw first.
    throw new RangeError(
      `nextClusterId ${String(set.nextClusterId)} does not exceed working-set id ${String(top.id)}`,
    );
  }
  return {
    clusters,
    nextClusterId: set.nextClusterId,
    takenPublicIds: [...set.takenPublicIds].sort(compareAscii),
  };
}

export interface RegistryPlanInput {
  readonly result: ClusterBatchResult;
  /** The alias table before the batch. */
  readonly aliases: AliasLinks;
  /** Reignition candidates, read in the batch transaction before anything was written. */
  readonly candidates: readonly ReignitionCandidateEvent[];
  /** `alert_states` for every event involved, as they stood before the batch. */
  readonly alertStates: readonly AlertStateRow[];
  readonly params: ClusteringParams;
  /** The engine batch instant (`clusterBatch`'s `now`): every seed's minting instant. */
  readonly batchAtMs: EpochMs;
}

/**
 * Every registry write a clustered batch implies, as one value.
 *
 * The order is the one the replay has always used, and the reason for it has not changed:
 * the merge plan first, and the reignition plan on the table it produced, because a
 * candidate this batch absorbed has to be named by the id that is live once the batch
 * commits. The reignition plan also reads `alert_states` *after* the merge migration (its
 * input contract says so); the migration is applied here in memory so the plan can be
 * built before a single row is written, and the two legs are then collapsed into one net
 * delete set and one net upsert set.
 */
export function planRegistryWrites(input: RegistryPlanInput): RegistryWrites {
  const { result, params } = input;
  const merge = buildMergePlan({
    merges: result.merges,
    clusters: result.state.clusters,
    aliases: input.aliases,
    alertStates: input.alertStates,
    params,
  });

  const rows = new Map(input.alertStates.map((row) => [keyOf(row), row]));
  for (const key of merge.alertStates.deletes) rows.delete(keyOf(key));
  for (const row of merge.alertStates.upserts) rows.set(keyOf(row), row);

  const reignition = buildReignitionPlan({
    seeded: result.seeded,
    candidates: input.candidates,
    clusters: result.state.clusters,
    aliases: merge.aliases,
    alertStates: [...rows.values()],
    params,
  });

  const upserts = new Map<string, AlertStateRow>();
  for (const row of [...merge.alertStates.upserts, ...reignition.alertStateUpserts]) {
    // Last write wins, which is the order the two legs would have hit the table in.
    upserts.set(keyOf(row), row);
  }
  const deletes = merge.alertStates.deletes.filter((key) => !upserts.has(keyOf(key)));

  const aggregates = changedAggregates(result, params);
  return {
    seededEvents: seededEvents(result, aggregates, input.batchAtMs),
    merge,
    reignitionLinks: reignition.links,
    alertStates: {
      upserts: [...upserts.values()].sort(byEventThenZone),
      deletes: [...deletes].sort(byEventThenZone),
    },
    aggregates,
  };
}

/**
 * The `fire_events` row each seed is minted with, in ascending engine cluster id — the
 * order `applyBatch` must insert the working-set rows in. A live seed starts from its
 * post-batch aggregates (so the insert and the aggregate update agree); an absorbed one
 * from {@link absorbedSeedAggregates}.
 */
function seededEvents(
  result: ClusterBatchResult,
  aggregates: readonly SurvivorUpdate[],
  batchAtMs: EpochMs,
): readonly SeededEvent[] {
  const live = new Map(aggregates.map((update) => [update.clusterId, update]));
  return [...result.seeded]
    .sort((a, b) => a.clusterId - b.clusterId)
    .map((seed) => {
      const update = live.get(seed.clusterId);
      return {
        initial: update ?? absorbedSeedAggregates(seed),
        absorbed: update === undefined,
        seedDetectionUid: seed.seedDetectionUid,
        // Every seed of a batch is minted at the batch instant (`engine.ts`, `mintedAt: now`),
        // including one absorbed before the batch ended and so no longer in the state.
        mintedAt: batchAtMs,
        configVersion: result.configVersion,
        sourceRegistryVersion: result.sourceRegistryVersion,
      };
    });
}

/**
 * The projection of every event whose member set this batch changed and which is still
 * in the working set afterwards: seeds, attach targets and merge survivors. An absorbed
 * cluster is not here — its row becomes a tombstone and keeps the aggregates it had.
 */
function changedAggregates(
  result: ClusterBatchResult,
  params: ClusteringParams,
): readonly SurvivorUpdate[] {
  const changed = new Set<number>([
    ...result.seeded.map((seed) => seed.clusterId),
    ...result.touched.map((touch) => touch.clusterId),
    ...result.merges.map((merge) => merge.survivorClusterId),
  ]);
  return result.state.clusters
    .filter((cluster) => changed.has(cluster.id))
    .map((cluster) => survivorUpdate(cluster, params));
}

/**
 * The event row a seed absorbed within its own batch is minted with.
 *
 * Such a seed was a public id for a few loop iterations, and I1 says a public id resolves
 * forever — so it gets a `fire_events` row that is born a tombstone. Its aggregates are
 * the one thing that was ever true of it: the seed detection, alone. Nothing projects them
 * (a tombstone is a redirect), but the columns are NOT NULL and a copy of the survivor's
 * values would claim the tombstone once held detections it never did.
 */
export function absorbedSeedAggregates(seed: ClusterBatchResult['seeded'][number]): SurvivorUpdate {
  return {
    publicId: seed.publicId,
    clusterId: seed.clusterId,
    startedAtIso: seed.startedAtIso,
    lastDetectionAtIso: seed.startedAtIso,
    detectionCount: 1,
    sourceMix: { [seed.source]: 1 },
    centroidLatCanonical: formatCanonicalDegrees(seed.coordinate.lat),
    centroidLonCanonical: formatCanonicalDegrees(seed.coordinate.lon),
    hull: [],
    hullDiameterQuanta: 0,
    needsReview: false,
  };
}

/**
 * Every event whose `alert_states` rows the batch's two plans could read.
 *
 * Deliberately generous — seeds, both sides of every merge, every reignition candidate,
 * and each of those resolved through the alias table the batch will commit — because both
 * plans ignore rows for uninvolved events, and a set that is one id short silently loses a
 * zone's alert history in a merge. Sorted so the read is the same on every run.
 */
export function involvedPublicIds(
  result: ClusterBatchResult,
  aliases: AliasLinks,
  candidates: readonly ReignitionCandidateEvent[],
  params: ClusteringParams,
): readonly string[] {
  const after = buildMergePlan({
    merges: result.merges,
    clusters: result.state.clusters,
    aliases,
    alertStates: [],
    params,
  }).aliases;
  const ids = new Set<string>();
  const add = (publicId: string): void => {
    ids.add(publicId);
    ids.add(resolveAlias(after, publicId).canonical);
  };
  for (const seed of result.seeded) add(seed.publicId);
  for (const merge of result.merges) {
    add(merge.survivorPublicId);
    for (const absorbed of merge.absorbedPublicIds) add(absorbed);
  }
  for (const candidate of candidates) add(candidate.publicId);
  return [...ids].sort(compareAscii);
}

/** The public id an assignment's detection belongs to once the batch commits. */
export function canonicalPublicId(aliases: AliasLinks, publicId: string): string {
  return resolveAlias(aliases, publicId).canonical;
}

function keyOf(key: AlertStateKey): string {
  return `${key.zoneId}\u0000${key.eventPublicId}`;
}

function byEventThenZone(a: AlertStateKey, b: AlertStateKey): number {
  if (a.eventPublicId !== b.eventPublicId) return compareAscii(a.eventPublicId, b.eventPublicId);
  return compareAscii(a.zoneId, b.zoneId);
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
