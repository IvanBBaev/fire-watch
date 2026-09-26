/**
 * The `SpStagingStore` over Postgres — the adapter half of the D7 month swap (ADR-002
 * D7 as amended by A1.4; TASKS C7). Raw pg and snake_case throughout, like every other
 * adapter; the SQL is the interesting part, so it is all here, in the open.
 *
 * Partition mechanics worth stating once:
 *
 *   * The staging table is `CREATE TABLE … (LIKE detections INCLUDING ALL)` — columns,
 *     CHECKs, defaults, generated columns and indexes, but NOT foreign keys; those are
 *     cloned and validated when the table is attached.
 *   * Before the swap a bound CHECK matching the partition bound is added to the
 *     staging table. Its ADD scans the staging table once, outside the swap
 *     transaction, so the `ATTACH PARTITION` inside the transaction validates against
 *     the constraint instead of scanning while holding ACCESS EXCLUSIVE on
 *     `detections`.
 *   * The swap itself is one transaction: DETACH the NRT partition, rename it to the
 *     retired name, rename staging to the live name, ATTACH. Any failure rolls the
 *     whole thing back and NRT stays live.
 *   * If `event_detections` rows still reference the live partition, Postgres refuses
 *     the DETACH — correct and fail-closed until the D-track re-cluster exists (the
 *     backfill months have no event rows, so this never fires for them).
 *   * A month that was already swapped has its retired name taken; the rename fails
 *     and the transaction rolls back. The `live_partition_nrt_only` check refuses such
 *     a month long before this, but the collision is a second, structural guard.
 *
 * Identifiers cannot be parameterized, so every table name that reaches the SQL is
 * re-validated against the partition naming grammar here, even though `monthWindow`
 * can only produce well-formed names — the adapter does not get to assume its caller.
 * The two timestamp literals in DDL positions are validated the same way.
 */

import type { BoundingBox } from '../../core/config/polling-bbox.js';
import type { AppendResult, DetectionRecord } from '../../core/ports/detection-store.js';
import type { SpStagingStore, SwapOutcome } from '../../core/ports/sp-staging-store.js';
import type { MonthWindow } from '../../core/promotion/month-window.js';
import type { SourceDay, SwapObservations } from '../../core/promotion/sanity-checks.js';
import { detectionArrays } from '../db/pg-detection-store.js';

/** Query surface the store needs; `pg.Pool` satisfies it structurally. */
export interface PromotionQueryResult {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number | null;
}

export interface PromotionClient {
  query(text: string, values?: readonly unknown[]): Promise<PromotionQueryResult>;
  release(): void;
}

export interface PromotionPool {
  query(text: string, values?: readonly unknown[]): Promise<PromotionQueryResult>;
  connect(): Promise<PromotionClient>;
}

const PROMOTION_TABLE_RE = /^detections_\d{4}_(0[1-9]|1[0-2])(_sp_staging|_nrt_retired)?$/;

/** Refuses anything that is not a `detections` month partition or its two derivatives. */
export function assertPromotionTable(name: string): string {
  if (!PROMOTION_TABLE_RE.test(name)) {
    throw new RangeError(`not a promotion table name: ${JSON.stringify(name)}`);
  }
  return name;
}

const BOUND_ISO_RE = /^\d{4}-(0[1-9]|1[0-2])-01T00:00:00Z$/;

/** A month-boundary timestamp, quoted for a DDL position (bounds cannot be $n params). */
export function partitionBoundLiteral(iso: string): string {
  if (!BOUND_ISO_RE.test(iso)) {
    throw new RangeError(`not a month-boundary timestamp: ${JSON.stringify(iso)}`);
  }
  return `'${iso}'`;
}

/**
 * Same 19 columns and casts as the live insert path (`pg-detection-store`), redeclared
 * because that module keeps them private; `detectionArrays` — the value side — is
 * shared, so the two lists cannot drift from the record shape independently.
 */
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

export function stagingInsertSql(table: string): string {
  const target = assertPromotionTable(table);
  const columns = DETECTION_COLUMNS.join(', ');
  const arrays = DETECTION_CASTS.map((cast, index) => `$${String(index + 1)}::${cast}[]`).join(
    ', ',
  );
  return (
    `INSERT INTO ${target} (${columns})\n` +
    `SELECT ${columns} FROM unnest(${arrays}) AS batch(${columns})\n` +
    'ON CONFLICT (acq_ts, detection_uid) DO NOTHING'
  );
}

/** Rows per unnest batch — the arrays stay far under any parameter or memory concern. */
export const STAGING_BATCH_ROWS = 5_000;

