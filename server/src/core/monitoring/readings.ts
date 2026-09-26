/**
 * Snapshots → readings (TASKS J1). Every age is `now − instant` in whole seconds, floored
 * at zero: the database clock and the worker clock are two clocks, and a row stamped a
 * few milliseconds "in the future" by the former is not a negative-aged row.
 */

import type { EpochMs } from '../ports/clock.js';
import type { IdentityLagSnapshot, OutboxQueueSnapshot } from '../ports/monitor-reader.js';
import type { MetaAlertKey } from './meta-alert-params.js';

export type Readings = Readonly<Record<MetaAlertKey, number | null>>;

export function ageSeconds(instant: EpochMs | null, now: EpochMs): number | null {
  if (instant === null) return null;
  return Math.max(0, Math.floor((now - instant) / 1000));
}

export function outboxReadings(
  snapshot: OutboxQueueSnapshot,
  now: EpochMs,
): Pick<
  Readings,
  | 'outbox_queue_oldest_seconds'
  | 'outbox_pending_rows'
  | 'outbox_claimed_rows'
  | 'outbox_claimed_oldest_seconds'
  | 'outbox_awaiting_approval_oldest_seconds'
> {
  return {
    // An empty queue is a healthy queue: age 0, not "no data". A `null` would hold a live
    // page open forever on the one cycle that should clear it.
    outbox_queue_oldest_seconds: ageSeconds(snapshot.oldestUnsentDecidedAt, now) ?? 0,
    outbox_pending_rows: snapshot.pendingCount,
    outbox_claimed_rows: snapshot.claimedCount,
    outbox_claimed_oldest_seconds: ageSeconds(snapshot.oldestClaimedDecidedAt, now) ?? 0,
    outbox_awaiting_approval_oldest_seconds: ageSeconds(snapshot.oldestAwaitingDecidedAt, now) ?? 0,
  };
}

export function identityReadings(
  snapshot: IdentityLagSnapshot,
  now: EpochMs,
): Pick<Readings, 'identity_pending_batches' | 'identity_oldest_pending_seconds'> {
  if (snapshot.liveRuns !== 1) {
    // Zero live runs is a fresh deployment; several is a D7 promotion in progress that the
    // identity loop itself refuses to continue. Neither has a cursor to lag behind.
    return { identity_pending_batches: null, identity_oldest_pending_seconds: null };
  }
  return {
    identity_pending_batches: snapshot.pendingBatches,
    identity_oldest_pending_seconds: ageSeconds(snapshot.oldestPendingRecordedAt, now) ?? 0,
  };
}
