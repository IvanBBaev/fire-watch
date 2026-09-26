/**
 * The meta-alert monitors' reads (TASKS J1) — two aggregate queries, read-only.
 *
 * Outbox: one pass over the rows that are not settled. `pending` rows count only once
 * their `decided_at` has arrived, mirroring the claim's own `decided_at <= now` filter in
 * `pg-alert-dispatch-queue.ts`, so a scheduled row is not reported as late. `claimed`
 * rows count regardless: a claim is by definition a row that was due.
 *
 * Identity: the pending-batch cursor of `pg-clustering-store.ts`, aggregated instead of
 * listed and without its per-cycle LIMIT — the lag is the whole backlog, not the next
 * page of it. The predicate must stay in step with that store's `SELECT_PENDING_BATCHES`;
 * the integration test drives both over the same ledger to hold them together.
 */

import { isoFromEpochMs, type EpochMs } from '../../core/ports/clock.js';
import type {
  IdentityLagSnapshot,
  MonitorReader,
  OutboxQueueSnapshot,
} from '../../core/ports/monitor-reader.js';
import { epochMs, field, number } from './pg-rows.js';

export interface PgMonitorQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const OUTBOX_QUEUE = `
SELECT
  count(*) FILTER (WHERE status = 'pending' AND decided_at <= $1::timestamptz)::int AS pending_count,
  count(*) FILTER (WHERE status = 'claimed')::int AS claimed_count,
  min(decided_at) FILTER (
    WHERE (status = 'pending' AND decided_at <= $1::timestamptz) OR status = 'claimed'
  ) AS oldest_unsent_decided_at,
  min(decided_at) FILTER (WHERE status = 'claimed') AS oldest_claimed_decided_at,
  count(*) FILTER (WHERE status = 'awaiting_approval')::int AS awaiting_count,
  min(decided_at) FILTER (WHERE status = 'awaiting_approval') AS oldest_awaiting_decided_at
FROM alert_outbox
WHERE status IN ('pending', 'claimed', 'awaiting_approval')`.trim();

const IDENTITY_LAG = `
WITH live AS (
  SELECT id FROM clustering_runs WHERE kind = 'live'
),
cursor AS (
  SELECT cb.available_at, cb.source
    FROM clustering_batches cb
   WHERE cb.clustering_run_id = (SELECT min(id) FROM live)
   ORDER BY cb.available_at DESC, cb.source COLLATE "C" DESC
   LIMIT 1
)
SELECT
  (SELECT count(*) FROM live)::int AS live_runs,
  count(b.available_at)::int AS pending_batches,
  min(b.recorded_at) AS oldest_recorded_at
FROM ingest_batches b
LEFT JOIN cursor c ON true
WHERE (SELECT count(*) FROM live) = 1
  AND (
    (c.available_at IS NULL AND b.available_at >= $1::timestamptz)
    OR (c.available_at IS NOT NULL AND (
      b.available_at > c.available_at
      OR (b.available_at = c.available_at AND b.source COLLATE "C" > c.source COLLATE "C")
    ))
  )`.trim();

/** Exported for the shape tests; the SQL is the contract with migrations 001/002/005. */
export const MONITOR_SQL = { outboxQueue: OUTBOX_QUEUE, identityLag: IDENTITY_LAG } as const;

export function createPgMonitorReader(db: PgMonitorQueryable): MonitorReader {
  return {
    async readOutboxQueue(asOf: EpochMs): Promise<OutboxQueueSnapshot> {
      const { rows } = await db.query(OUTBOX_QUEUE, [isoFromEpochMs(asOf)]);
      const [row] = rows;
      // An aggregate without GROUP BY always returns exactly one row.
      if (row === undefined) throw new Error('outbox queue aggregate returned no row');
      return {
        pendingCount: number(field(row, 'pending_count'), 'pending_count'),
        claimedCount: number(field(row, 'claimed_count'), 'claimed_count'),
        oldestUnsentDecidedAt: optionalEpochMs(row, 'oldest_unsent_decided_at'),
        oldestClaimedDecidedAt: optionalEpochMs(row, 'oldest_claimed_decided_at'),
        awaitingApprovalCount: number(field(row, 'awaiting_count'), 'awaiting_count'),
        oldestAwaitingDecidedAt: optionalEpochMs(row, 'oldest_awaiting_decided_at'),
      };
    },

    async readIdentityLag(notBefore: EpochMs): Promise<IdentityLagSnapshot> {
      const { rows } = await db.query(IDENTITY_LAG, [isoFromEpochMs(notBefore)]);
      const [row] = rows;
      if (row === undefined) throw new Error('identity lag aggregate returned no row');
      return {
        liveRuns: number(field(row, 'live_runs'), 'live_runs'),
        pendingBatches: number(field(row, 'pending_batches'), 'pending_batches'),
        oldestPendingRecordedAt: optionalEpochMs(row, 'oldest_recorded_at'),
      };
    },
  };
}

function optionalEpochMs(row: unknown, name: string): EpochMs | null {
  const value = field(row, name);
  return value === null ? null : epochMs(value, name);
}
