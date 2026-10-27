/**
 * The worker's loop locks and what a skipped cycle leaves behind (`core/ports/loop-lock.ts`).
 *
 * The locks get a pool of their own, one connection per locked loop: each lock is held on
 * a connection for the whole cycle, and the loops' own pools are sized for their own
 * queries (ingest's is one connection) — a lock borrowed from one of them would starve the
 * cycle it guards. Named in `pg_stat_activity`, so the holder of a lock is findable with
 * `SELECT application_name FROM pg_locks JOIN pg_stat_activity USING (pid)
 *  WHERE locktype = 'advisory'`.
 *
 * A skip is logged when a streak of them starts and then once every
 * {@link SKIP_LOG_EVERY} skips, not every time: a standby dispatcher skips every 10 s, and
 * a line per skip would bury the holder's lines in its own. `fw_loop_skipped_total` counts
 * every one.
 */

import { createPgLoopLocks } from '../adapters/db/pg-loop-lock.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { LOCKED_LOOPS, type LockedLoop, type LoopLocks } from '../core/ports/loop-lock.js';
import type { JobRun, JobSkip } from '../core/scheduler/repeating-job.js';
import type { ServerConfig } from './config.js';

/** One standby line per this many consecutive skips, after the first. */
export const SKIP_LOG_EVERY = 60;

export function wireLoopLocks(config: ServerConfig): LoopLocks {
  return createPgLoopLocks(
    createPgPool({
      databaseUrl: config.databaseUrl,
      role: config.databaseRole,
      applicationName: `${config.applicationName}-loop-locks`,
      max: LOCKED_LOOPS.length,
    }),
  );
}

export interface SkipLog {
  /** The loop's `skipped` callback. */
  readonly skipped: (skip: JobSkip) => void;
  /** Wraps the loop's reporter, so a run ends the streak. */
  readonly ran: <T>(
    report: (run: JobRun<T>) => void | Promise<void>,
  ) => (run: JobRun<T>) => void | Promise<void>;
}

export function skipLog(
  loop: LockedLoop,
  note: (record: Record<string, unknown>) => void,
): SkipLog {
  let streak = 0;
  return {
    skipped: (skip) => {
      streak += 1;
      if (streak === 1 || streak % SKIP_LOG_EVERY === 0) {
        note({ loop_skipped: { loop, reason: skip.reason, consecutive: streak } });
      }
    },
    ran: (report) => (run) => {
      if (streak > 0) note({ loop_lock_acquired: { loop, after_skips: streak } });
      streak = 0;
      return report(run);
    },
  };
}
