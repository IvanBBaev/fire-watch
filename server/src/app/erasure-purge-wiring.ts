/**
 * Wiring and per-run report for the retention purge loop (TASKS I4).
 *
 * Kept out of `worker.ts` for the same reason as `lag-histogram-wiring.ts`: the worker's
 * hookup stays a handful of lines, and what one run prints sits where a test can reach it.
 * Nothing here connects: `createPgPool` opens a socket only when a query asks for one.
 *
 * **Every target is unarmed** (`PURGE_RETENTION` is all null), so a run deletes nothing
 * and its line says `armed: false` for each target. The loop is wired anyway, so arming a
 * retention is a one-line change to the core rather than a change to the worker, and the
 * daily line is visible evidence that nothing is being purged.
 *
 * The cadence is daily, the lifecycle-sweep cadence OPERATIONS §6.2 assumes. A run deletes
 * at most `PURGE_ROW_LIMIT` rows per target; `more: true` in its line means a backlog the
 * next run continues.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgErasurePurge } from '../adapters/db/pg-erasure-purge.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import {
  PURGE_RETENTION,
  PURGE_ROW_LIMIT,
  runPurge,
  type PurgeExecutor,
  type PurgeReport,
  type PurgeRetention,
} from '../core/erasure/purge-plan.js';
import type { Clock } from '../core/ports/clock.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { ServerConfig } from './config.js';

export const ERASURE_PURGE_INTERVAL_MS = 86_400_000;

export interface ErasurePurgeDeps {
  readonly executor: PurgeExecutor;
  readonly clock: Clock;
  readonly retention: PurgeRetention;
  readonly limit: number;
}

export interface ErasurePurgeWiring {
  readonly deps: ErasurePurgeDeps;
  /** Releases the pool. Always called from a `finally`. */
  close(): Promise<void>;
}

export function wireErasurePurge(config: ServerConfig): ErasurePurgeWiring {
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
  });
  return {
    deps: {
      executor: createPgErasurePurge(pool),
      clock: systemClock,
      retention: PURGE_RETENTION,
      limit: PURGE_ROW_LIMIT,
    },
    close: () => pool.end(),
  };
}

/** One run: the plan for now, executed target by target. */
export function runErasurePurge(deps: ErasurePurgeDeps): Promise<PurgeReport> {
  return runPurge(deps.clock.now(), deps.executor, deps.retention, deps.limit);
}

export interface ErasurePurgeReporterDeps {
  /** One canonical-JSON line per run, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

/** No heartbeat leg: a failed purge is late housekeeping, not a feed the public page answers for. */
export function reportErasurePurge(run: JobRun<PurgeReport>, deps: ErasurePurgeReporterDeps): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        erasure_purge_failed: {
          error: run.error instanceof Error ? run.error.message : String(run.error),
          at: run.finishedAt,
        },
      }),
    );
    return;
  }
  deps.writeLine(canonicalJson({ erasure_purge: run.value }));
}
