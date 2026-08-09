/**
 * The archive over Postgres.
 *
 * Two statements, both of them the whole point of the adapter:
 *
 *   * `INSERT ... ON CONFLICT (acq_ts, detection_uid) DO NOTHING` — the uid no-op that
 *     makes a double poll harmless (ADR-002 A1.1, TASKS C1). The conflict target is the
 *     pair rather than the uid alone because the table is partitioned by `acq_ts` and a
 *     unique constraint must contain the partition key; the two are equivalent, since
 *     `acq_ts` is itself a hash input and a given uid can only ever carry one.
 *   * an upsert on `source_status`, so a poll that failed and a poll that found nothing
 *     leave visibly different marks (DATA-SOURCES §A1.1 pitfall 10).
 *
 * Rows go in through `unnest` of one array per column rather than a generated VALUES
 * list: the parameter count stays at nineteen no matter how large the batch is, which
 * keeps a busy August afternoon from running into the 65,535-parameter wire limit.
 */

import type {
  AppendResult,
  DetectionRecord,
  DetectionStore,
  PollAttempt,
} from '../../core/ports/detection-store.js';

/**
 * The slice of `pg` this module uses. Structural on purpose: a `Pool` and a `Client`
 * both satisfy it, and so does a transaction handle, so the caller decides the
 * connection lifecycle rather than inheriting one from here.
 */
export interface PgQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * How much of a failure message `source_status.last_error` keeps. The message is already
 * an excerpt by the time it reaches us, and this column is read by an operator glancing
 * at freshness, not by a log search.
 */
const MAX_ERROR_CHARS = 500;

const DETECTION_COLUMNS = [
  'detection_uid',
  'source',
  'product_tier',
  'acq_ts',
  'available_at',
  'lat',
  'lon',
  'scan_km',
  'track_km',
  'frp_mw',
  'brightness_k',
  'brightness_bg_k',
  'confidence_raw',
  'confidence',
  'day_night',
  'collection_version',
  'source_registry_version',
  'ingest_config_version',
  'quarantined',
] as const;

/**
 * One cast per column, positionally matched to {@link DETECTION_COLUMNS}. `numeric` for
 * the coordinates because they are hash inputs and `double precision` does not
 * round-trip five decimals; `text` for `day_night`, which Postgres widens into `char(1)`
 * on insert and would otherwise need a `bpchar[]` the driver has no reason to know about.
 */
const DETECTION_CASTS = [
  'text',
  'text',
  'text',
  'timestamptz',
  'timestamptz',
  'numeric',
  'numeric',
  'real',
  'real',
  'real',
  'real',
  'real',
  'text',
  'text',
  'text',
  'text',
  'text',
  'text',
  'boolean',
] as const;

const INSERT_DETECTIONS = buildInsertDetections();

function buildInsertDetections(): string {
  const columns = DETECTION_COLUMNS.join(', ');
  const arrays = DETECTION_CASTS.map((cast, index) => `$${String(index + 1)}::${cast}[]`).join(
    ', ',
  );
  return (
    `INSERT INTO detections (${columns})\n` +
    `SELECT ${columns} FROM unnest(${arrays}) AS batch(${columns})\n` +
    'ON CONFLICT (acq_ts, detection_uid) DO NOTHING'
  );
}

/**
 * `last_success_at` and `last_data_at` are carried forward with COALESCE rather than
 * overwritten: a failure must not erase the fact that the source was healthy an hour
 * ago, because that gap is exactly what the freshness surface reports.
 */
const UPSERT_SOURCE_STATUS = `
INSERT INTO source_status (
  source, last_attempt_at, last_success_at, last_data_at,
  consecutive_failures, last_error, updated_at
)
VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN 0 ELSE 1 END, $6, $2)
ON CONFLICT (source) DO UPDATE SET
  last_attempt_at      = EXCLUDED.last_attempt_at,
  last_success_at      = COALESCE(EXCLUDED.last_success_at, source_status.last_success_at),
  last_data_at         = COALESCE(EXCLUDED.last_data_at, source_status.last_data_at),
  consecutive_failures = CASE
                           WHEN $5::boolean THEN 0
                           ELSE source_status.consecutive_failures + 1
                         END,
  last_error           = EXCLUDED.last_error,
  updated_at           = EXCLUDED.updated_at
`.trim();

export function createPgDetectionStore(db: PgQueryable): DetectionStore {
  return {
    async appendDetections(records: readonly DetectionRecord[]): Promise<AppendResult> {
      if (records.length === 0) {
        // A healthy empty poll is not a reason to open a transaction.
        return { received: 0, inserted: 0, alreadyPresent: 0 };
      }

      const result = await db.query(INSERT_DETECTIONS, detectionArrays(records));
      const inserted = result.rowCount ?? 0;
      return {
        received: records.length,
        inserted,
        alreadyPresent: records.length - inserted,
      };
    },

    async recordPollAttempt(attempt: PollAttempt): Promise<void> {
      const attemptAt = isoTimestamp(attempt.attemptAt);
      await db.query(UPSERT_SOURCE_STATUS, [
        attempt.source,
        attemptAt,
        attempt.succeeded ? attemptAt : null,
        // Distinct from success on purpose: a source that answers with zero rows every
        // cycle in February is healthy, and one that answers with zero rows every cycle
        // in August is not — only `last_data_at` can tell those apart.
        attempt.succeeded && attempt.receivedRows > 0 ? attemptAt : null,
        // One flag, read twice by the statement — on insert it becomes the failure
        // count, on conflict it decides between reset and increment.
        attempt.succeeded,
        attempt.succeeded ? null : truncate(attempt.error),
        // `updated_at` is bound to $2 by the statement itself: it is bookkeeping, and
        // reading a second clock here would make two rows of the same cycle disagree.
      ]);
    },
  };
}

/** One array per column, in {@link DETECTION_COLUMNS} order. */
export function detectionArrays(records: readonly DetectionRecord[]): readonly unknown[][] {
  return [
    records.map((record) => record.detectionUid),
    records.map((record) => record.source),
    records.map((record) => record.productTier),
    records.map((record) => record.acqTsIso),
    records.map((record) => isoTimestamp(record.availableAt)),
    records.map((record) => record.lat),
    records.map((record) => record.lon),
    records.map((record) => record.scanKm),
    records.map((record) => record.trackKm),
    records.map((record) => record.frpMw),
    records.map((record) => record.brightnessK),
    records.map((record) => record.brightnessBgK),
    records.map((record) => record.confidenceRaw),
    records.map((record) => record.confidence),
    records.map((record) => record.dayNight),
    records.map((record) => record.collectionVersion),
    records.map((record) => record.sourceRegistryVersion),
    records.map((record) => record.ingestConfigVersion),
    records.map((record) => record.quarantined),
  ];
}

/** Exported for the tests that assert the statement's shape rather than its effect. */
export const INSERT_DETECTIONS_SQL = INSERT_DETECTIONS;
export const UPSERT_SOURCE_STATUS_SQL = UPSERT_SOURCE_STATUS;

function isoTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`available_at must be a finite epoch, got ${String(epochMs)}`);
  }
  return new Date(epochMs).toISOString();
}

function truncate(error: string | null): string | null {
  if (error === null) return null;
  return error.length > MAX_ERROR_CHARS ? `${error.slice(0, MAX_ERROR_CHARS)}…` : error;
}
