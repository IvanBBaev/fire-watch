/**
 * The deploy's migration guard (review 27 E-5; OPERATIONS §9.3 rule 3): at most one
 * `dbmate up` runs against the database at a time, however many deploys race.
 *
 * dbmate takes no lock of its own on Postgres. Two deploys that overlap — a re-run of the
 * workflow while the first is still migrating, an operator running the one-shot by hand —
 * would both read the same `schema_migrations` and both apply the next file. The second
 * would fail half-way through a migration the first already committed, or worse, succeed on
 * one that is not idempotent.
 *
 * **Session-scoped and blocking**, unlike the worker's loop locks (pg-loop-lock.ts): a
 * second deploy should wait for the first and then find nothing left to apply, not skip
 * and start the new code against a schema it has not seen. The wait is bounded by
 * `lock_timeout`, which Postgres applies to advisory-lock waits too, so a migration that
 * hangs fails the next deploy instead of stalling it for ever.
 *
 * The lock lives on a connection of its own and is held, idle, while dbmate runs on its
 * own connections. It is released with `pg_advisory_unlock` and the connection is then
 * closed regardless — Postgres drops every session lock with the session, so a failed
 * unlock cannot leave the lock behind.
 */

/** Sign-in's class is 7007, the opt-in's 7012, worker loops' 7020, webhooks 7035, meta-alerts 7036. */
export const MIGRATION_LOCK_CLASS = 7040;

/** The default wait for a concurrent migration to finish. */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 300_000;

export const MIGRATION_LOCK_SQL = {
  lockTimeout: (ms: number) => `SET lock_timeout = ${String(Math.trunc(ms))}`,
  lock: `SELECT pg_advisory_lock(${String(MIGRATION_LOCK_CLASS)}, 0)`,
  unlock: `SELECT pg_advisory_unlock(${String(MIGRATION_LOCK_CLASS)}, 0) AS released`,
} as const;

/** The slice of a `pg.Client` this module uses. */
export interface PgMigrationLockClient {
  connect(): Promise<unknown>;
  query<Row extends Record<string, unknown>>(text: string): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Runs `body` while holding the migration lock on `client`, which this function connects
 * and always ends. Throws if the lock cannot be taken within `timeoutMs`.
 */
export async function withMigrationLock<T>(
  client: PgMigrationLockClient,
  body: () => Promise<T>,
  timeoutMs: number = DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new RangeError(
      `migration lock timeout must be a positive number, got ${String(timeoutMs)}`,
    );
  }
  // A lost connection releases the lock server-side; the error must not end the process
  // before the body's own outcome is known.
  client.on('error', () => {});
  await client.connect();
  try {
    await client.query(MIGRATION_LOCK_SQL.lockTimeout(timeoutMs));
    await client.query(MIGRATION_LOCK_SQL.lock);
    try {
      return await body();
    } finally {
      try {
        await client.query(MIGRATION_LOCK_SQL.unlock);
      } catch {
        // Ending the session below releases the lock either way; the unlock's own failure
        // must not mask the body's result.
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}
