/**
 * What the meta-alert monitors read (TASKS J1). Raw instants and counts only: every age
 * is computed in the core against the injected clock, so a replay with a
 * {@link VirtualClock} produces the same readings as production would have.
 */

import type { EpochMs } from './clock.js';

export interface OutboxQueueSnapshot {
  /** Rows in `pending` whose `decided_at` is not in the future. */
  readonly pendingCount: number;
  /** Rows in `claimed` — handed to a worker, not yet settled. */
  readonly claimedCount: number;
  /** Oldest `decided_at` over pending ∪ claimed, i.e. the oldest deliverable-but-unsent row. */
  readonly oldestUnsentDecidedAt: EpochMs | null;
  /** Oldest `decided_at` among claimed rows (there is no `claimed_at` column). */
  readonly oldestClaimedDecidedAt: EpochMs | null;
  readonly awaitingApprovalCount: number;
  readonly oldestAwaitingDecidedAt: EpochMs | null;
}

export interface IdentityLagSnapshot {
  /** Number of `kind = 'live'` clustering runs. Anything but one means "no reading". */
  readonly liveRuns: number;
  /** Ingested batches after the live run's cursor (and not before `notBefore`). */
  readonly pendingBatches: number;
  /** Oldest `recorded_at` among those batches — when we ingested it, not when it was published. */
  readonly oldestPendingRecordedAt: EpochMs | null;
}

export interface MonitorReader {
  /** @param asOf rows decided after this instant are scheduled, not late. */
  readOutboxQueue(asOf: EpochMs): Promise<OutboxQueueSnapshot>;
  /**
   * @param notBefore the identity loop's own cold-start bound (now − active window), so a
   *   fresh deployment does not report the whole archive as lag.
   */
  readIdentityLag(notBefore: EpochMs): Promise<IdentityLagSnapshot>;
}
