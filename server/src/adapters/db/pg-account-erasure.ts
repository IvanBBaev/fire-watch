/**
 * Account erasure over Postgres (TASKS I4; ADR-004 D8, A1.3, A1.9; migration 010): the
 * store `core/erasure/erase-account.ts` is written against, and the one-transaction
 * wrapper the route calls.
 *
 * **One transaction, run as the runtime role.** Every statement below is inside a single
 * `BEGIN … COMMIT`, so an erasure that fails half-way leaves nothing half-erased. The
 * runtime role already holds DELETE on each personal table the erasure empties (001, 007);
 * the shadow log goes by the cascade from `watch_zones`, which runs as the table owner, so
 * `alerts_shadow` stays insert-only for the application.
 *
 * **The outbox and the dispatcher.** The outbox statement takes its row locks with a
 * locking read before it rewrites, so the status each row is counted under is the status
 * the rewrite saw — a claim that committed while this statement waited is counted as
 * cancelled from `claimed`. A claim that comes after skips the locked rows (`SKIP LOCKED`)
 * and, once this commits, finds them `cancelled_erasure`. A dispatcher that claimed before
 * finds its settle refused. The integration test drives each of those orderings.
 *
 * The ledger key is computed in SQL (`sha256`), so the account id never has to be hashed
 * in the core and the ledger row never carries the id itself.
 */

import type { EpochMs } from '../../core/ports/clock.js';
import type {
  AccountErasureStore,
  ErasureRecord,
  LockedAccount,
} from '../../core/ports/account-erasure-store.js';
import {
  eraseAccount,
  type EraseAccountOptions,
  type ErasureOutcome,
} from '../../core/erasure/erase-account.js';
import { ERASURE_CANCELLABLE_STATUSES } from '../../core/erasure/erasure-plan.js';
import { field, number } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgErasureQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgErasureClient extends PgErasureQueryable {
  release(): void;
}

export interface PgErasurePool extends PgErasureQueryable {
  connect(): Promise<PgErasureClient>;
}

const CANCELLABLE = ERASURE_CANCELLABLE_STATUSES.map((status) => `'${status}'`).join(', ');

const LOCK_ACCOUNT = `
SELECT deleted_at IS NOT NULL AS erased, email
FROM accounts
WHERE id = $1::uuid
FOR UPDATE`;

/** Soft-deleted zones included: they still hold the sealed centre and their outbox rows. */
const LOCK_ZONES = `
SELECT id::text AS id
FROM watch_zones
WHERE account_id = $1::uuid
ORDER BY id
FOR UPDATE`;

/**
 * Cancel what has not been sent, then pseudonymize every row of the zones (A1.9, A1.3).
 * `locked` reads each row's status under its row lock, after any writer holding it has
 * committed; `rewritten` is the A1.3 rewrite; the outer select counts both.
 */
const CANCEL_AND_PSEUDONYMIZE_OUTBOX = `
WITH locked AS (
  SELECT id, status
  FROM alert_outbox
  WHERE watch_zone_id = ANY($1::uuid[])
  ORDER BY id
  FOR UPDATE
),
rewritten AS (
  UPDATE alert_outbox AS o
  SET status = CASE WHEN locked.status IN (${CANCELLABLE}) THEN 'cancelled_erasure' ELSE o.status END,
      watch_zone_id = NULL,
      channel_subscription_id = NULL,
      template_params = (
        SELECT COALESCE(jsonb_object_agg(p.key, p.value), '{}'::jsonb)
        FROM jsonb_each(o.template_params) AS p
        WHERE p.key = ANY($3::text[])
      ),
      pseudonymized_at = $2::timestamptz
  FROM locked
  WHERE o.id = locked.id
  RETURNING locked.status AS previous_status
)
SELECT
  count(*) FILTER (WHERE previous_status IN (${CANCELLABLE}))::integer AS cancelled,
  count(*)::integer AS pseudonymized
FROM rewritten`;

