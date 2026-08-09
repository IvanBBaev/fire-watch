/**
 * The connection pool — where the append-only grant stops being a convention.
 *
 * `fire_watch_app` is NOLOGIN and holds `SELECT, INSERT` on `detections` and nothing more
 * (migration 001). This module makes every connection assume it, as a *startup option*
 * rather than a `SET ROLE` issued after the fact: a startup option cannot lose a race with
 * the first query, and a login user that is not a member of the role fails to connect at
 * all — which is the loud failure we want, not a process that quietly runs with the
 * privileges to rewrite history.
 *
 * Nothing here retries. `pg` reconnects on its own, and a pool that hides an unreachable
 * database behind retries is a pool that turns an outage into a mystery.
 */

import { Pool, type PoolConfig } from 'pg';

/** Long enough for a monthly partition scan, short enough that nothing can wedge a cycle. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/** A transaction left open holds back autovacuum on an append-only table. */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export interface PgPoolOptions {
  readonly databaseUrl: string;
  /** Assumed on every connection; see the module comment. A bare identifier. */
  readonly role: string;
  /** Shown in `pg_stat_activity`, so a stuck query names the process that issued it. */
  readonly applicationName: string;
  /** One is right for the ingest cycle, which polls its sources sequentially. */
  readonly max?: number;
  readonly statementTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
}

export function createPgPool(options: PgPoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.databaseUrl,
    application_name: options.applicationName,
    options: startupOptions(options.role),
    max: options.max ?? 1,
    statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout:
      options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
  };

  const pool = new Pool(config);

  // An idle client can be dropped by the network long after the query that used it
  // finished. Without a listener that arrives as an unhandled 'error' event, which ends
  // the process — a cycle that succeeded would be reported as a crash.
  pool.on('error', () => {
    // Deliberately silent: the next acquisition surfaces the real state, and the poll
    // that follows records it. Logging belongs to the caller, which has the logger.
  });

  return pool;
}

/**
 * `-c role=…` in the libpq startup packet. The value is checked rather than escaped:
 * `options` is a space-separated list, so a role containing a space would not be a broken
 * identifier but a second setting.
 */
export function startupOptions(role: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new RangeError(`database role must be a lowercase unquoted identifier, got ${role}`);
  }
  return `-c role=${role}`;
}
