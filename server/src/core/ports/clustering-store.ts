/**
 * Persistence for the live identity pipeline (ADR-002 D1 layers 2 and 3, D4).
 *
 * The engine itself is a pure function — `(batch, state, config) → (state, outcome)` — so
 * that the golden replay runs the same code the live poller runs. Everything that touches
 * a table is on this side of the line, and the core never sees SQL, a transaction handle
 * or a connection.
 *
 * The working set (`clusters`) is layer 2: it has no public identity, it may be rebuilt
 * from `detections` at any time, and it is persisted only so the incremental state
 * survives a restart of the single writer. The registry (`fire_events`) is layer 3 and is
 * the opposite: a row there is permanent, its `public_id` resolves forever (I1), and a
 * merge tombstones it rather than deleting it.
 *
 * ## Why the port is shaped around two transactions rather than two calls
 *
 * The first version of this port was `loadWorkingSet` + `applyBatch`, each its own round
 * trip. That leaves a window between the read and the write in which a second writer —
 * a restarted worker whose predecessor has not quite died, an operator's one-shot CLI —
 * clusters the same batch from the same state and both commit. Each would mint the same
 * `public_id`s (minting is deterministic), and the second commit would fail on the unique
 * index halfway through a plan that I3 says is all-or-nothing. So the read and the write
 * of one batch are the same transaction here ({@link ClusteringStore.withBatch}), the
 * adapter serialises it on the run row, and a batch that is already in the ledger when
 * the lock is granted is skipped rather than re-applied. The lifecycle tick gets the same
 * treatment ({@link ClusteringStore.withTick}) for the same reason: a carry read by one
 * tick and written by another is an accumulator that counted one window twice.
 *
 * The callbacks receive a narrow transaction view instead of a client, which is what keeps
 * the core free of SQL while still letting it decide *what* to read in *which* order —
 * the reignition query, for one, can only be formed after the batch was clustered.
 */

import type { LifecycleState, SourceId } from '@fire-watch/contracts';

import type { ClusteringParams } from '../clustering/clustering-params.js';
import type { Coordinate } from '../clustering/geometry.js';
import type {
  ClusterBatchResult,
  ClusteringConfig,
  ClusteringDetection,
} from '../clustering/types.js';
import type { DisplayTier, GeoWeightSpent } from '../lifecycle/types.js';
import type { AlertStateKey, AlertStateRow } from '../registry/alert-state.js';
import type { AliasLinks } from '../registry/alias-registry.js';
import type { MergePlan, SurvivorUpdate } from '../registry/merge-plan.js';
import type { ReignitionLink } from '../registry/reignition-plan.js';
import type { ScoringDetection } from '../scoring/features.js';
import type { EpochMs } from './clock.js';
import type { EventStatusStore } from './event-status-store.js';
import type { ReignitionReader } from './reignition-reader.js';

/**
 * The run every assignment belongs to (`clustering_runs`).
 *
 * A run is what keeps an offline re-clustering — a D7 parameter refit, an SP month
 * promotion — from overwriting the live assignment before it is promoted and diffed. The
 * config version and digest are carried on the run rather than re-read at write time, so
 * a replay can prove it wrote under the parameters it claims.
 */
export interface ClusteringRun {
  readonly id: number;
  readonly kind: 'live' | 'offline';
  readonly configVersion: string;
  readonly configDigest: string;
  /**
   * The previous lifecycle tick's instant (`clustering_runs.lifecycle_ticked_at`), and so
   * the start of the next evidence window. `null` before the first tick.
   */
  readonly lifecycleTickedAtMs: EpochMs | null;
}

/**
 * One ingest batch: a single poll response for a single source, keyed exactly as
 * `ingest_batches` keys it. Its instant is also the engine's batch instant (`now`), which
 * is what makes a live cycle and a replay of the same archive the same computation — the
 * wall clock at which the worker happened to get round to the batch is not an input.
 */
export interface PendingBatch {
  readonly source: SourceId;
  readonly availableAt: EpochMs;
}