const DELETE_ALERT_STATES = `
DELETE FROM alert_states
WHERE watch_zone_id = ANY($1::uuid[])`;

/**
 * The shadow, decision-log and digest-log counts are read from the statement's snapshot;
 * the cascades then remove them. The zones are already locked FOR UPDATE, so no evaluation
 * can add a decision-log row for them between the count and the delete; the account row is
 * locked FOR UPDATE, so no digest pass (which holds it FOR SHARE, migration 018) can add a
 * digest-log row either.
 */
const DELETE_ZONES = `
WITH shadow AS (
  SELECT count(*)::integer AS n FROM alerts_shadow WHERE watch_zone_id = ANY($1::uuid[])
),
decision_log AS (
  SELECT count(*)::integer AS n FROM alert_decision_log WHERE watch_zone_id = ANY($1::uuid[])
),
digest_log AS (
  SELECT count(*)::integer AS n FROM alert_digest_log WHERE watch_zone_id = ANY($1::uuid[])
),
gone AS (
  DELETE FROM watch_zones WHERE id = ANY($1::uuid[]) RETURNING id
)
SELECT (SELECT count(*)::integer FROM gone) AS zones,
       (SELECT n FROM shadow) AS shadow_alerts,
       (SELECT n FROM decision_log) AS decision_log,
       (SELECT n FROM digest_log) AS digest_log`;

/** Every confirmation of the account, pending Telegram links (no subscription) included. */
const DELETE_CHANNEL_CONFIRMATIONS = `
DELETE FROM channel_confirmations
WHERE account_id = $1::uuid`;

const DELETE_SUBSCRIPTIONS = `
DELETE FROM channel_subscriptions
WHERE account_id = $1::uuid`;

const DELETE_SESSIONS = `
DELETE FROM account_sessions
WHERE account_id = $1::uuid`;

const DELETE_LINK_REQUESTS = `
DELETE FROM auth_link_requests
WHERE email = $1::text`;

/** Preferences return to their column defaults, so nothing chosen by the person survives. */
const TOMBSTONE_ACCOUNT = `
UPDATE accounts
SET email = NULL,
    email_verified_at = NULL,
    timezone = DEFAULT,
    quiet_hours_start = DEFAULT,
    quiet_hours_end = DEFAULT,
    new_fire_overrides_quiet_hours = DEFAULT,
    deleted_at = $2::timestamptz
WHERE id = $1::uuid AND deleted_at IS NULL`;

const RECORD_ERASURE = `
INSERT INTO erasure_requests (account_hash, erased_at, deadline_at, plan_version, counts)
VALUES (
  sha256(convert_to($1::text, 'UTF8')),
  $2::timestamptz, $3::timestamptz, $4::text, $5::jsonb
)`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const ACCOUNT_ERASURE_SQL = {
  lockAccount: LOCK_ACCOUNT,
  lockZones: LOCK_ZONES,
  cancelAndPseudonymizeOutbox: CANCEL_AND_PSEUDONYMIZE_OUTBOX,
  deleteAlertStates: DELETE_ALERT_STATES,
  deleteZones: DELETE_ZONES,
  deleteChannelConfirmations: DELETE_CHANNEL_CONFIRMATIONS,
  deleteSubscriptions: DELETE_SUBSCRIPTIONS,
  deleteSessions: DELETE_SESSIONS,
  deleteLinkRequests: DELETE_LINK_REQUESTS,
  tombstoneAccount: TOMBSTONE_ACCOUNT,
  recordErasure: RECORD_ERASURE,
} as const;

