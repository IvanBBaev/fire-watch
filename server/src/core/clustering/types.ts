/**
 * The vocabulary of the identity engine (ADR-002 D2).
 *
 * Everything here is a value: the working set, the batch outcome, and the records the
 * later D-track tasks consume. There is no store, no transaction and no SQL — a batch is
 * `(detections, state, config) → (state, outcome)`, which is what lets the golden replay
 * run the same code the live path runs.
 *
 * The outcome is deliberately split into *what happened* (seeded / attached / merged /
 * unattached) rather than a diff someone has to reconstruct: D2 needs the merges, D3
 * needs the seeds, D4 needs which events were touched and by how big a gap, and the
 * persistence adapter needs the assignments. Handing each of them a derived list beats
 * each of them re-deriving it from two snapshots and disagreeing.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { VersionedConfig } from '../config/versioned-config.js';
import type { OrderableDetection } from '../determinism/batch-order.js';
import type { EpochMs } from '../ports/clock.js';
import type { ClusteringParams } from './clustering-params.js';
import type { Coordinate } from './geometry.js';

/**
 * A detection as the clustering engine needs it. Narrower than `DetectionRecord`: the
 * engine reads position, time, source and footprint, and nothing else. Brightness,
 * confidence and FRP are scoring inputs (ADR-004) and are deliberately absent, so that no
 * future edit can make *identity* depend on a judgement call.
 */
export interface ClusteringDetection extends OrderableDetection {
  readonly detectionUid: string;
  readonly source: SourceId;
  /** When we could first have seen the row — the batch ordering key. */
  readonly availableAt: EpochMs;
  /** `YYYY-MM-DDTHH:MM:00Z`, exactly as hashed into the uid (GLOSSARY §1b). */
  readonly acqTsIso: string;
  readonly latCanonical: string;
  readonly lonCanonical: string;
  /** Pixel footprint, or `null` where the provider sent none (Appendix A rule 4). */
  readonly scanKm: number | null;
  readonly trackKm: number | null;
}

/** A detection that has joined a cluster, with the derived values the engine reuses. */
export interface ClusterMember {
  readonly detectionUid: string;
  readonly source: SourceId;
  readonly acqTsIso: string;
  /** `acqTsIso` as epoch ms — the frame T_LINK and the reignition windows are measured in. */
  readonly acqTs: EpochMs;
  readonly latCanonical: string;
  readonly lonCanonical: string;
  /** The parsed position. Derived once, so no comparison re-parses text mid-loop. */
  readonly coordinate: Coordinate;
  /** The ε this row was admitted at — provenance for "why is this detection here". */
  readonly epsKm: number;
  readonly footprintDefaulted: boolean;
}

/**
 * A cluster in the working set. Its FireEvent is the same thing under another name: a
 * cluster becomes an event immediately on creation and the registry mirrors the working
 * set 1:1 (D2 "Promotion"), so `publicId` lives here rather than in a parallel structure
 * that could disagree.
 *
 * Only facts are stored. Centroid, detection count and source mix are derived by function
 * (`aggregates.ts`) so that a stale cached aggregate cannot exist.
 */
export interface Cluster {
  /**
   * The internal id. Monotonic from 1, assigned in creation order, and the last word in
   * every tie-break (Appendix A rules 1 and 2). Never shown to a user — that is
   * `publicId` — and never reused, including by a cluster that was absorbed by a merge.
   */
  readonly id: number;
  readonly publicId: string;
  /** The detection the cluster was created by; the frozen seed of the public id. */
  readonly seedDetectionUid: string;
  /** When the id was minted (clock port). Its UTC year is the cosmetic `fw-YYYY`. */
  readonly mintedAt: EpochMs;
  /** Earliest and latest `acq_ts` over the members. */
  readonly startedAt: EpochMs;
  readonly lastDetectionAt: EpochMs;
  /** Members in the canonical batch order, oldest batch first. */
  readonly members: readonly ClusterMember[];
  /** The parameter set this event was created under; stamped once, never re-stamped. */
  readonly configVersion: string;
  readonly sourceRegistryVersion: string;
}

/**
 * The engine's whole state between batches.
 *
 * `takenPublicIds` covers *every* id ever minted, not just the working set: an id belongs
 * to its event forever (I1), including after the event is archived or becomes a merge
 * tombstone, so minting must probe against all of them. The set is a few thousand strings
 * per season; the UNIQUE index on `fire_events.public_id` is the backstop if a caller
 * ever loads a partial one.
 */
export interface ClusteringState {
  /** Working-set clusters, ordered by `id` ascending. */
  readonly clusters: readonly Cluster[];
  readonly nextClusterId: number;
  readonly takenPublicIds: readonly string[];
}