export function createPgSpStagingStore(db: PromotionPool): SpStagingStore {
  return {
    async prepareStaging(window: MonthWindow): Promise<void> {
      const staging = assertPromotionTable(window.stagingTable);
      // DROP + CREATE rather than TRUNCATE: a rerun must never inherit a half-loaded
      // table or a stale bound CHECK from an aborted earlier attempt. The staging
      // table is scratch until it is attached — the append-only discipline binds
      // partitions of `detections`, not this.
      await db.query(`DROP TABLE IF EXISTS ${staging}`);
      await db.query(`CREATE TABLE ${staging} (LIKE detections INCLUDING ALL)`);
    },

    async loadStaged(
      window: MonthWindow,
      records: readonly DetectionRecord[],
    ): Promise<AppendResult> {
      if (records.length === 0) {
        return { received: 0, inserted: 0, alreadyPresent: 0 };
      }
      const sql = stagingInsertSql(window.stagingTable);
      let inserted = 0;
      for (let offset = 0; offset < records.length; offset += STAGING_BATCH_ROWS) {
        const batch = records.slice(offset, offset + STAGING_BATCH_ROWS);
        const result = await db.query(sql, detectionArrays(batch));
        inserted += result.rowCount ?? 0;
      }
      return {
        received: records.length,
        inserted,
        alreadyPresent: records.length - inserted,
      };
    },

    async observe(window: MonthWindow, bbox: BoundingBox): Promise<SwapObservations> {
      const live = assertPromotionTable(window.livePartition);
      const staging = assertPromotionTable(window.stagingTable);

      const liveTotals = await db.query(
        `SELECT count(*)::bigint AS total_rows,
                count(*) FILTER (WHERE product_tier <> 'NRT')::bigint AS non_nrt_rows
           FROM ${live}`,
      );
      const liveDays = await db.query(
        `SELECT source, to_char(acq_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
           FROM ${live}
          WHERE product_tier = 'NRT'
          GROUP BY 1, 2
          ORDER BY 1, 2`,
      );
      const stagedTotals = await db.query(
        `SELECT count(*)::bigint AS total_rows,
                count(*) FILTER (WHERE acq_ts < $1 OR acq_ts >= $2)::bigint AS outside_month,
                count(*) FILTER (
                  WHERE lat < $3 OR lat > $4 OR lon < $5 OR lon > $6
                )::bigint AS outside_bbox
           FROM ${staging}`,
        [window.startIso, window.endIso, bbox.south, bbox.north, bbox.west, bbox.east],
      );
      const stagedDays = await db.query(
        `SELECT source, to_char(acq_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
           FROM ${staging}
          GROUP BY 1, 2
          ORDER BY 1, 2`,
      );
      const duplicates = await db.query(
        `SELECT count(*)::bigint AS duplicate_uids
           FROM (
             SELECT detection_uid FROM ${staging} GROUP BY detection_uid HAVING count(*) > 1
           ) AS duplicated`,
      );

      const liveRow = singleRow(liveTotals, 'live totals');
      const stagedRow = singleRow(stagedTotals, 'staged totals');
      const duplicateRow = singleRow(duplicates, 'duplicate uids');

      return {
        liveRows: toCount(liveRow['total_rows']),
        liveNonNrtRows: toCount(liveRow['non_nrt_rows']),
        liveSourceDays: liveDays.rows.map(toSourceDay),
        stagedRows: toCount(stagedRow['total_rows']),
        stagedSourceDays: stagedDays.rows.map(toSourceDay),
        stagedOutsideMonth: toCount(stagedRow['outside_month']),
        stagedOutsideBbox: toCount(stagedRow['outside_bbox']),
        stagedDuplicateUids: toCount(duplicateRow['duplicate_uids']),
      };
    },

    async swap(window: MonthWindow): Promise<SwapOutcome> {
      const live = assertPromotionTable(window.livePartition);
      const staging = assertPromotionTable(window.stagingTable);
      const retired = assertPromotionTable(window.retiredTable);
      const from = partitionBoundLiteral(window.startIso);
      const to = partitionBoundLiteral(window.endIso);
      const bounds = `${staging}_bounds`;

      // Outside the transaction on purpose — see the module comment. The scan this ADD
      // performs is the price of not scanning under ACCESS EXCLUSIVE later.
      await db.query(
        `ALTER TABLE ${staging} ADD CONSTRAINT ${bounds} ` +
          `CHECK (acq_ts >= ${from} AND acq_ts < ${to})`,
      );

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE detections DETACH PARTITION ${live}`);
        await client.query(`ALTER TABLE ${live} RENAME TO ${retired}`);
        await client.query(`ALTER TABLE ${staging} RENAME TO ${live}`);
        await client.query(
          `ALTER TABLE detections ATTACH PARTITION ${live} FOR VALUES FROM (${from}) TO (${to})`,
        );
        // Redundant once the partition bound owns the same predicate.
        await client.query(`ALTER TABLE ${live} DROP CONSTRAINT ${bounds}`);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      return { retiredTable: retired, attachedPartition: live };
    },
  };
}

function singleRow(result: PromotionQueryResult, what: string): Record<string, unknown> {
  const row = result.rows[0];
  if (row === undefined) {
    throw new RangeError(`expected one row of ${what}, got none`);
  }
  return row;
}

/** Postgres returns bigint as text; anything that is not a safe integer is a bug. */
function toCount(value: unknown): number {
  const parsed =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`expected an integer count, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function toSourceDay(row: Record<string, unknown>): SourceDay {
  return { source: String(row['source']), day: String(row['day']) };
}
