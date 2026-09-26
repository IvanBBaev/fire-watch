/**
 * One poll of the live identity pipeline (ADR-002 D1 layers 2–3, D4; TASKS D1/D4 wiring).
 *
 * This is `replay/identity-engine.ts` with its memory replaced by a store. The replay
 * clusters a fixture batch, plans the merge and the reignition links on the table that
 * produces, and ticks the lifecycle once per poll; this does the same four steps, in the
 * same order, over the ingest batches the worker has committed since the last cycle. The
 * per-batch glue both of them need lives in `identity-batch.ts` and is imported by both,
 * so there is exactly one definition of "the tick's view of an event" and one of "an
 * event's aggregates" — the CI-1 replay proves the code this file runs.
 *
 * ## What is the same as the replay, and why that is the point
 *
 *   - **The batch instant is the batch's `available_at`, not the wall clock.** A live
 *     cycle that picks a batch up three minutes late clusters it exactly as a replay of the
 *     archive would, because `clusterBatch`'s `now` (eviction and minting) is a property
 *     of the batch. The wall clock appears once, as the lifecycle tick's instant, which is
 *     where the replay uses its (virtual) clock too.
 *   - **Batches are applied one at a time, oldest first, each in its own transaction.**
 *     Folding two polls into one `clusterBatch` call would change which detection seeds a
 *     cluster and so which public id is minted; the replay never folds, so neither does
 *     this. A batch that fails stops the cycle — the next one depends on its state — and
 *     is retried from scratch next cycle, because its transaction rolled back whole.
 *   - **Merge plan first, reignition plan on its result, tick last.** The reasons are in
 *     `planRegistryWrites` and in the replay's own comments; nothing about them depends
 *     on where the state is kept.
 *   - **The D6 score is `scoreEvent` under the replay's context.** Every event whose
 *     member set the batch changed is rescored in the batch transaction (`event-scores.ts`),
 *     with the same three unarmed context inputs the replay states, so the live bucket of a
 *     member set is the replayed bucket of it.
 *
 * ## What is different, and each difference is stated rather than hidden
 *
 *   - **Member order is canonical after a reload.** The replay keeps members in arrival
 *     order; a store has none to give back, so a cluster read from Postgres has its
 *     members in `orderMembers` order. Every aggregate except the centroid is order-free,
 *     and the centroid differs only in the last bits of a float sum — below the 5 dp grid
 *     it is written on, but not zero. The replay remains the definition.
 *   - **The lifecycle carry is persisted** (migration 005), including the newest
 *     acquisition the previous tick knew about, which is the whole redetection test.
 *   - **Inputs nobody supplies yet are empty, not guessed.** No declaration source, no
 *     cloud-cover feed and no outage register exists in production; the tick is handed
 *     none, which is exactly what it is handed for a fixture that states none. Events in a
 *     curated `officially_*` state are not ticked at all: `decideLifecycle` requires the
 *     standing declaration for them, and there is no live source to read it from. Ticking
 *     them without it would throw; ticking them with a fabricated one would be worse.
 *
 * ## The tick window
 *
 * `[since, at)` with `since` the run's previous tick, read under the run lock. Two clamps,
 * both toward doing less rather than more: the very first tick has an empty window (there
 * is no previous tick, and "since the epoch" would sweep in every overpass ever flown),
 * and a window longer than the pass predictor's limit is shortened to it — a worker that
 * was down for over a year resumes with the most recent year of passes, not an exception
 * that would stop the pipeline forever.
 */

import { isCuratedLifecycleState } from '@fire-watch/contracts';

import { activeWindowMs } from '../clustering/clustering-params.js';
import { clusterBatch } from '../clustering/engine.js';
import type { BatchStats, ClusteringConfig } from '../clustering/types.js';
import type { LifecycleParams } from '../config/lifecycle-params.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { MAX_WINDOW_DAYS } from '../lifecycle/static-pass-predictor.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../ports/clock.js';
import type {
  ClusteringRun,
  ClusteringStore,
  PendingBatch,
  StoredCarry,
  StoredTickEvent,
} from '../ports/clustering-store.js';
import type { PassPredictor } from '../ports/pass-predictor.js';
import { reignitionCandidateQuery } from '../registry/reignition-plan.js';
import { FRESH_CARRY, tickLifecycle, type LifecycleCarry } from '../replay/lifecycle-tick.js';
import { eventScores, scoringDetectionKeys } from './event-scores.js';
import {
  involvedPublicIds,
  membersFromStored,
  planRegistryWrites,
  stateFromStored,
  tickEventFor,
  type MemberObservations,
} from './identity-batch.js';

const MS_PER_DAY = 86_400_000;

/**
 * The longest evidence window a tick asks the predictor for. One day under its limit
 * because the limit counts UTC days touched, and a window of exactly N×24 h that does not
 * start at midnight touches N+1 of them.
 */
export const MAX_TICK_WINDOW_MS = (MAX_WINDOW_DAYS - 1) * MS_PER_DAY;