/**
 * One member of a persisted cluster, as the archive stores it: the `detections` row,
 * reached through `event_detections`. Raw on purpose — ε and the parsed coordinate are
 * re-derived in the core by the same functions the engine used when the member joined,
 * rather than stored and trusted.
 */
export interface StoredMember {
  readonly detectionUid: string;
  readonly source: SourceId;
  readonly acqTsIso: string;
  readonly latCanonical: string;
  readonly lonCanonical: string;
  readonly scanKm: number | null;
  readonly trackKm: number | null;
  readonly frpMw: number | null;
}

/**
 * A `clusters` row with its members. `startedAt` and `lastDetectionAt` are not here
 * because they are exactly min/max of the members' acquisitions — that is how the engine
 * maintains them — and a second copy is a second answer that could disagree.
 */
export interface StoredCluster {
  /** `clusters.id` — the engine's internal id, and the last word in the tie-breaks. */
  readonly id: number;
  readonly publicId: string;
  readonly seedDetectionUid: string;
  readonly mintedAt: EpochMs;
  readonly configVersion: string;
  readonly sourceRegistryVersion: string;
  readonly members: readonly StoredMember[];
}

export interface StoredWorkingSet {
  readonly clusters: readonly StoredCluster[];
  /** Strictly greater than every `clusters.id` the store has ever issued. */
  readonly nextClusterId: number;
  /** Every `public_id` in the registry, tombstones included: minting must avoid all of them. */
  readonly takenPublicIds: readonly string[];
}

/**
 * Everything the registry write of one batch consists of, as values.
 *
 * `merge` and `reignitionLinks` are the two plans verbatim. `alertStates` is their *net*
 * effect on `alert_states`: the merge migration applied first, the reignition inheritance
 * on top of it, deduplicated by key — so the adapter performs one delete set and one
 * upsert set and never has to know that two plans touched the same table.
 *
 * `aggregates` is the recomputed projection of every event whose member set this batch
 * changed and which is still live afterwards — seeds, attach targets, merge survivors —
 * built by the same `survivorUpdate` the merge plan uses, so there is one definition of
 * "an event's centroid, hull and counts" and not two.
 *
 * `seededEvents` is the `fire_events` row every seed of the batch is minted with. A seed
 * the same batch then absorbed is still here (`absorbed: true`): its public id existed,
 * so under I1 it must resolve forever, and the row is born a tombstone. Its aggregates are
 * the seed detection alone, which is the only thing that was ever true of it.
 */
export interface SeededEvent {
  /** Initial aggregates. For a live seed this is the same value as in `aggregates`. */
  readonly initial: SurvivorUpdate;
  readonly absorbed: boolean;
  readonly seedDetectionUid: string;
  readonly mintedAt: EpochMs;
  readonly configVersion: string;
  readonly sourceRegistryVersion: string;
}

export interface RegistryWrites {
  readonly seededEvents: readonly SeededEvent[];
  readonly merge: MergePlan;
  readonly reignitionLinks: readonly ReignitionLink[];
  readonly alertStates: {
    readonly upserts: readonly AlertStateRow[];
    readonly deletes: readonly AlertStateKey[];
  };
  readonly aggregates: readonly SurvivorUpdate[];
}

/** The key a detection is read back by for scoring: its partition column and its uid. */
export interface ScoringDetectionKey {
  readonly detectionUid: string;
  readonly acqTsIso: string;
}

/** One event's ADR-002 D6 score as the registry stores it (`eventScores`). */
export interface EventScore {
  readonly publicId: string;
  /** σ(z) quantised to `scoreQuantum`, or 0 when an override fired. In [0,1]. */
  readonly score: number;
  /** Set only by the §3.6 static-source override (D6); a rescore never clears it. */
  readonly invalidated: boolean;
  /** `score_params` version that produced `score` (`fire_events.score_params_version`). */
  readonly paramsVersion: string;
}

