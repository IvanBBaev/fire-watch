/**
 * The retention purge over Postgres (TASKS I4): the executor `core/erasure/purge-plan.ts`
 * runs. Each call deletes at most `limit` rows, oldest anchor first, in one autocommit
 * statement — a large backlog drains over several runs instead of holding locks for one
 * long transaction.
 *
 * The ledger is purged only through migration 010's `purge_erasure_ledger`, a SECURITY
 * DEFINER function that refuses a cutoff inside the 30-day horizon; the runtime role has
 * no DELETE on `erasure_requests`. The alert decision log likewise goes only through
 * migration 014's `purge_alert_decision_log`, because the runtime role has no DELETE on it
 * either. The other targets use the role's existing grants.
 *
 * Every target ships unarmed (`PURGE_RETENTION` is all null), so in production nothing
 * here runs until a retention is ratified.
 */

import type { PurgeExecutor, PurgeTarget } from '../../core/erasure/purge-plan.js';
import { field, number } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgPurgeQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const PURGE_ERASURE_LEDGER = `
SELECT purge_erasure_ledger($1::timestamptz, $2::integer) AS purged`;

const PURGE_ALERT_DECISION_LOG = `
SELECT purge_alert_decision_log($1::timestamptz, $2::integer) AS purged`;

/** Targets purged through a SECURITY DEFINER function that answers with a `purged` count. */
const FUNCTION_TARGETS: ReadonlySet<PurgeTarget> = new Set([
  'erasure_ledger',
  'alert_decision_log',
]);

const PURGE_EXPIRED_LINK_REQUESTS = `
DELETE FROM auth_link_requests
WHERE id IN (
  SELECT id FROM auth_link_requests
  WHERE expires_at < $1::timestamptz
  ORDER BY expires_at
  LIMIT $2::integer
)`;

const PURGE_ENDED_SESSIONS = `
DELETE FROM account_sessions
WHERE id IN (
  SELECT id FROM account_sessions
  WHERE COALESCE(revoked_at, expires_at) < $1::timestamptz
  ORDER BY COALESCE(revoked_at, expires_at)
  LIMIT $2::integer
)`;

/**
 * Only scrubbed tombstones with nothing left under them: an account soft-deleted by any
 * other path than erasure keeps its row, because its cascade would reach data nobody
 * decided to remove.
 */
const PURGE_ACCOUNT_TOMBSTONES = `
DELETE FROM accounts
WHERE id IN (
  SELECT a.id FROM accounts AS a
  WHERE a.deleted_at < $1::timestamptz
    AND a.email IS NULL
    AND NOT EXISTS (SELECT 1 FROM watch_zones AS z WHERE z.account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM channel_subscriptions AS c WHERE c.account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM channel_confirmations AS k WHERE k.account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM account_sessions AS s WHERE s.account_id = a.id)
  ORDER BY a.deleted_at
  LIMIT $2::integer
)`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const ERASURE_PURGE_SQL: Readonly<Record<PurgeTarget, string>> = {
  erasure_ledger: PURGE_ERASURE_LEDGER,
  expired_link_requests: PURGE_EXPIRED_LINK_REQUESTS,
  ended_sessions: PURGE_ENDED_SESSIONS,
  account_tombstones: PURGE_ACCOUNT_TOMBSTONES,
  alert_decision_log: PURGE_ALERT_DECISION_LOG,
};

export function createPgErasurePurge(db: PgPurgeQueryable): PurgeExecutor {
  return {
    async purge(target, cutoffIso, limit) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError(`purge limit must be a positive integer, got ${String(limit)}`);
      }
      const result = await db.query(ERASURE_PURGE_SQL[target], [cutoffIso, limit]);
      if (FUNCTION_TARGETS.has(target)) {
        const [row] = result.rows;
        if (row === undefined) throw new Error(`purge of ${target} returned no row`);
        return number(field(row, 'purged'), 'purged');
      }
      return result.rowCount ?? 0;
    },
  };
}
