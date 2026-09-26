/**
 * The registry half of a merge, as a value (ADR-002 D3, invariants I1–I3).
 *
 * The engine (`core/clustering/engine.ts`) performs the *structural* union inside a batch,
 * because the rest of that batch has to see one cluster where there were two. It stops
 * there, and everything downstream of "these two clusters are now one" — tombstones, alias
 * compression, aggregate recomputation, detection re-attribution, alert-state migration —
 * is computed here and applied by the storage adapter in a single transaction.
 *
 * A plan rather than a set of calls, for one reason: I3 says the whole merge is atomic, and
 * the cheapest way to keep a rule like that is to make the alternative impossible to
 * express. There is no `applyMerge(db, ...)` that a caller could invoke without the alert
 * migration, or with it in a second transaction; there is one pure function producing one
 * value, and an adapter whose only job is to write all of it or none of it. It also makes
 * the interesting half testable without a database, which is why the I2 and I3 property
 * tests can run in the unit project.
 *
 * The plan is deliberately over-specified — it names the survivor's recomputed aggregates
 * even though the adapter could derive them, and the alias rewrites even though a
 * maintenance job could compress later. Both are re-derivations, and a re-derivation is a
 * second implementation of a rule that has to agree with the first one forever.
 */

import {
  clusterCentroid,
  clusterHull,
  clusterDiameterKm,
  sourceMix,
} from '../clustering/aggregates.js';
import type { ClusteringParams } from '../clustering/clustering-params.js';
import { formatCanonicalDegrees, quantizeKm } from '../clustering/geometry.js';
import { exceedsReviewDiameter } from '../clustering/hull.js';
import type { Cluster, ClusterMerge } from '../clustering/types.js';
import { isoFromEpochMs } from '../ports/clock.js';
import {
  compressAll,
  diffRewrites,
  linkTombstone,
  resolveAlias,
  type AliasLinks,
  type AliasRewrite,
} from './alias-registry.js';
import { foldAlertStates, type AlertStateKey, type AlertStateRow } from './alert-state.js';

/** A loser row: kept forever, pointing at the survivor, never deleted (I1). */
export interface MergeTombstone {
  readonly publicId: string;
  /** Already flat — chains are compressed before the plan is emitted, not after. */
  readonly mergedIntoPublicId: string;
  /** The detection that bridged the two clusters. Provenance for "why did this merge". */
  readonly bridgedByDetectionUid: string;
}

/**
 * `event_detections` rows move from the loser to the survivor. An UPDATE of
 * `fire_event_id`, not a copy: a detection belongs to exactly one event, so the primary key
 * `(clustering_run_id, fire_event_id, detection_uid)` cannot collide on the way over.
 */
export interface DetectionReattribution {
  readonly fromPublicId: string;
  readonly toPublicId: string;
}

/** A hull vertex on the canonical 5 dp grid, in the order `hull.ts` returns them. */
export interface HullVertex {
  readonly latCanonical: string;
  readonly lonCanonical: string;
}

/**
 * The survivor's aggregates, recomputed from the union of the members.
 *
 * Recomputed rather than combined: `max(hullA, hullB)` is not the hull of the union, and
 * the number that decides `needs_review` is exactly the one a merge can move the most.
 */
export interface SurvivorUpdate {
  readonly publicId: string;
  readonly clusterId: number;
  readonly startedAtIso: string;
  readonly lastDetectionAtIso: string;
  readonly detectionCount: number;
  readonly sourceMix: Readonly<Record<string, number>>;
  readonly centroidLatCanonical: string;
  readonly centroidLonCanonical: string;
  /**
   * Hull vertices, open (the first vertex is not repeated at the end). Fewer than three
   * means the event is a point or a segment and has no polygon — the adapter stores NULL in
   * `fire_events.hull` there, which is why the column is nullable. The diameter and the
   * review flag stay meaningful in that case; they are what D4 actually reads.
   */
  readonly hull: readonly HullVertex[];
  /**
   * Diameter in integer quanta (1 mm), like `Assignment.distanceQuanta`. An integer because
   * this value is compared byte for byte in a replay artifact, and a float would carry the
   * last bits of a square root into a checked-in fixture.
   */
  readonly hullDiameterQuanta: number;
  readonly needsReview: boolean;
}

/** What the transaction does to `alert_states`: move the parents' rows onto the survivor. */
export interface AlertStateMigration {
  readonly upserts: readonly AlertStateRow[];
  readonly deletes: readonly AlertStateKey[];
}

export interface MergePlan {
  readonly tombstones: readonly MergeTombstone[];
  /** The alias table after the merge, already flat. */
  readonly aliases: AliasLinks;
  /** Existing tombstones whose `merged_into` shortened. Inserts are in `tombstones`. */
  readonly aliasRewrites: readonly AliasRewrite[];
  readonly detectionReattributions: readonly DetectionReattribution[];
  readonly survivors: readonly SurvivorUpdate[];
  readonly alertStates: AlertStateMigration;
}

export interface MergePlanInput {
  /** `ClusterBatchResult.merges`, in the order the engine emitted them. */
  readonly merges: readonly ClusterMerge[];
  /** The post-batch working set. Every survivor must be findable here. */
  readonly clusters: readonly Cluster[];
  /** The alias table as it stands before this batch; `NO_ALIASES` for a fresh one. */
  readonly aliases: AliasLinks;
  /**
   * `alert_states` rows for every event involved, loaded inside the transaction. Rows for
   * uninvolved events are ignored rather than rejected: the adapter is allowed to load a
   * generous set (all zones touching the merge area) without having to pre-filter it by an
   * alias table it would then be re-implementing.
   */
  readonly alertStates: readonly AlertStateRow[];
  readonly params: ClusteringParams;
}