/** One batch, clustered and planned: the whole of what {@link BatchTransaction.applyBatch} writes. */
export interface BatchWrite {
  readonly batch: PendingBatch;
  readonly result: ClusterBatchResult;
  readonly writes: RegistryWrites;
  /**
   * The ADR-002 D6 score of every event in `writes.aggregates` — exactly one per aggregate,
   * in the same order (`eventScores`). Written in the same statement as the aggregates, so
   * a score is never out of step with the member set it was computed from, and the one
   * `seq` bump the member change draws covers the score change too.
   */
  readonly scores: readonly EventScore[];
}

/**
 * The reads and the one write of a single batch, inside one transaction.
 *
 * Also a {@link ReignitionReader}: the candidates must be read in the same snapshot as the
 * working set, or a candidate could be absorbed between the two reads and be offered as a
 * parent under a public id that is already a tombstone.
 */
export interface BatchTransaction extends ReignitionReader {
  /**
   * The batch's non-quarantined detections: exactly the rows the poll inserted, since a
   * row's `available_at` is the first poll that delivered it.
   */
  loadDetections(): Promise<readonly ClusteringDetection[]>;

  /**
   * The working set the batch continues from.
   *
   * @param activeSince clusters whose `last_detection_at` is at or after this instant.
   * Inclusive (Appendix A rule 3). The engine applies the same window itself, so a store
   * that returns a wider set is correct but slower; one that returns a narrower set
   * silently splits fires.
   */
  loadWorkingSet(activeSince: EpochMs): Promise<StoredWorkingSet>;

  /** The whole tombstone table, tombstone `public_id` → survivor `public_id`. */
  loadAliases(): Promise<AliasLinks>;

  /** Every `alert_states` row whose event is one of these `public_id`s. */
  loadAlertStates(publicIds: readonly string[]): Promise<readonly AlertStateRow[]>;

  /**
   * The scorer's view of these detections (`ScoringDetection`), one per key, in any order.
   *
   * Read after the batch was clustered, because only then is it known which events are
   * rescored and over which members (`scoringDetectionKeys`). Quarantined rows are never
   * members, so no filter is needed. `overOrAdjacentToWater` is `null`: no land-cover
   * layer is consulted, and the §3.6 guard keeps a detection nobody asked about. A key
   * with no row may be dropped — the core refuses to score an event whose member is
   * missing, so a short answer fails the batch rather than lowering a score.
   */
  loadScoringDetections(keys: readonly ScoringDetectionKey[]): Promise<readonly ScoringDetection[]>;

  /**
   * Persists one batch outcome and records the batch in the ledger, in this transaction.
   *
   * Everything below has to commit together, because each pair of them has a
   * half-applied state that is worse than either outcome:
   *
   *   * `event_detections` rows for {@link ClusterBatchResult.assignments} — a detection
   *     assigned to an event that was not written is a row pointing at nothing;
   *   * `clusters` and `fire_events` for {@link ClusterBatchResult.seeded} — the registry
   *     mirrors the working set 1:1 (D2 "Promotion"), so a cluster without its event is a
   *     fire nobody can be told about;
   *   * the whole merge plan — tombstones, alias rewrites, detection re-attributions and
   *     the alert-state migration (I3);
   *   * a `seq` bump on every event whose projection changed (ADR-003 A1.4) — migration
   *     004's trigger draws it for any projected column the write changes;
   *   * the ledger row, which is what makes the batch not pending any more. Written last
   *     and in the same commit, so a crash anywhere above leaves the batch pending and the
   *     next cycle redoes it from a state that never saw it.
   *
   * Newly seeded clusters are written in ascending engine cluster id, and the store must
   * preserve that relative order in whatever ids it assigns. The tie-breaks depend only on
   * the *order* of internal ids, never on their absolute values, so an adapter is free to
   * let the database allocate them — but not to allocate them in another order.
   *
   * The lifecycle columns are **not** this write's to invent beyond the initial `active`
   * of a new event: D4 owns every later transition, through {@link TickTransaction}.
   */
  applyBatch(write: BatchWrite): Promise<void>;
}

/**
 * One event as the lifecycle tick reads it back: the projection the tick decides from,
 * plus the carry the previous tick left on the row.
 */