export interface ClusterBatchInput {
  readonly detections: readonly ClusteringDetection[];
  readonly state: ClusteringState;
  /**
   * The batch instant, from the Clock port. Used for two things only: the trailing 72 h
   * active window, and the cosmetic mint year. Never for the temporal gap — that is
   * measured between acquisitions.
   */
  readonly now: EpochMs;
  /**
   * Required rather than defaulted: an event row records the parameter version it was
   * clustered under, and a caller that never said which version it wanted would be
   * recording a default nobody chose.
   */
  readonly config: ClusteringConfig;
}

/** The versioned parameter set, as `versioned-config.ts` shapes it. */
export type ClusteringConfig = VersionedConfig<ClusteringParams>;

/** How a detection ended up where it did — one row of `event_detections`, plus why. */
export interface Assignment {
  readonly detectionUid: string;
  readonly acqTsIso: string;
  readonly clusterId: number;
  readonly publicId: string;
  readonly kind: 'seed' | 'attach';
  readonly epsKm: number;
  readonly footprintDefaulted: boolean;
  /**
   * Distance to the cluster it joined, in integer multiples of `metric.quantumKm`
   * (1 mm). An integer rather than a float because this value is compared byte for byte
   * in `expected.json`, and a float would carry the last bits of a square root into a
   * checked-in fixture. Zero for a seed.
   */
  readonly distanceQuanta: number;
}

/** A cluster created in this batch. The seam D3 reads to look for a reignition parent. */
export interface SeededCluster {
  readonly clusterId: number;
  readonly publicId: string;
  readonly seedDetectionUid: string;
  readonly source: SourceId;
  readonly startedAtIso: string;
  readonly coordinate: Coordinate;
  /** ε of the seeding detection — the radius D3's `2·ε` reignition test is built on. */
  readonly epsKm: number;
}

/**
 * Two or more clusters were bridged by one fine detection (D2 "N candidates").
 *
 * The engine performs the *structural* union, because the rest of the batch has to see a
 * consistent working set — a second detection arriving 200 m later must not find the two
 * halves still separate. What it does not do is the registry side of D3 merge semantics:
 * tombstones, alias chains, aggregate re-attribution, `migrateAlertState` and the
 * `event.merged` broadcast. Those consume this record.
 */
export interface ClusterMerge {
  readonly survivorClusterId: number;
  readonly survivorPublicId: string;
  /** Ascending by cluster id. Their public ids become aliases of the survivor's. */
  readonly absorbedClusterIds: readonly number[];
  readonly absorbedPublicIds: readonly string[];
  readonly bridgedByDetectionUid: string;
}

/**
 * An existing cluster that received detections in this batch. The seam D4 reads: the
 * lifecycle transitions are all functions of "how long since the last detection, and was
 * the new one from a fine source" (`officially_*` → `active` requires a fine re-detection
 * within T_LINK, A2.2).
 */
export interface TouchedCluster {
  readonly clusterId: number;
  readonly publicId: string;
  /** `null` when the cluster was seeded in this batch — there is no previous detection. */
  readonly previousLastDetectionAtIso: string | null;
  readonly lastDetectionAtIso: string;
  /**
   * Gap between the previous last detection and the newest one added, in ms. `0` for a
   * cluster seeded in this batch, and `0` for an attachment that lands inside the span the
   * cluster already covered.
   */
  readonly gapMs: number;
  /** Detections added to this cluster in this batch, counting the seed. */
  readonly attachedCount: number;
  /** At least one of the attached detections came from a non-attach-only source. */
  readonly fineAttached: boolean;
}

/**
 * A detection that joined nothing. Today there is exactly one reason: a coarse row with
 * no candidate cluster, which is the whole content of "attach-only" (A1.5 — a GEO-only
 * event cannot exist). The row stays in the archive and on the map; it simply is not
 * evidence of an event on its own.
 */
export interface UnattachedDetection {
  readonly detectionUid: string;
  readonly source: SourceId;
  readonly reason: 'coarse_no_candidate';
}

export interface BatchStats {
  readonly detections: number;
  readonly seeded: number;
  readonly attached: number;
  readonly merged: number;
  readonly unattached: number;
  /**
   * Detections skipped because they are already members of a cluster in the working set.
   * A poll overlaps the previous one by design (`day_range=2`), so re-delivery is the
   * normal case, not an error — but it must not create a second event out of a row that
   * already has one.
   */
  readonly alreadyAssigned: number;
  /** Appendix A rule 4 requires this to be counted per batch, not merely flagged per row. */
  readonly footprintDefaulted: number;
  readonly evicted: number;
}

export interface ClusterBatchResult {
  readonly state: ClusteringState;
  readonly assignments: readonly Assignment[];
  readonly seeded: readonly SeededCluster[];
  readonly merges: readonly ClusterMerge[];
  readonly touched: readonly TouchedCluster[];
  readonly unattached: readonly UnattachedDetection[];
  /** Clusters that left the working set at the start of this batch, ascending by id. */
  readonly evictedClusterIds: readonly number[];
  readonly stats: BatchStats;
  /** Provenance stamped onto every row this batch produced. */
  readonly configVersion: string;
  readonly configDigest: string;
  readonly sourceRegistryVersion: string;
}