export interface IdentityCycleDeps {
  readonly store: ClusteringStore;
  readonly clock: Clock;
  readonly config: ClusteringConfig;
  readonly predictor: PassPredictor;
  /** Omitted in production: the tick's own default is the ratified parameter set. */
  readonly lifecycle?: VersionedConfig<LifecycleParams>;
  /**
   * Upper bound on batches clustered in one cycle, so one cycle after a long outage does
   * not hold the run lock for as long as the backlog is. The rest are taken next cycle —
   * the report says the limit was reached, which is the signal that the pipeline is
   * behind rather than idle.
   */
  readonly maxBatchesPerCycle: number;
}

/** Summed {@link BatchStats} over the cycle's batches. */
export type CycleBatchStats = BatchStats;

/** One cycle, as the reporter logs it. Every field is canonical-JSON safe. */
export interface IdentityCycleReport {
  readonly runId: number;
  readonly batches: {
    readonly pending: number;
    readonly applied: number;
    /** Already in the ledger when the lock was granted: another writer applied them. */
    readonly skipped: number;
    /** `pending` hit `maxBatchesPerCycle`, so more may be waiting. */
    readonly limitReached: boolean;
  };
  readonly stats: CycleBatchStats;
  readonly reignitionLinks: number;
  readonly tick: {
    readonly atIso: string;
    readonly sinceIso: string;
    readonly events: number;
    /** Events in a curated state, left alone (see the module docblock). */
    readonly curatedSkipped: number;
    /** Transitions written (`seq` moved). */
    readonly transitions: number;
    /** Transitions whose event was not live any more when written (`applyTransition` → null). */
    readonly missing: number;
  };
}

const ZERO_STATS: CycleBatchStats = Object.freeze({
  detections: 0,
  seeded: 0,
  attached: 0,
  merged: 0,
  unattached: 0,
  alreadyAssigned: 0,
  footprintDefaulted: 0,
  evicted: 0,
});

export async function runIdentityCycle(deps: IdentityCycleDeps): Promise<IdentityCycleReport> {
  if (!Number.isInteger(deps.maxBatchesPerCycle) || deps.maxBatchesPerCycle < 1) {
    throw new RangeError(
      `maxBatchesPerCycle must be a positive integer, got ${String(deps.maxBatchesPerCycle)}`,
    );
  }
  const params = deps.config.values;
  const run = await deps.store.liveRun(deps.config);

  const pending = await deps.store.pendingBatches(run, {
    // A run with an empty ledger starts one active window back: exactly the detections
    // the working set would hold had the pipeline always been running.
    notBefore: deps.clock.now() - activeWindowMs(params),
    limit: deps.maxBatchesPerCycle,
  });

  let applied = 0;
  let skipped = 0;
  let reignitionLinks = 0;
  let stats = ZERO_STATS;
  for (const batch of pending) {
    const outcome = await applyOneBatch(deps, run, batch);
    if (outcome === null) {
      skipped += 1;
      continue;
    }
    applied += 1;
    reignitionLinks += outcome.reignitionLinks;
    stats = addStats(stats, outcome.stats);
  }

  const tick = await tickOnce(deps, run);

  return {
    runId: run.id,
    batches: {
      pending: pending.length,
      applied,
      skipped,
      limitReached: pending.length >= deps.maxBatchesPerCycle,
    },
    stats,
    reignitionLinks,
    tick,
  };
}

interface BatchOutcome {
  readonly stats: BatchStats;
  readonly reignitionLinks: number;
}

async function applyOneBatch(
  deps: IdentityCycleDeps,
  run: ClusteringRun,
  batch: PendingBatch,
): Promise<BatchOutcome | null> {
  const params = deps.config.values;
  return deps.store.withBatch(run, batch, async (tx) => {
    const now = batch.availableAt;
    const detections = await tx.loadDetections();
    const stored = await tx.loadWorkingSet(now - activeWindowMs(params));
    const result = clusterBatch({
      detections,
      state: stateFromStored(stored, params),
      now,
      config: deps.config,
    });

    const aliases = await tx.loadAliases();
    // Only a seed can be a reignition, so a batch that seeded nothing asks nothing. The
    // reader runs after `clusterBatch` in the same snapshot as the working set, which is
    // the one ordering the reignition plan's "refresh a touched candidate" step expects.
    const candidates =
      result.seeded.length === 0
        ? []
        : await tx.loadCandidates(
            result.seeded.map((seed) => reignitionCandidateQuery(seed, params)),
          );
    const alertStates = await tx.loadAlertStates(
      involvedPublicIds(result, aliases, candidates, params),
    );

    const writes = planRegistryWrites({
      result,
      aliases,
      candidates,
      alertStates,
      params,
      batchAtMs: now,
    });
    // D6 score of every event whose member set this batch changed (11 §3.4), in the same
    // transaction and against the same membership the aggregates describe.
    const scoringRows = await tx.loadScoringDetections(
      scoringDetectionKeys(result, writes.aggregates),
    );
    const scores = eventScores(result, writes.aggregates, scoringRows);
    await tx.applyBatch({ batch, result, writes, scores });
    return { stats: result.stats, reignitionLinks: writes.reignitionLinks.length };
  });
}

