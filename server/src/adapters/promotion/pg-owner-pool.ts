/**
 * The promotion CLI's pool — the one place that deliberately does NOT assume the
 * append-only runtime role (TASKS C7).
 *
 * D7 promotion is a schema-owner operation by design: creating the staging table and
 * `DETACH`/`ATTACH PARTITION` are DDL that `fire_watch_app` must never hold — its grant
 * is SELECT+INSERT and nothing else (migration 001). So unlike `createPgPool`, no
 * `SET role` happens here: the login in DATABASE_URL (the same login dbmate migrates
 * as) is used directly. Point this CLI at the runtime role by mistake and the first DDL
 * statement fails loudly with `permission denied`, which is exactly the fail-closed
 * behaviour the amendment wants.
 *
 * No statement timeout, unlike the runtime pool's 30s: `ATTACH PARTITION` validates the
 * cloned FK with a full scan of the staged month, and an operator-driven promotion that
 * dies at 30s on a large fire-season month buys no safety — the swap is a single
 * transaction either way. The idle-in-transaction timeout stays, so a wedged client
 * cannot hold the ACCESS EXCLUSIVE lock on `detections` forever.
 */

import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 10_000;

export interface OwnerPoolOptions {
  readonly databaseUrl: string;
  readonly applicationName: string;
}

export function createOwnerPool(options: OwnerPoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.databaseUrl,
    application_name: options.applicationName,
    // One connection: the promotion is strictly sequential, and a second connection
    // could only ever wait behind the first one's locks.
    max: 1,
    statement_timeout: 0,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  };
  const pool = new Pool(config);
  pool.on('error', () => {
    // Same convention as createPgPool: a backend dropping an idle connection is not an
    // event; the next acquisition surfaces the real state.
  });
  return pool;
}
