/**
 * Zone deletion in one Postgres transaction (ADR-004 A1.9: "In the same transaction as
 * account/zone deletion, every non-terminal outbox row for the affected zones (`pending`,
 * `awaiting_approval`, claimed-but-unsent) is set to `status = 'cancelled_erasure'`").
 *
 * Until now a zone delete was a bare soft-delete `UPDATE`, and only the dispatcher's
 * liveness re-check stood between a deleted zone and its queued alerts. That re-check is
 * A1.9's *belt and braces*, not the rule — and it never sees an `awaiting_approval` row,
 * which is not claimed until someone approves it.
 *
 * ## The transaction
 *
 *   1. `SELECT … FROM accounts … FOR NO KEY UPDATE`: the account is live, and no digest
 *      pass (which holds the row `FOR SHARE` for its whole transaction, migration 018) is
 *      half-way through writing a digest for this zone. A pass that starts after this
 *      commits lists the account's live zones and no longer sees this one. Erasure takes
 *      the same row `FOR UPDATE`, so the two serialize too.
 *   2. The soft-delete itself, scoped by account (another account's zone id deletes
 *      nothing and is indistinguishable from an absent one). No row → rollback, `false`.
 *   3. Every cancellable row of the zone is locked with a locking read — so the status it
 *      is counted under is the one the rewrite saw — and closed `cancelled_erasure`.
 *
 * A dispatcher that claimed a row before step 3 finds its settle refused (every settle is
 * conditional on `status = 'claimed'`), exactly as for an erasure. A row the evaluation
 * loop inserts after this commits — it matched the zone before the delete — is `pending`,
 * and the dispatcher's liveness re-check (`pg-recipient-resolver.ts`, `zone_deleted_at`)
 * closes it before any provider call.
 *
 * **Cancelled, not pseudonymized.** A soft-deleted zone keeps its row until the account is
 * erased, and erasure (`pg-account-erasure.ts`) pseudonymizes the outbox rows of every
 * zone the account ever had, soft-deleted ones included. Rewriting the rows here as well
 * would be a second, partial implementation of A1.3's rewrite.
 */

import { ERASURE_CANCELLABLE_STATUSES } from '../../core/erasure/erasure-plan.js';
import { field, number } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgZoneDeletionQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgZoneDeletionClient extends PgZoneDeletionQueryable {
  release(): void;
}

export interface PgZoneDeletionPool {
  connect(): Promise<PgZoneDeletionClient>;
}

const CANCELLABLE = ERASURE_CANCELLABLE_STATUSES.map((status) => `'${status}'`).join(', ');

const LOCK_ACCOUNT = `
SELECT 1 AS live
FROM accounts
WHERE id = $1::uuid AND deleted_at IS NULL
FOR NO KEY UPDATE`.trim();

const SOFT_DELETE_ZONE = `
UPDATE watch_zones
SET deleted_at = $3::timestamptz
WHERE id = $2::uuid AND account_id = $1::uuid AND deleted_at IS NULL`.trim();

/** Locks, then closes; the outer select counts what was closed. */
const CANCEL_ZONE_OUTBOX = `
WITH locked AS (
  SELECT id
  FROM alert_outbox
  WHERE watch_zone_id = $1::uuid AND status IN (${CANCELLABLE})
  ORDER BY id
  FOR UPDATE
),
cancelled AS (
  UPDATE alert_outbox AS o
  SET status = 'cancelled_erasure'
  FROM locked
  WHERE o.id = locked.id AND o.status IN (${CANCELLABLE})
  RETURNING o.id
)
SELECT count(*)::integer AS cancelled FROM cancelled`.trim();

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const ZONE_DELETION_SQL = Object.freeze({
  lockAccount: LOCK_ACCOUNT,
  softDeleteZone: SOFT_DELETE_ZONE,
  cancelZoneOutbox: CANCEL_ZONE_OUTBOX,
});

export interface ZoneDeletion {
  /** `false` when the account owns no live zone by that id (or is itself gone). */
  readonly deleted: boolean;
  /** Outbox rows closed `cancelled_erasure` by this deletion. 0 when not deleted. */
  readonly cancelled: number;
}

export type ZoneDeleter = (
  accountId: string,
  zoneId: string,
  atIso: string,
) => Promise<ZoneDeletion>;

export function createPgZoneDeleter(pool: PgZoneDeletionPool): ZoneDeleter {
  return async (accountId, zoneId, atIso) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(LOCK_ACCOUNT, [accountId]);
      const deleted =
        account.rows.length > 0 &&
        ((await client.query(SOFT_DELETE_ZONE, [accountId, zoneId, atIso])).rowCount ?? 0) > 0;
      if (!deleted) {
        await client.query('ROLLBACK');
        return { deleted: false, cancelled: 0 };
      }
      const result = await client.query(CANCEL_ZONE_OUTBOX, [zoneId]);
      const [row] = result.rows;
      if (row === undefined) throw new Error('outbox cancellation returned no row');
      const cancelled = number(field(row, 'cancelled'), 'cancelled');
      await client.query('COMMIT');
      return { deleted: true, cancelled };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}