async function tickOnce(
  deps: IdentityCycleDeps,
  run: ClusteringRun,
): Promise<IdentityCycleReport['tick']> {
  const params = deps.config.values;
  return deps.store.withTick(run, async (tx) => {
    const previous = tx.lastTickedAtMs;
    // A wall clock that stepped backwards must not re-open a window already counted: the
    // tick is then empty and stamped at the previous instant, which is where the carry is.
    const atMs = Math.max(deps.clock.now(), previous ?? Number.NEGATIVE_INFINITY);
    const sinceMs = tickWindowStart(atMs, previous);

    const loaded = await tx.loadTickEvents(atMs - activeWindowMs(params));
    const events = loaded.filter((event) => !isCuratedLifecycleState(event.status));

    const outcome = tickLifecycle(
      {
        atMs,
        sinceMs,
        events: events.map((event) => tickEventFromStored(event, deps)),
        carry: new Map(events.map((event) => [event.publicId, carryFromStored(event)])),
        predictor: deps.predictor,
        cloud: [],
        outages: [],
      },
      deps.lifecycle,
      params,
    );

    const byId = new Map(events.map((event) => [event.publicId, event]));
    let transitions = 0;
    let missing = 0;
    for (const { decision } of outcome.results) {
      const before = byId.get(decision.publicId);
      if (before === undefined) continue;
      const moved =
        decision.state !== before.status ||
        decision.displayTier !== before.displayTier ||
        decision.inactiveSinceMs !== before.inactiveSinceMs;
      // Only a change is written: every `applyTransition` bumps `seq`, and an unchanged
      // row rewritten every poll is a cache miss for every client for nothing.
      if (!moved) continue;
      const seq = await tx.events.applyTransition({
        publicId: decision.publicId,
        status: decision.state,
        statusReason: decision.reason,
        displayTier: decision.displayTier,
        inactiveSinceMs: decision.inactiveSinceMs,
        atMs: decision.atMs,
      });
      if (seq === null) missing += 1;
      else transitions += 1;
    }

    const carries: StoredCarry[] = [];
    for (const event of events) {
      const carried = outcome.carry.get(event.publicId);
      if (carried !== undefined) carries.push(carryToStored(event.publicId, carried));
    }
    await tx.saveCarries(carries);
    await tx.markTicked(atMs);

    return {
      atIso: isoFromEpochMs(atMs),
      sinceIso: isoFromEpochMs(sinceMs),
      events: events.length,
      curatedSkipped: loaded.length - events.length,
      transitions,
      missing,
    };
  });
}

/** `since` for a tick at `atMs`: see "The tick window" in the module docblock. */
export function tickWindowStart(atMs: EpochMs, previousMs: EpochMs | null): EpochMs {
  if (previousMs === null) return atMs;
  return Math.min(atMs, Math.max(previousMs, atMs - MAX_TICK_WINDOW_MS));
}

function tickEventFromStored(event: StoredTickEvent, deps: IdentityCycleDeps) {
  const members = membersFromStored(event.members, deps.config.values);
  const frp = new Map(event.members.map((member) => [member.detectionUid, member.frpMw]));
  const observed: MemberObservations = {
    frpMw: (uid) => frp.get(uid) ?? null,
    // No live source of curated statements exists (module docblock).
    declarations: () => [],
  };
  const lastDetectionAt = members.reduce(
    (max, member) => Math.max(max, member.acqTs),
    Number.NEGATIVE_INFINITY,
  );
  return tickEventFor({ publicId: event.publicId, members, lastDetectionAt }, observed);
}

/**
 * The carry as the previous tick left it on the row. An event no tick has seen yet
 * (`seenDetectionAtMs` null) starts from {@link FRESH_CARRY}, exactly as a replay event
 * the carry map has never held does — which is what makes its first tick a detection.
 */
function carryFromStored(event: StoredTickEvent): LifecycleCarry {
  if (event.seenDetectionAtMs === null) return FRESH_CARRY;
  return {
    state: event.status,
    accumulatedE: event.missEvidence,
    geoWeightSpent: event.geoWeightSpent,
    blindSinceMs: event.blindSinceMs,
    inactiveSinceMs: event.inactiveSinceMs,
    officialDeclaration: null,
    lastDetectionAtMs: event.seenDetectionAtMs,
  };
}

function carryToStored(publicId: string, carry: LifecycleCarry): StoredCarry {
  return {
    publicId,
    missEvidence: carry.accumulatedE,
    geoWeightSpent: carry.geoWeightSpent,
    blindSinceMs: carry.blindSinceMs,
    seenDetectionAtMs: carry.lastDetectionAtMs,
  };
}

function addStats(a: CycleBatchStats, b: BatchStats): CycleBatchStats {
  return {
    detections: a.detections + b.detections,
    seeded: a.seeded + b.seeded,
    attached: a.attached + b.attached,
    merged: a.merged + b.merged,
    unattached: a.unattached + b.unattached,
    alreadyAssigned: a.alreadyAssigned + b.alreadyAssigned,
    footprintDefaulted: a.footprintDefaulted + b.footprintDefaulted,
    evicted: a.evicted + b.evicted,
  };
}