/**
 * Turns a batch's merges into the transaction that makes them true in the registry.
 *
 * **Order-independent.** The engine sorts `merges` by survivor cluster id, not by when they
 * happened, so a merge whose survivor is itself absorbed by another merge in the same batch
 * can appear either way round. Both orders produce the same table, because every link is
 * written against the *resolved* survivor and the whole table is compressed at the end —
 * which is I2 doing its job at the only point where the order is ambiguous.
 */
export function buildMergePlan(input: MergePlanInput): MergePlan {
  if (input.merges.length === 0) {
    return {
      tombstones: [],
      aliases: input.aliases,
      aliasRewrites: [],
      detectionReattributions: [],
      survivors: [],
      alertStates: { upserts: [], deletes: [] },
    };
  }

  let links = input.aliases;
  const bridgedBy = new Map<string, string>();
  for (const merge of input.merges) {
    const survivor = resolveAlias(links, merge.survivorPublicId).canonical;
    for (const absorbed of merge.absorbedPublicIds) {
      links = linkTombstone(links, absorbed, survivor).links;
      bridgedBy.set(absorbed, merge.bridgedByDetectionUid);
    }
  }

  const aliases = compressAll(links);
  const tombstones: MergeTombstone[] = [...bridgedBy.keys()].sort().map((publicId) => ({
    publicId,
    mergedIntoPublicId: aliases.get(publicId) as string,
    bridgedByDetectionUid: bridgedBy.get(publicId) as string,
  }));

  const survivorIds = [
    ...new Set(tombstones.map((tombstone) => tombstone.mergedIntoPublicId)),
  ].sort();

  const byPublicId = new Map(input.clusters.map((cluster) => [cluster.publicId, cluster]));
  const survivors = survivorIds.map((publicId) => {
    const cluster = byPublicId.get(publicId);
    if (cluster === undefined) {
      // The working set is where a live event lives. A survivor missing from it means the
      // merges and the state passed here came from different batches, and any plan built on
      // that pairing would re-attribute detections onto an event that no longer exists.
      throw new RangeError(`merge survivor ${publicId} is not in the working set`);
    }
    return survivorUpdate(cluster, input.params);
  });

  const parentsBySurvivor = new Map<string, string[]>(survivorIds.map((id) => [id, []]));
  for (const tombstone of tombstones) {
    parentsBySurvivor.get(tombstone.mergedIntoPublicId)?.push(tombstone.publicId);
  }

  const upserts: AlertStateRow[] = [];
  const deletes: AlertStateKey[] = [];
  for (const survivorId of survivorIds) {
    const parents = parentsBySurvivor.get(survivorId) ?? [];
    const family = new Set([survivorId, ...parents]);
    const rows = input.alertStates.filter((row) => family.has(row.eventPublicId));
    upserts.push(...foldAlertStates(rows, survivorId, parents));
    for (const row of rows) {
      if (row.eventPublicId !== survivorId) {
        deletes.push({ zoneId: row.zoneId, eventPublicId: row.eventPublicId });
      }
    }
  }
  deletes.sort(byEventThenZone);

  return {
    tombstones,
    aliases,
    aliasRewrites: diffRewrites(input.aliases, aliases),
    detectionReattributions: tombstones.map((tombstone) => ({
      fromPublicId: tombstone.publicId,
      toPublicId: tombstone.mergedIntoPublicId,
    })),
    survivors,
    alertStates: { upserts, deletes },
  };
}

/**
 * One event's projected aggregates, from its members. Exported because it is also the
 * definition the live identity pipeline writes for every event a batch touched, not only
 * for merge survivors — two functions computing "an event's centroid and hull" would be
 * two answers the snapshot could serve on alternate polls.
 */
export function survivorUpdate(cluster: Cluster, params: ClusteringParams): SurvivorUpdate {
  const centroid = clusterCentroid(cluster);
  const diameterKm = clusterDiameterKm(cluster, params.metric);
  return {
    publicId: cluster.publicId,
    clusterId: cluster.id,
    startedAtIso: isoFromEpochMs(cluster.startedAt),
    lastDetectionAtIso: isoFromEpochMs(cluster.lastDetectionAt),
    detectionCount: cluster.members.length,
    sourceMix: sourceMix(cluster),
    centroidLatCanonical: formatCanonicalDegrees(centroid.lat),
    centroidLonCanonical: formatCanonicalDegrees(centroid.lon),
    hull: clusterHull(cluster).map((vertex) => ({
      latCanonical: formatCanonicalDegrees(vertex.lat),
      lonCanonical: formatCanonicalDegrees(vertex.lon),
    })),
    hullDiameterQuanta: quantizeKm(diameterKm, params.metric),
    needsReview: exceedsReviewDiameter(diameterKm, params),
  };
}

function byEventThenZone(a: AlertStateKey, b: AlertStateKey): number {
  if (a.eventPublicId !== b.eventPublicId) return a.eventPublicId < b.eventPublicId ? -1 : 1;
  return a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0;
}
