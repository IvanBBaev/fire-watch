/**
 * The worker's per-loop singleton guard over Postgres advisory locks (ADR-002; OPERATIONS
 * §9.3; `core/ports/loop-lock.ts`).
 *
 * **Session-scoped, not transaction-scoped.** pg-auth.ts and pg-channel-opt-in.ts take
 * `pg_advisory_xact_lock`, because what they guard is one transaction. A loop cycle is not:
 * ingest commits per source, the dispatcher settles row by row, and each loop's queries run
 * on that loop's own pool. So the lock is taken with `pg_try_advisory_lock` on a client of
 * its own, held — idle, outside any transaction, so `idle_in_transaction_session_timeout`
 * never fires on it — for the length of the cycle, and released with `pg_advisory_unlock`.
 *
 * **`try`, never wait.** A cycle that waited for the lock would run straight after the
 * holder's, doubling the work the holder just did; a standby that skips and tries again a
 * cycle later takes over within one interval of the holder going away.
 *
 * **A lock never outlives a doubt.** If the unlock fails or does not report the lock as
 * released, the client is destroyed rather than returned to the pool: Postgres drops every
 * session lock with the session, and a pooled connection still holding one would make this
 * process skip its own loop for good. The same holds the other way: if the lock's
 * connection is lost mid-cycle, the server has already released it, and a standby may
 * start the next cycle while this one finishes. That window is one cycle wide and is what
 * the idempotent writes, the outbox's `FOR UPDATE SKIP LOCKED` claim and its claim lease
 * are there for; the lock narrows overlap to it rather than ruling it out.
 *
 * The two-key form under {@link WORKER_LOOP_LOCK_CLASS} keeps this space apart from
 * sign-in's (7007), the opt-in's (7012) and the clustering store's single-key lock; the
 * second key is a fixed number per loop, so two loops cannot collide the way two hashed
 * strings could.
 */

import type { LockedLoop, LoopLock, LoopLocks, Exclusive } from '../../core/ports/loop-lock.js';
import { LOCKED_LOOPS } from '../../core/ports/loop-lock.js';
import { boolean, field } from './pg-rows.js';

/** The advisory-lock class for worker loops; sign-in's is 7007, the opt-in's 7012. */
export const WORKER_LOOP_LOCK_CLASS = 7020;

/** The second key per loop. Append only: renumbering one lets an old and a new worker overlap. */
export const LOOP_LOCK_KEYS: Readonly<Record<LockedLoop, number>> = {
  ingest: 1,
  alert_evaluation: 2,
  dispatch: 3,
};

const TRY_LOCK = `SELECT pg_try_advisory_lock(${String(WORKER_LOOP_LOCK_CLASS)}, $1::int) AS acquired`;
const UNLOCK = `SELECT pg_advisory_unlock(${String(WORKER_LOOP_LOCK_CLASS)}, $1::int) AS released`;

/** Exported for the shape test. */
export const LOOP_LOCK_SQL = { tryLock: TRY_LOCK, unlock: UNLOCK } as const;

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgLoopLockClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
  /** `pg`'s release: a truthy argument destroys the connection instead of pooling it. */
  release(destroy?: boolean): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

export interface PgLoopLockPool {
  connect(): Promise<PgLoopLockClient>;
  end(): Promise<void>;
}

export function createPgLoopLocks(pool: PgLoopLockPool): LoopLocks {
  let closed: Promise<void> | null = null;
  return {
    forLoop: (loop) => createPgLoopLock(pool, loop),
    close: () => (closed ??= pool.end()),
  };
}

export function createPgLoopLock(pool: PgLoopLockPool, loop: LockedLoop): LoopLock {
  if (!LOCKED_LOOPS.includes(loop)) throw new RangeError(`not a locked loop: ${String(loop)}`);
  const key = LOOP_LOCK_KEYS[loop];
  return {
    async runExclusive<T>(body: () => Promise<T>): Promise<Exclusive<T>> {
      const client = await pool.connect();
      // A checked-out client whose connection drops emits 'error', and the pool's own
      // listener only covers idle clients: unheard, it would end the worker. The lock is
      // checked out for a whole cycle, so losing its connection mid-cycle is not rare
      // enough to crash on — the server has released the lock, and the client goes.
      let lost = false;
      const onError = (): void => {
        lost = true;
      };
      client.on('error', onError);
      const release = (destroy: boolean): void => {
        client.removeListener('error', onError);
        client.release(destroy || lost);
      };

      let acquired: boolean;
      try {
        const { rows } = await client.query(TRY_LOCK, [key]);
        acquired = boolean(field(rows[0], 'acquired'), 'acquired');
      } catch (error) {
        // Whether the server took the lock before the error is unknowable from here.
        release(true);
        throw error;
      }
      if (!acquired) {
        release(false);
        return { acquired: false };
      }

      let released = false;
      try {
        const value = await body();
        return { acquired: true, value };
      } finally {
        try {
          const { rows } = await client.query(UNLOCK, [key]);
          released = boolean(field(rows[0], 'released'), 'released');
        } catch {
          // Destroyed below; the unlock's own failure must not mask the body's result.
        }
        release(!released);
      }
    },
  };
}