export interface StoredTickEvent {
  readonly publicId: string;
  readonly status: LifecycleState;
  readonly displayTier: DisplayTier;
  readonly inactiveSinceMs: EpochMs | null;
  /** `fire_events.miss_evidence`: the carried E. */
  readonly missEvidence: number;
  readonly geoWeightSpent: GeoWeightSpent | null;
  /**
   * `fire_events.lifecycle_blind_since`: the UTC midnight the event's current run of
   * observation-free days started from, as the previous tick left it. `null` before the
   * event's first tick.
   */
  readonly blindSinceMs: EpochMs | null;
  /** `fire_events.lifecycle_seen_detection_at`; `null` before the event's first tick. */
  readonly seenDetectionAtMs: EpochMs | null;
  /** The event's members in the live run, as in {@link StoredMember}. Never empty. */
  readonly members: readonly StoredMember[];
}

/** The bookkeeping half of a tick's answer: written every tick, projected nowhere. */
export interface StoredCarry {
  readonly publicId: string;
  readonly missEvidence: number;
  readonly geoWeightSpent: GeoWeightSpent | null;
  readonly blindSinceMs: EpochMs | null;
  readonly seenDetectionAtMs: EpochMs | null;
}

export interface TickTransaction {
  /**
   * The run's `lifecycle_ticked_at`, read under the run lock. Not taken from the
   * {@link ClusteringRun} the cycle started with: another writer may have ticked since,
   * and a window that starts before its tick counts that stretch of passes twice.
   */
  readonly lastTickedAtMs: EpochMs | null;
  /**
   * Live (not merged, not invalidated) events of the run that the tick still has work on:
   * any event not yet `archived`, plus archived ones detected at or after `activeSince`.
   * An archived event older than that has no transition left — `archived` is the end of
   * the automatic lifecycle — and ticking it forever would make the tick's cost grow with
   * the age of the registry.
   */
  loadTickEvents(activeSince: EpochMs): Promise<readonly StoredTickEvent[]>;
  /** The one statement that moves an event between lifecycle states, on this transaction. */
  readonly events: EventStatusStore;
  saveCarries(carries: readonly StoredCarry[]): Promise<void>;
  /** Records `atMs` as the run's `lifecycle_ticked_at`. */
  markTicked(atMs: EpochMs): Promise<void>;
}

export interface PendingBatchQuery {
  /**
   * The cursor floor for a run whose ledger is empty. Batches older than this are never
   * offered: a brand-new run must not re-cluster the whole archive into the live registry.
   */
  readonly notBefore: EpochMs;
  readonly limit: number;
}

export interface ClusteringStore {
  /**
   * The live run for this parameter set, created on first use.
   *
   * Throws when the live run was produced under a different version or digest. Changing
   * the clustering parameters under a running registry is a D7 promotion — an offline run,
   * a diff, a ratified switch — and a worker that quietly continued the old run with new
   * parameters would stamp new events with a version the run never used.
   */
  liveRun(config: ClusteringConfig): Promise<ClusteringRun>;

  /**
   * Ingest batches not yet in the run's ledger and newer than its newest entry, oldest
   * first, in `(available_at, source)` order — the same order the engine breaks ties in.
   */
  pendingBatches(run: ClusteringRun, query: PendingBatchQuery): Promise<readonly PendingBatch[]>;

  /**
   * Runs `work` inside one transaction serialised on the run. Resolves to `null` without
   * calling `work` when the batch is already in the ledger (another writer got there
   * first); otherwise to `work`'s value, after the commit.
   */
  withBatch<T>(
    run: ClusteringRun,
    batch: PendingBatch,
    work: (tx: BatchTransaction) => Promise<T>,
  ): Promise<T | null>;

  /** Runs `work` inside one transaction serialised on the run, and commits. */
  withTick<T>(run: ClusteringRun, work: (tx: TickTransaction) => Promise<T>): Promise<T>;
}

/** Re-exported for adapters, which need the parameter type to re-derive ε on read. */
export type { ClusteringParams, Coordinate };