/** Binds the store to one client. The caller owns the transaction. */
export function createPgAccountErasureStore(db: PgErasureQueryable): AccountErasureStore {
  return {
    async lockAccount(accountId): Promise<LockedAccount> {
      const result = await db.query(LOCK_ACCOUNT, [accountId]);
      const [row] = result.rows;
      if (row === undefined) return { state: 'missing' };
      if (field(row, 'erased') === true) return { state: 'erased' };
      const email = field(row, 'email');
      if (email !== null && typeof email !== 'string') {
        throw new TypeError('accounts.email is neither text nor NULL');
      }
      return { state: 'live', email };
    },
    async lockZones(accountId) {
      const result = await db.query(LOCK_ZONES, [accountId]);
      return result.rows.map((row) => {
        const id = field(row, 'id');
        if (typeof id !== 'string') throw new TypeError('watch_zones.id is not text');
        return id;
      });
    },
    async cancelAndPseudonymizeOutbox(zoneIds, atIso, retainedParamKeys) {
      const result = await db.query(CANCEL_AND_PSEUDONYMIZE_OUTBOX, [
        [...zoneIds],
        atIso,
        [...retainedParamKeys],
      ]);
      const [row] = result.rows;
      if (row === undefined) throw new Error('outbox erasure returned no count row');
      return {
        cancelled: number(field(row, 'cancelled'), 'cancelled'),
        pseudonymized: number(field(row, 'pseudonymized'), 'pseudonymized'),
      };
    },
    async deleteAlertStates(zoneIds) {
      const result = await db.query(DELETE_ALERT_STATES, [[...zoneIds]]);
      return result.rowCount ?? 0;
    },
    async deleteZones(zoneIds) {
      const result = await db.query(DELETE_ZONES, [[...zoneIds]]);
      const [row] = result.rows;
      if (row === undefined) throw new Error('zone deletion returned no count row');
      const zones = number(field(row, 'zones'), 'zones');
      if (zones !== zoneIds.length) {
        throw new Error(
          `zone deletion removed ${String(zones)} of ${String(zoneIds.length)} locked zones`,
        );
      }
      return {
        zones,
        shadowAlerts: number(field(row, 'shadow_alerts'), 'shadow_alerts'),
        decisionLog: number(field(row, 'decision_log'), 'decision_log'),
        digestLog: number(field(row, 'digest_log'), 'digest_log'),
      };
    },
    async deleteChannelConfirmations(accountId) {
      const result = await db.query(DELETE_CHANNEL_CONFIRMATIONS, [accountId]);
      return result.rowCount ?? 0;
    },
    async deleteSubscriptions(accountId) {
      const result = await db.query(DELETE_SUBSCRIPTIONS, [accountId]);
      return result.rowCount ?? 0;
    },
    async deleteSessions(accountId) {
      const result = await db.query(DELETE_SESSIONS, [accountId]);
      return result.rowCount ?? 0;
    },
    async deleteLinkRequests(email) {
      const result = await db.query(DELETE_LINK_REQUESTS, [email]);
      return result.rowCount ?? 0;
    },
    async tombstoneAccount(accountId, atIso) {
      const result = await db.query(TOMBSTONE_ACCOUNT, [accountId, atIso]);
      if (result.rowCount !== 1) throw new Error('account tombstone did not write exactly one row');
    },
    async record(entry: ErasureRecord) {
      const result = await db.query(RECORD_ERASURE, [
        entry.accountId,
        entry.erasedAtIso,
        entry.deadlineIso,
        entry.planVersion,
        JSON.stringify(entry.counts),
      ]);
      if (result.rowCount !== 1)
        throw new Error('erasure ledger insert did not write exactly one row');
    },
  };
}

/** What the route calls: one erasure, one transaction. */
export type AccountEraser = (accountId: string, at: EpochMs) => Promise<ErasureOutcome>;

export function createPgAccountEraser(
  pool: PgErasurePool,
  options: EraseAccountOptions = {},
): AccountEraser {
  return (accountId, at) =>
    inTransaction(pool, (client) =>
      eraseAccount(accountId, at, createPgAccountErasureStore(client), options),
    );
}

/** Same shape as `pg-auth.ts`: ROLLBACK's own failure never masks the original. */
async function inTransaction<T>(
  pool: PgErasurePool,
  work: (client: PgErasureClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
