/**
 * The persistence the live alert evaluation cycle runs over (ADR-004 D1, A1.6, A1.8; TASKS
 * H3), as a port.
 *
 * One {@link AlertEvaluationStore.withTransaction} call is one batch: the adapter opens a
 * transaction, serialises it against the identity pipeline's writers, and hands the core a
 * {@link AlertEvaluationTransaction} whose every read and write goes through that one
 * transaction. That is D1 in the only form that survives a crash: the state rows, the
 * outbox rows, the decision log, the per-event evaluation marks and the cursor all commit
 * together or not at all, so a batch interrupted half-way is re-read from the old cursor and re-decided,
 * and the outbox's A1.11 key turns the re-decided sends into no-ops.
 *
 * `seq` values cross this boundary as decimal text: `fire_events.seq` is a `bigint`, and a
 * JavaScript number loses precision at 2^53. The core never does arithmetic on them — it
 * only hands the last one it read back to {@link AlertEvaluationTransaction.advanceCursor}.
 */

import type { LifecycleState } from '@fire-watch/contracts';

import type { AlertableEvent } from '../alerts/alert-decision.js';
import type { Coordinate } from '../clustering/geometry.js';
import type { AlertDecisionLog } from './alert-decision-log.js';
import type { AlertOutboxStore } from './alert-outbox-store.js';
import type { AlertStateStore } from './alert-state-store.js';
import type { WatchZoneStore } from './watch-zone-store.js';

/** A `fire_events` row whose `seq` moved past the cursor, projected for the gate. */
export interface EvaluationEventRow {
  /** `fire_events.id`, decimal text. */
  readonly fireEventId: string;
  /** `fire_events.seq`, decimal text — D1's `trigger_ref` second half. */
  readonly seq: string;
  /** The event centroid. Used for zone matching only; never logged or reported. */
  readonly centroid: Coordinate;
  /** `merged_into IS NOT NULL`: a tombstone, whose alert state the merge already moved. */
  readonly merged: boolean;
  /**
   * Another event names this one as its reignition predecessor (`related_event_id`). The
   * clustering transaction has folded this event's state onto that child, so gating it
   * again would let one fire notify a zone twice — the replay's `superseded` skip.
   */
  readonly superseded: boolean;
  /**
   * Member detections in a live clustering run, quarantined ones included. `0` is an event
   * with no members, which the cycle skips before the gate as the replay does.
   */
  readonly memberCount: number;
  /**
   * The event as the gate sees it. `statusBefore` is the status this loop recorded the last
   * time it evaluated the event (`alert_evaluated_events`), or `null` for a first sight.
   *
   * The persistence facts — `detectionCount`, `nightHighConfidenceCount`, `geoOnly` — are
   * computed over the members **not** flagged `detections.quarantined`, so a batch the
   * ingest breaker tripped on can never lift an event over the system gate (A1.5).
   * `quarantined` is true when the most recently attached member is flagged: the live
   * reading of "the batch this evaluation came from tripped the breaker".
   */
  readonly event: AlertableEvent;
}

/** What {@link AlertEvaluationTransaction.recordEvaluated} writes per event read. */
export interface EvaluatedEventMark {
  readonly fireEventId: string;
  readonly seq: string;
  readonly status: LifecycleState;
}

export interface AlertEvaluationTransaction {
  /** The last `seq` a committed batch consumed, `"0"` before the first. */
  readCursor(): Promise<string>;
  /** Events with `seq > afterSeq`, ascending by `seq`, at most `limit`, one row per event. */
  readEventsAfter(afterSeq: string, limit: number): Promise<readonly EvaluationEventRow[]>;
  readonly zones: Pick<WatchZoneStore, 'listLiveInCells' | 'loadAccountAlertSettings'>;
  readonly alertStates: AlertStateStore;
  readonly outbox: AlertOutboxStore;
  /** Migration 014: the reason and rule version of every decision the batch applies. */
  readonly decisionLog: AlertDecisionLog;
  /** Upserts the per-event marks that make the next evaluation's `statusBefore`. */
  recordEvaluated(marks: readonly EvaluatedEventMark[], atIso: string): Promise<void>;
  /** Moves the cursor forward to `seq`. Refuses to move it backwards. */
  advanceCursor(seq: string, atIso: string): Promise<void>;
}

export interface AlertEvaluationStore {
  /**
   * Runs `work` in one transaction, committed when it resolves and rolled back when it
   * throws. The adapter serialises the transaction against the identity pipeline's
   * writers before `work` runs, so no `seq` below one this batch reads can still commit
   * after it — the property that lets a single `seq` cursor never skip a row.
   */
  withTransaction<T>(work: (tx: AlertEvaluationTransaction) => Promise<T>): Promise<T>;
}
