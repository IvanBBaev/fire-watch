/**
 * The ingest bookkeeping over Postgres (TASKS C2).
 *
 * Three statements, and each of them is idempotent on purpose. A cycle can be re-run —
 * after a crash between the append and the batch record, or by the golden replay — and
 * re-running it must produce the archive it would have produced the first time. So the
 * batch row conflicts on `(source, available_at)` and quarantine entries conflict on the
 * same pair plus what they point at, both DO NOTHING, exactly as the archive does.
 *
 * Entries go in through `unnest` of one array per column, like `pg-detection-store.ts`:
 * a response that fails validation wholesale is the case that produces thousands of them
 * at once, and that is precisely the case that must not hit the parameter limit.
 */

import type { SourceId } from '@fire-watch/contracts';

import type {
  IngestBatchRecord,
  QuarantineEntry,
  QuarantineStore,
} from '../../core/ports/quarantine-store.js';

/**
 * How much of a reason a quarantine entry keeps. A validation reason is a joined list of
 * violation codes and a parser reason is one sentence; anything longer than this is a
 * stack trace that leaked into the wrong channel, and the raw bytes are the evidence
 * anyway.
 */
const MAX_REASON_CHARS = 1000;

const INSERT_BATCH = `
INSERT INTO ingest_batches (
  source, available_at, received, inserted, already_present, rejected, quarantined,
  anomaly_verdict, anomaly_tripped, baseline, ratio,
  ingest_config_version, polling_bbox_version, source_registry_version
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT (source, available_at) DO NOTHING
`.trim();

const QUARANTINE_COLUMNS = [
  'source',
  'available_at',
  'scope',
  'row_index',
  'detection_uid',
  'reason',
  'raw',
] as const;

/** Positionally matched to {@link QUARANTINE_COLUMNS}. */
const QUARANTINE_CASTS = [
  'text',
  'timestamptz',
  'text',
  'integer',
  'text',
  'text',
  'text',
] as const;

const INSERT_QUARANTINE = buildInsertQuarantine();

function buildInsertQuarantine(): string {
  const columns = QUARANTINE_COLUMNS.join(', ');
  const arrays = QUARANTINE_CASTS.map((cast, index) => `$${String(index + 1)}::${cast}[]`).join(
    ', ',
  );
  return (
    `INSERT INTO ingest_quarantine (${columns})\n` +
    `SELECT ${columns} FROM unnest(${arrays}) AS entry(${columns})\n` +
    'ON CONFLICT (source, available_at, scope, row_index) DO NOTHING'
  );
}

/**
 * Newest first, because the breaker's window is "the last N polls" and the median does
 * not care about order — but a replay reading the same rows does, and an ORDER BY that
 * two runs can disagree about is not a window, it is a coin flip.
 */
const SELECT_RECENT_BATCHES = `
SELECT received
  FROM ingest_batches
 WHERE source = $1
 ORDER BY available_at DESC
 LIMIT $2
`.trim();

/**
 * The slice of `pg` this store uses. Wider than `PgQueryable` in one respect only — this
 * store has a read — and deliberately untyped in the rows: the shape is asserted at the
 * one place that reads them, so a schema change surfaces as a thrown error naming the
 * column rather than as a silent `undefined` in the breaker's window.
 */
export interface PgReadable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

export function createPgQuarantineStore(db: PgReadable): QuarantineStore {
  return {
    async recordBatch(batch: IngestBatchRecord): Promise<void> {
      await db.query(INSERT_BATCH, [
        batch.source,
        isoTimestamp(batch.availableAt),
        batch.received,
        batch.inserted,
        batch.alreadyPresent,
        batch.rejected,
        batch.quarantined,
        batch.anomalyVerdict,
        batch.anomalyTripped,
        batch.baseline,
        batch.ratio,
        batch.ingestConfigVersion,
        batch.pollingBboxVersion,
        batch.sourceRegistryVersion,
      ]);
    },

    async quarantine(entries: readonly QuarantineEntry[]): Promise<void> {
      // The healthy case, every ten minutes, all season. It is not a reason for a round
      // trip.
      if (entries.length === 0) return;
      await db.query(INSERT_QUARANTINE, quarantineArrays(entries));
    },

    async recentBatchSizes(source: SourceId, limit: number): Promise<readonly number[]> {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(
          `trailing window limit must be a positive integer, got ${String(limit)}`,
        );
      }
      const { rows } = await db.query(SELECT_RECENT_BATCHES, [source, limit]);
      return rows.map(receivedCount);
    },
  };
}

/** One array per column, in {@link QUARANTINE_COLUMNS} order. */
export function quarantineArrays(entries: readonly QuarantineEntry[]): readonly unknown[][] {
  return [
    entries.map((entry) => entry.source),
    entries.map((entry) => isoTimestamp(entry.availableAt)),
    entries.map((entry) => entry.scope),
    entries.map((entry) => entry.rowIndex),
    entries.map((entry) => entry.detectionUid),
    entries.map((entry) => truncate(entry.reason)),
    entries.map((entry) => entry.raw),
  ];
}

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const INSERT_BATCH_SQL = INSERT_BATCH;
export const INSERT_QUARANTINE_SQL = INSERT_QUARANTINE;
export const SELECT_RECENT_BATCHES_SQL = SELECT_RECENT_BATCHES;

/**
 * A driver that hands back a string where a count belongs — a `bigint` column, a changed
 * type — would otherwise make every baseline `NaN` and quietly disarm the breaker.
 */
function receivedCount(row: unknown): number {
  const received =
    typeof row === 'object' && row !== null ? (row as { received?: unknown }).received : undefined;
  if (typeof received !== 'number' || !Number.isInteger(received)) {
    throw new TypeError(`ingest_batches.received is not an integer: ${String(received)}`);
  }
  return received;
}

function isoTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`available_at must be a finite epoch, got ${String(epochMs)}`);
  }
  return new Date(epochMs).toISOString();
}

function truncate(reason: string): string {
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;
}
